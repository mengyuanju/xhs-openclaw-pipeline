import { createHash } from 'node:crypto';
import { rm, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, join } from 'node:path';
import { ControlPlaneAuthorizationError, ControlPlaneConflictError, ControlPlaneNotFoundError, normalizeTaskId, normalizeUuid } from './domain.mjs';
import { withdrawReadyDeliveryEntries } from './final-delivery.mjs';
import { releaseEscalatedCopyFreezes } from './copy-quality-control.mjs';
import { releaseEscalatedImageFreezes } from './image-quality-control.mjs';

const configs = Object.freeze({ COPY: { prefix: 'copy', owner: 'final_approver_account_id', username: 'final_approver_username', state: 'COPY_QC_PENDING' },
  IMAGE: { prefix: 'image', owner: 'submitter_account_id', username: 'submitter_username', state: 'IMAGE_QC_PENDING' } });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = (code, message) => { throw new ControlPlaneConflictError(code, message); };
const iso = value => value instanceof Date ? value.toISOString() : value;
function noteOf(value) {
  if (typeof value !== 'string' || !value.trim() || [...value].length > 1000) throw new TypeError('请填写 1–1000 字的处理原因');
  return value.trim();
}
async function transaction(pool, action) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await c.query("SELECT set_config('app.secondary_assignment','on',true)"); const result = await action(c); await c.query('COMMIT'); return result; }
  catch (error) { await c.query('ROLLBACK'); if (['40P01','55P03'].includes(error.code)) conflict('REASSIGNMENT_BUSY','任务正在被其他人处理，请刷新后重试'); throw error; }
  finally { c.release(); }
}
async function lockActor(c, actor, stage = null) {
  if (!actor || !Number.isSafeInteger(actor.userId) || !actor.username || !Number.isSafeInteger(actor.credentialVersion) || actor.credentialVersion<1) throw new ControlPlaneAuthorizationError('请重新登录');
  const account = (await c.query(`SELECT * FROM app_users WHERE id=$1 AND username=$2 AND role=$3 AND status='ACTIVE'
    AND ($4::integer IS NULL OR credential_version=$4) FOR SHARE`,[actor.userId,actor.username,actor.role,actor.credentialVersion ?? null])).rows[0];
  if (!account || (stage ? actor.role !== 'ADMIN' && !(stage === 'COPY' ? account.copy_qc_enabled : account.role === 'REVIEWER' && account.image_qc_enabled) : actor.role !== 'ADMIN')) {
    throw new ControlPlaneAuthorizationError(stage ? '当前账号不能处理此质检项' : '仅管理员可处理待二次分配数据');
  }
  return account;
}
async function requestReplay(c, actor, input, operation, fingerprint) {
  const requestId = normalizeUuid(input?.requestId,'requestId');
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',[`secondary:${actor.userId}`,requestId]);
  const previous=(await c.query('SELECT * FROM task_reassignment_requests WHERE actor_account_id=$1 AND request_id=$2',[actor.userId,requestId])).rows[0];
  if(previous && (previous.operation!==operation || previous.fingerprint!==fingerprint)) conflict('REQUEST_ID_REUSED','同一请求编号不能用于不同操作');
  return {requestId,response:previous?.response};
}
async function saveResponse(c,actor,requestId,operation,fingerprint,response) {
  await c.query(`INSERT INTO task_reassignment_requests(actor_account_id,request_id,operation,fingerprint,response)
    VALUES($1,$2,$3,$4,$5)`,[actor.userId,requestId,operation,fingerprint,response]);
  return response;
}
function caseFrom(row) {
  return {id:Number(row.id),taskId:Number(row.task_id),stage:row.stage,status:row.status,version:row.version,
    resetStatus:row.reset_status,cleanupStatus:row.cleanup_status,resetError:row.reset_error,
    note:row.note,reasonCodes:row.reason_codes,operatorAccountId:Number(row.operator_account_id),
    operatorName:row.operator_name ?? null,reviewerAccountId:Number(row.reviewer_account_id),
    createdAt:iso(row.created_at),disposedAt:iso(row.disposed_at),query:row.query,
    baselineSource:row.baseline_source ?? null,targetAccountId:row.target_account_id == null ? null : Number(row.target_account_id),
    canAssign:row.status==='PENDING' && row.reset_status==='READY' && row.cleanup_status==='COMPLETE'};
}
async function lockCase(c,id,input,{allowCompletedRegeneration=false}={}) {
  const located=(await c.query('SELECT task_id FROM task_reassignment_cases WHERE id=$1',[normalizeTaskId(id)])).rows[0];
  if(!located)throw new ControlPlaneNotFoundError('处置单不存在');
  const task=(await c.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[located.task_id])).rows[0];
  if(!task)throw new ControlPlaneNotFoundError('原任务不存在');
  const record=(await c.query('SELECT * FROM task_reassignment_cases WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!Number.isInteger(input?.expectedVersion) || record.version!==input.expectedVersion)conflict('REASSIGNMENT_CHANGED','处置单已变化，请刷新后重试');
  let canReset=task.state==='PENDING_SECOND_ASSIGNMENT' || task.state==='COPY_FAILED' && record.reset_status==='BLOCKED';
  if(!canReset && allowCompletedRegeneration && record.status==='PENDING'
    && ['PENDING','BLOCKED'].includes(record.reset_status) && task.state==='COPY_RUNNING'
    && task.mandatory_copy_qc_origin==='SECOND_ASSIGNMENT' && task.assigned_to_user_id==null
    && task.current_execution_id) {
    // Older regeneration completion could leave COPY_RUNNING after the execution succeeded
    // when the initial baseline was not captured. Only RESET may recover that stopped run.
    canReset=(await c.query(`SELECT 1 FROM task_executions WHERE id=$1 AND task_id=$2
      AND kind='COPY' AND status='SUCCEEDED' AND finished_at IS NOT NULL`,
    [task.current_execution_id,task.id])).rowCount>0;
  }
  if(record.status!=='PENDING' || !canReset)conflict('REASSIGNMENT_CLOSED','任务不在待二次分配状态');
  return {task,record};
}

async function resetContent(c, task, record, storageRoot) {
  if(record.reset_status==='READY')return;
  const baseline=(await c.query('SELECT * FROM task_initial_baselines WHERE task_id=$1',[task.id])).rows[0];
  if(!baseline) {
    await c.query(`UPDATE task_reassignment_cases SET reset_status='BLOCKED',reset_error='缺少可信机器初稿；请重新生成初始数据后重试' WHERE id=$1`,[record.id]);
    return;
  }
  const shared=(await c.query(`SELECT 1 FROM assets a WHERE a.task_id=$1 AND NOT(a.id=ANY($2::bigint[])) AND (
    EXISTS(SELECT 1 FROM image_run_asset_members m JOIN image_runs r ON r.id=m.image_run_id WHERE m.asset_id=a.id AND r.task_id<>$1)
    OR EXISTS(SELECT 1 FROM image_edit_reference_assets ref JOIN image_edit_requests edit ON edit.id=ref.request_id WHERE ref.asset_id=a.id AND edit.task_id<>$1)) LIMIT 1`,[task.id,baseline.asset_ids])).rowCount;
  if(shared) {
    await c.query("UPDATE task_reassignment_cases SET reset_status='BLOCKED',reset_error='旧资产仍被其他任务引用，请处理共享引用后重试还原' WHERE id=$1",[record.id]);return;
  }
  // All historical facts are materialized before clearing any payload. Shell IDs
  // keep QA/approval/batch foreign keys valid; no prior editable content survives.
  await c.query('SELECT capture_operator_facts($1)',[task.id]);
  await c.query(`INSERT INTO task_reassignment_cleanup(case_id,task_id,storage_path)
    SELECT $1,task_id,storage_path FROM assets WHERE task_id=$2 AND NOT(id=ANY($3::bigint[])) AND content_cleared_at IS NULL ON CONFLICT DO NOTHING`,[record.id,task.id,baseline.asset_ids]);
  if(storageRoot) {
    const assets=(await c.query('SELECT id,sha256 FROM assets WHERE task_id=$1 AND NOT(id=ANY($2::bigint[])) AND content_cleared_at IS NULL',[task.id,baseline.asset_ids])).rows;
    for(const asset of assets)await c.query(`INSERT INTO task_reassignment_cleanup(case_id,task_id,storage_path) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      [record.id,task.id,join(storageRoot,'thumbnails',String(task.id),`${asset.id}-${asset.sha256}-thumb-480-v1.webp`)]);
  }
  await withdrawReadyDeliveryEntries(c,Number(task.id),'SECOND_ASSIGNMENT_RESET');
  await c.query(`DELETE FROM image_edit_requests WHERE task_id=$1`,[task.id]);
  await c.query('DELETE FROM image_edit_events WHERE task_id=$1',[task.id]);
  await c.query('DELETE FROM copy_review_drafts WHERE task_id=$1',[task.id]);
  await c.query('DELETE FROM copy_image_plan_regeneration_jobs WHERE task_id=$1',[task.id]);
  await c.query(`INSERT INTO task_reassignment_assessment_records(case_id,assessment_id,task_id,stage,score_x10,rating_context,action,reason_codes,reviewer_username,created_at)
    SELECT $1,id,task_id,stage,score_x10,rating_context,action,reason_codes,reviewer_username,created_at FROM human_quality_assessments WHERE task_id=$2 ON CONFLICT DO NOTHING`,[record.id,task.id]);
  await c.query('DELETE FROM human_quality_review_submissions WHERE task_id=$1',[task.id]);
  await c.query(`DELETE FROM model_call_traces WHERE task_id=$1 AND execution_id IS DISTINCT FROM
    (SELECT execution_id FROM copy_revisions WHERE id=$2)`,[task.id,baseline.source_revision_id]);
  await c.query(`UPDATE task_executions SET status=CASE WHEN status='RUNNING' THEN 'ABANDONED' ELSE status END,
    snapshot='{}',progress_details='{}',error=NULL,progress_message='旧标注数据已清理',content_cleared_at=clock_timestamp()
    WHERE task_id=$1 AND id IS DISTINCT FROM (SELECT execution_id FROM copy_revisions WHERE id=$2)`,[task.id,baseline.source_revision_id]);
  await c.query(`UPDATE assets SET active=false,edit_metadata='{}',content_cleared_at=clock_timestamp()
    WHERE task_id=$1 AND NOT(id=ANY($2::bigint[])) AND content_cleared_at IS NULL`,[task.id,baseline.asset_ids]);
  await c.query(`UPDATE image_runs SET result=NULL,content_cleared_at=clock_timestamp(),
    status=CASE WHEN status='RUNNING' THEN 'ABANDONED' ELSE status END WHERE task_id=$1 AND content_cleared_at IS NULL`,[task.id]);
  await c.query(`UPDATE copy_revisions SET content='{}',content_cleared_at=clock_timestamp()
    WHERE task_id=$1 AND id<>$2 AND content_cleared_at IS NULL`,[task.id,baseline.source_revision_id]);
  const revision=(await c.query(`INSERT INTO copy_revisions(task_id,revision,content,parent_revision_id,revision_origin)
    SELECT $1,COALESCE(max(revision),0)+1,$2,$3,'SECOND_ASSIGNMENT_RESET' FROM copy_revisions WHERE task_id=$1 RETURNING id`,
  [task.id,baseline.content,baseline.source_revision_id])).rows[0];
  await c.query(`UPDATE tasks SET state='PENDING_SECOND_ASSIGNMENT',current_stage='PENDING_SECOND_ASSIGNMENT',
    input=$2,current_copy_revision_id=$3,current_image_run_id=NULL,current_execution_id=NULL,pending_snapshot=NULL,
    copy_qc_released_revision_id=NULL,image_qc_released_approval_event_id=NULL,image_qc_legacy_accepted=false,
    copy_qa_rework_pending=false,mandatory_copy_qc=true,mandatory_copy_qc_origin='SECOND_ASSIGNMENT',mandatory_image_qc=true,mandatory_image_qc_origin='SECOND_ASSIGNMENT',
    skip_copy_review=false,image_rework_source_run_id=NULL,image_reviewed_at=NULL,image_reviewed_by_user_id=NULL,
    image_production_chain_id=NULL,image_production_started_at=NULL,image_production_duration_ms=0,
    execution_started_at=NULL,finished_at=NULL,error=NULL,progress_percent=0,progress_message='初始数据已还原，待管理员二次分配',
    work_generation=work_generation+1,last_activity_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,[task.id,baseline.input,revision.id]);
  await c.query(`UPDATE task_reassignment_cases SET reset_status='READY',reset_error=NULL,baseline_revision_id=$2,
    new_revision_id=$3,cleanup_status=CASE WHEN EXISTS(SELECT 1 FROM task_reassignment_cleanup WHERE case_id=$1 AND cleaned_at IS NULL)
      THEN 'PENDING' ELSE 'COMPLETE' END WHERE id=$1`,[record.id,baseline.source_revision_id,revision.id]);
}

export async function escalateQualityToAdmin(pool,stage,identifier,input,actor,{storageRoot}={}) {
  if(stage==='IMAGE')conflict('IMAGE_RECHECK_RETURN_REQUIRED','图片强制复检请继续打回返修');
  const config=configs[stage]; if(!config)throw new TypeError('invalid quality stage');
  const publicId=normalizeUuid(identifier,'samplingItemId'),note=noteOf(input?.note);
  const reasons=input?.reasonCodes ?? [];
  if(!Array.isArray(reasons) || reasons.length>20 || reasons.some(v=>typeof v!=='string'||v.length>100))throw new TypeError('质检原因无效');
  const fingerprint=hash({stage,publicId,note,reasons,expectedRevisionToken:input.expectedRevisionToken,
    expectedCopyRevisionId:input.expectedCopyRevisionId,imageRunId:input.imageRunId});
  const result=await transaction(pool,async c=>{
    await lockActor(c,actor,stage);
    const replay=await requestReplay(c,actor,input,'ESCALATE',fingerprint); if(replay.response)return replay.response;
    const location=(await c.query(`SELECT task_id FROM ${config.prefix}_sampling_items WHERE public_id=$1`,[publicId])).rows[0];
    if(!location)throw new ControlPlaneNotFoundError('质检项不存在');
    const task=(await c.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[location.task_id])).rows[0];
    const item=(await c.query(`SELECT i.*,f.production_batch_id,f.blind_review_enabled FROM ${config.prefix}_sampling_items i
      JOIN ${config.prefix}_sampling_freezes f ON f.id=i.freeze_id WHERE i.public_id=$1 FOR UPDATE OF i,f`,[publicId])).rows[0];
    if(!task || task.task_kind!=='CONTENT' || task.priority_paused || task.state!==config.state || item.status!=='PENDING'
      || item.sample_kind!=='MANDATORY_RECHECK' || Number(item.copy_revision_id)!==Number(task.current_copy_revision_id)
      || stage==='IMAGE' && item.image_run_id!==task.current_image_run_id)conflict('STALE_QA_ITEM','任务或质检版本已变化，请刷新');
    const approval=stage==='COPY'?(await c.query('SELECT approved_by_account_id,approved_by_username FROM copy_approval_events WHERE id=$1',[item.approval_event_id])).rows[0]:null;
    const submitterId=Number(approval?.approved_by_account_id ?? item[config.owner]);
    const submitterUsername=approval?.approved_by_username ?? item[config.username];
    const simulated=stage==='IMAGE' && (await c.query("SELECT COALESCE(result->'simulation'->>'enabled'='true',false) AS simulated FROM image_runs WHERE id=$1",[item.image_run_id])).rows[0]?.simulated;
    if(actor.role!=='ADMIN' && submitterId===actor.userId)throw new ControlPlaneAuthorizationError('不能质检自己的提交');
    if(stage==='COPY' && input.expectedRevisionToken!==item.content_sha256)conflict('STALE_QA_ITEM','文案版本已变化，请刷新');
    if(stage==='IMAGE' && input.expectedRevisionToken!==item.image_set_sha256)conflict('STALE_QA_ITEM','图片版本已变化，请刷新');
    // A copy recheck retains a legacy final approver; also forbid its actual submitter.
    if(stage==='COPY' && actor.role!=='ADMIN') {
      const approval=(await c.query('SELECT approved_by_account_id FROM copy_approval_events WHERE id=$1',[item.approval_event_id])).rows[0];
      if(Number(approval?.approved_by_account_id)===actor.userId)throw new ControlPlaneAuthorizationError('不能质检自己的提交');
    }
    const record=(await c.query(`INSERT INTO task_reassignment_cases(task_id,stage,source_item_id,source_item_public_id,
      source_freeze_id,operator_account_id,assignment_record_id,reviewer_account_id,reason_codes,note)
      VALUES($1,$2,$3,$4,$5,$6,(SELECT id FROM task_assignment_records WHERE task_id=$1 AND ended_at IS NULL),$7,$8,$9) RETURNING *`,
    [task.id,stage,item.id,item.public_id,item.freeze_id,submitterId,actor.userId,reasons,note])).rows[0];
    for(const [kind,{prefix}] of Object.entries(configs)) {
      await c.query(`INSERT INTO task_reassignment_case_members(case_id,stage,sampling_item_id,freeze_id)
        SELECT $1,$2,id,freeze_id FROM ${prefix}_sampling_items WHERE task_id=$3 ON CONFLICT DO NOTHING`,[record.id,kind,task.id]);
    }
    await c.query(`UPDATE ${config.prefix}_sampling_items SET status='ADMIN_ESCALATED',reviewed_at=clock_timestamp(),
      reviewed_by_account_id=$2,reviewed_by_username=$3,reason_codes=$4,note=$5 WHERE id=$1`,[item.id,actor.userId,actor.username,reasons,note]);
    await c.query(`INSERT INTO ${config.prefix}_sampling_events(freeze_id,sampling_item_id,action,actor_account_id,actor_username,request_id,reason_codes,note,details)
      VALUES($1,$2,'ESCALATE_ADMIN',$3,$4,$5,$6,$7,$8)`,[item.freeze_id,item.id,actor.userId,actor.username,replay.requestId,reasons,note,{caseId:Number(record.id)}]);
    const data={username:submitterUsername,query:task.query,batchId:Number(task.production_batch_id),samplingItemId:Number(item.id),
      sampleKind:item.sample_kind,reviewerId:actor.userId,reasons,caseId:Number(record.id),copyRevisionId:Number(item.copy_revision_id),imageRunId:item.image_run_id ?? null};
    if(submitterId!==actor.userId && !simulated)await c.query(`INSERT INTO account_quality_events(event_key,task_id,stage,account_id,action,establishes_sample,occurred_at,data)
      VALUES($1,$2,$3,$4,'RETURN',true,clock_timestamp(),$5)`,[`escalation:${record.id}`,task.id,stage,submitterId,data]);
    await c.query(`INSERT INTO quality_review_activity_events(event_key,account_id,task_id,stage,kind,occurred_at,data)
      VALUES($1,$2,$3,$4,'QA_ESCALATE',clock_timestamp(),$5)`,[`escalation:${record.id}`,actor.userId,task.id,stage,
      {...data,username:actor.username,outcome:'ESCALATE',...(simulated?{exclusion:'SIMULATED'}:submitterId===actor.userId?{exclusion:'SELF_REVIEW'}:{})}]);
    await c.query(`UPDATE tasks SET state='PENDING_SECOND_ASSIGNMENT',current_stage='PENDING_SECOND_ASSIGNMENT',
      assigned_to_user_id=NULL,assignment_source=NULL,assigned_at=NULL,mandatory_copy_qc=true,mandatory_copy_qc_origin='SECOND_ASSIGNMENT',
      mandatory_image_qc=true,mandatory_image_qc_origin='SECOND_ASSIGNMENT',copy_qc_released_revision_id=NULL,
      image_qc_released_approval_event_id=NULL,image_qc_legacy_accepted=false,current_execution_id=NULL,pending_snapshot=NULL,
      work_generation=work_generation+1,progress_message='待管理员二次分配',updated_at=clock_timestamp() WHERE id=$1`,[task.id]);
    await c.query("UPDATE task_executions SET status='ABANDONED',finished_at=clock_timestamp() WHERE task_id=$1 AND status='RUNNING'",[task.id]);
    await withdrawReadyDeliveryEntries(c,Number(task.id),'QA_ESCALATED');
    await resetContent(c,task,record,storageRoot);
    await releaseEscalatedCopyFreezes(c,record.id,actor,replay.requestId);
    await releaseEscalatedImageFreezes(c,record.id,actor);
    return saveResponse(c,actor,replay.requestId,'ESCALATE',fingerprint,{id:publicId,status:'ADMIN_ESCALATED',caseId:Number(record.id)});
  });
  await cleanReassignmentFiles(pool,result.caseId,storageRoot);
  // Blind reviewers receive only their opaque receipt, never a task/operator/case ID.
  return actor.role==='ADMIN'?result:{id:result.id,status:result.status};
}

// Called inside the new copy QA decision transaction. Reuse the existing
// second-assignment reset and cleanup bookkeeping, while retaining the v2
// member as the immutable cause of this case.
export async function escalateNewCopyQaReturn(client,task,member,actor,{note,reasonCodes,storageRoot}) {
  const record=(await client.query(`INSERT INTO task_reassignment_cases(
    task_id,stage,source_item_id,source_item_public_id,source_freeze_id,
    source_copy_qa_member_v2_id,operator_account_id,assignment_record_id,
    reviewer_account_id,reason_codes,note)
    VALUES($1,'COPY',NULL,$2,NULL,$3,$4,
      (SELECT id FROM task_assignment_records WHERE task_id=$1 AND ended_at IS NULL),
      $5,$6,$7) RETURNING *`,
  [task.id,member.public_id,member.id,member.approver_account_id,
    actor.userId,reasonCodes,note])).rows[0];
  await client.query(`UPDATE tasks SET state='PENDING_SECOND_ASSIGNMENT',
    current_stage='PENDING_SECOND_ASSIGNMENT',assigned_to_user_id=NULL,
    assignment_source=NULL,assigned_at=NULL,copy_qc_released_revision_id=NULL,
    copy_qa_rework_pending=false,mandatory_copy_qc=true,mandatory_copy_qc_origin='SECOND_ASSIGNMENT',
    mandatory_image_qc=true,mandatory_image_qc_origin='SECOND_ASSIGNMENT',
    current_execution_id=NULL,pending_snapshot=NULL,work_generation=work_generation+1,
    progress_message='待管理员二次分配',updated_at=clock_timestamp() WHERE id=$1`,[task.id]);
  await client.query("UPDATE task_executions SET status='ABANDONED',finished_at=clock_timestamp() WHERE task_id=$1 AND status='RUNNING'",[task.id]);
  await resetContent(client,task,record,storageRoot);
  return Number(record.id);
}

export async function cleanReassignmentFiles(pool,caseId,storageRoot) {
  if(storageRoot) {
    const sources=(await pool.query(`SELECT DISTINCT a.id,a.task_id,a.sha256 FROM assets a
      JOIN task_reassignment_cleanup f ON f.storage_path=a.storage_path AND f.case_id=$1`,[caseId])).rows;
    for(const asset of sources)await pool.query(`INSERT INTO task_reassignment_cleanup(case_id,task_id,storage_path) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      [caseId,asset.task_id,join(storageRoot,'thumbnails',String(asset.task_id),`${asset.id}-${asset.sha256}-thumb-480-v1.webp`)]);
  }
  const files=(await pool.query('SELECT * FROM task_reassignment_cleanup WHERE case_id=$1 AND cleaned_at IS NULL ORDER BY id',[caseId])).rows;
  if(files.length && !storageRoot)return;
  for(const file of files) {
    try {
      const lexicalRoot=resolve(storageRoot),root=await realpath(lexicalRoot),path=resolve(file.storage_path),rel=relative(lexicalRoot,path);
      if(!rel || rel==='..' || rel.startsWith(`..\\`) || rel.startsWith('../') || isAbsolute(rel))throw Error('清理文件不在任务存储目录内');
      // Resolve the parent as well: a symlink must not turn a validated lexical path into an external delete.
      const parent=await realpath(dirname(path)).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if(parent) {
        const parentRel=relative(root,parent);
        if(parentRel==='..'||parentRel.startsWith('..\\')||parentRel.startsWith('../')||isAbsolute(parentRel))throw Error('清理文件的真实目录越界');
        await rm(path,{force:true});
      }
      await pool.query('UPDATE task_reassignment_cleanup SET cleaned_at=clock_timestamp(),error=NULL WHERE id=$1',[file.id]);
    } catch(error) {await pool.query('UPDATE task_reassignment_cleanup SET error=$2 WHERE id=$1',[file.id,String(error.message).slice(0,500)]);}
  }
  await pool.query(`UPDATE task_reassignment_cases SET cleanup_status=CASE
    WHEN EXISTS(SELECT 1 FROM task_reassignment_cleanup WHERE case_id=$1 AND cleaned_at IS NULL) THEN 'FAILED'
    ELSE 'COMPLETE' END WHERE id=$1 AND reset_status='READY'`,[caseId]);
}

export async function listReassignmentCases(pool,input,actor) {
  return transaction(pool,async c=>{
    await lockActor(c,actor);
    const limit=Number(input?.limit ?? 30),offset=Number(input?.offset ?? 0),status=input?.status ?? 'PENDING';
    if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||!['PENDING','REASSIGNED','DISCARDED','ALL'].includes(status))throw new TypeError('处置列表参数无效');
    const rows=(await c.query(`SELECT r.*,t.query,u.display_name AS operator_name,b.source AS baseline_source,
      count(*) OVER() AS total FROM task_reassignment_cases r LEFT JOIN tasks t ON t.id=r.task_id
      LEFT JOIN app_users u ON u.id=r.operator_account_id LEFT JOIN task_initial_baselines b ON b.task_id=r.task_id
      WHERE ($1='ALL' OR r.status=$1) ORDER BY r.created_at DESC,r.id DESC LIMIT $2 OFFSET $3`,[status,limit,offset])).rows;
    const total=rows[0]?.total ?? (await c.query("SELECT count(*) AS total FROM task_reassignment_cases WHERE ($1='ALL' OR status=$1)",[status])).rows[0].total;
    return {items:rows.map(caseFrom),total:Number(total),limit,offset};
  });
}
export async function getReassignmentCase(pool,id,actor) {
  return transaction(pool,async c=>{
    await lockActor(c,actor);
    const row=(await c.query(`SELECT r.*,t.query,b.source AS baseline_source,b.content AS initial_content
      FROM task_reassignment_cases r LEFT JOIN tasks t ON t.id=r.task_id LEFT JOIN task_initial_baselines b ON b.task_id=r.task_id WHERE r.id=$1`,[normalizeTaskId(id)])).rows[0];
    if(!row)throw new ControlPlaneNotFoundError('处置单不存在');
    const assignments=(await c.query(`SELECT id,assignee_account_id,assignee_username_snapshot,assigned_at,ended_at,end_reason
      FROM task_assignment_records WHERE task_id=$1 ORDER BY id`,[row.task_id])).rows;
    return {...caseFrom(row),initialContent:row.initial_content ?? null,assignments};
  });
}
export async function retryReassignmentReset(pool,id,input,actor,{storageRoot}={}) {
  await transaction(pool,async c=>{
    await lockActor(c,actor);
    const fingerprint=hash({id:Number(id),expectedVersion:input.expectedVersion});
    const replay=await requestReplay(c,actor,input,'RESET',fingerprint);if(replay.response)return;
    const {task,record}=await lockCase(c,id,input,{allowCompletedRegeneration:true});
    await resetContent(c,task,record,storageRoot);
    await saveResponse(c,actor,replay.requestId,'RESET',fingerprint,{id:Number(id)});
  });
  await cleanReassignmentFiles(pool,normalizeTaskId(id),storageRoot);
  return getReassignmentCase(pool,id,actor);
}

export async function regenerateReassignmentBaseline(pool,id,input,actor) {
  return transaction(pool,async c=>{
    await lockActor(c,actor);
    const fingerprint=hash({id:Number(id),expectedVersion:input.expectedVersion});
    const replay=await requestReplay(c,actor,input,'REGENERATE',fingerprint);if(replay.response)return replay.response;
    const located=(await c.query('SELECT task_id FROM task_reassignment_cases WHERE id=$1',[normalizeTaskId(id)])).rows[0];
    if(!located)throw new ControlPlaneNotFoundError('处置单不存在');
    const task=(await c.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[located.task_id])).rows[0];
    const record=(await c.query('SELECT * FROM task_reassignment_cases WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(record.version!==input.expectedVersion||record.status!=='PENDING'||!['PENDING_SECOND_ASSIGNMENT','COPY_FAILED'].includes(task.state))conflict('REASSIGNMENT_CHANGED','任务已变化，请刷新');
    if((await c.query('SELECT 1 FROM task_initial_baselines WHERE task_id=$1',[task.id])).rowCount)conflict('BASELINE_EXISTS','已有可信初稿，请重试还原');
    await c.query(`UPDATE task_reassignment_cases SET reset_status='REGENERATING',reset_error=NULL,version=version+1 WHERE id=$1`,[id]);
    await c.query(`UPDATE tasks SET state='COPY_QUEUED',current_stage='COPY_QUEUED',current_execution_id=NULL,pending_snapshot=NULL,
      skip_copy_review=false,assigned_to_user_id=NULL,assignment_source=NULL,assigned_at=NULL,error=NULL,execution_started_at=NULL,finished_at=NULL,
      progress_percent=0,progress_message='管理员重新生成初始数据，完成后回到待二次分配',updated_at=clock_timestamp() WHERE id=$1`,[task.id]);
    return saveResponse(c,actor,replay.requestId,'REGENERATE',fingerprint,{id:Number(id),status:'REGENERATING'});
  });
}

// Called within the copy execution transaction, before exposing a regenerated
// draft to ordinary assignment/review. File cleanup remains a retryable admin action.
export async function finishReassignmentBaseline(c,taskId) {
  const record=(await c.query("SELECT * FROM task_reassignment_cases WHERE task_id=$1 AND status='PENDING' AND reset_status='REGENERATING' FOR UPDATE",[taskId])).rows[0];
  if(!record)return null;
  await c.query("SELECT set_config('app.secondary_assignment','on',true)");
  const task=(await c.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[taskId])).rows[0];
  await resetContent(c,task,record);
  return (await c.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];
}

export async function restoreSecondaryAssignment(c,task,actor,note='管理员恢复待二次分配') {
  const record=(await c.query("SELECT * FROM task_reassignment_cases WHERE task_id=$1 ORDER BY id DESC LIMIT 1 FOR UPDATE",[task.id])).rows[0];
  if(task.state!=='CANCELLED'||record?.status!=='DISCARDED')conflict('REASSIGNMENT_CHANGED','该任务已不在二次分配废弃状态');
  await c.query("SELECT set_config('app.secondary_assignment','on',true)");
  await c.query(`INSERT INTO account_quality_events(event_key,task_id,stage,account_id,action,occurred_at,data)
    VALUES($1,$2,$3,$4,'RESTORE',clock_timestamp(),$5)`,[`case-restore:${record.id}:${record.version}`,task.id,record.stage,record.operator_account_id,{caseId:Number(record.id),actorId:actor.userId,note}]);
  await c.query(`UPDATE task_reassignment_cases SET status='PENDING',version=version+1 WHERE id=$1`,[record.id]);
  return (await c.query(`UPDATE tasks SET state='PENDING_SECOND_ASSIGNMENT',current_stage='PENDING_SECOND_ASSIGNMENT',cancelled_from_state=NULL,
    progress_message='已撤销废弃，待管理员二次分配',finished_at=NULL,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[task.id])).rows[0];
}
export async function restoreReassignmentCase(pool,id,input,actor) {
  return transaction(pool,async c=>{
    await lockActor(c,actor);
    const note=noteOf(input.note),fingerprint=hash({id:Number(id),note,expectedVersion:input.expectedVersion});
    const replay=await requestReplay(c,actor,input,'RESTORE',fingerprint);if(replay.response)return replay.response;
    const record=(await c.query('SELECT * FROM task_reassignment_cases WHERE id=$1',[normalizeTaskId(id)])).rows[0];
    if(!record)throw new ControlPlaneNotFoundError('处置单不存在');
    const task=(await c.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[record.task_id])).rows[0];
    const locked=(await c.query('SELECT * FROM task_reassignment_cases WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(locked.version!==input.expectedVersion)conflict('REASSIGNMENT_CHANGED','处置单已变化，请刷新');
    await restoreSecondaryAssignment(c,task,actor,note);
    return saveResponse(c,actor,replay.requestId,'RESTORE',fingerprint,{id:Number(id),status:'PENDING'});
  });
}
export async function disposeReassignmentCase(pool,id,input,actor,operation) {
  if(!['REASSIGN','DISCARD'].includes(operation))throw new TypeError('invalid disposition');
  const note=noteOf(input?.note),fingerprint=hash({id:Number(id),operation,note,targetAccountId:input.targetAccountId,expectedVersion:input.expectedVersion});
  return transaction(pool,async c=>{
    await lockActor(c,actor);
    const replay=await requestReplay(c,actor,input,operation,fingerprint);if(replay.response)return replay.response;
    const {task,record}=await lockCase(c,id,input);
    let target=null;
    if(operation==='REASSIGN') {
      if(record.reset_status!=='READY'||record.cleanup_status!=='COMPLETE')conflict('RESET_INCOMPLETE','初始还原或修改记录清理尚未完成');
      target=(await c.query(`SELECT * FROM app_users WHERE id=$1 AND status='ACTIVE'
        AND (role='ADMIN' OR copy_review_enabled=true) FOR SHARE`,[normalizeTaskId(input.targetAccountId)])).rows[0];
      if(!target)throw new ControlPlaneAuthorizationError('目标账号无文案标注权限或已停用');
      // Ordinary assignments cannot bypass this transaction; source record is retained by the trigger.
      await c.query(`UPDATE tasks SET assigned_to_user_id=$2,assignment_source='MANUAL',assigned_at=clock_timestamp(),
        state='COPY_REVIEW_PENDING',current_stage='COPY_REVIEW_PENDING',
        copy_qa_cycle=copy_qa_cycle+1,
        progress_message='二次分配初始数据，等待重新标注',updated_at=clock_timestamp() WHERE id=$1`,[task.id,target.username]);
      await c.query(`INSERT INTO task_assignment_events(task_id,actor_username,previous_assignee_user_id,assignee_user_id,source,reason)
        VALUES($1,$2,NULL,$3,'MANUAL',$4)`,[task.id,actor.username,target.username,note.slice(0,200)]);
      await c.query(`UPDATE task_assignment_records SET source='SECOND_ASSIGNMENT',reason=$2,assigned_by_account_id=$3,
        previous_record_id=$4 WHERE task_id=$1 AND ended_at IS NULL`,[task.id,note,actor.userId,record.assignment_record_id]);
      await c.query(`INSERT INTO account_quality_events(event_key,task_id,stage,account_id,action,occurred_at,data)
        VALUES($1,$2,$3,$4,'REASSIGNED',clock_timestamp(),$5) ON CONFLICT DO NOTHING`,[`reassigned:${record.id}:${record.version}`,task.id,record.stage,record.operator_account_id,{caseId:Number(record.id),targetAccountId:Number(target.id),actorId:actor.userId}]);
    } else {
      await c.query(`UPDATE tasks SET state='CANCELLED',cancelled_from_state='PENDING_SECOND_ASSIGNMENT',current_stage='CANCELLED',
        current_execution_id=NULL,progress_message='管理员最终废弃',finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,[task.id]);
      await c.query(`INSERT INTO account_quality_events(event_key,task_id,stage,account_id,action,occurred_at,data)
        VALUES($1,$2,$3,$4,'DISCARD',clock_timestamp(),$5) ON CONFLICT DO NOTHING`,[`admin-discard:${record.id}:${record.version}`,task.id,record.stage,record.operator_account_id,{caseId:Number(record.id),note,actorId:actor.userId}]);
    }
    const updated=(await c.query(`UPDATE task_reassignment_cases SET status=$2,disposed_at=clock_timestamp(),disposed_by_account_id=$3,
      target_account_id=$4,disposition_note=$5,version=version+1 WHERE id=$1 RETURNING *`,[record.id,operation==='REASSIGN'?'REASSIGNED':'DISCARDED',actor.userId,target?.id ?? null,note])).rows[0];
    return saveResponse(c,actor,replay.requestId,operation,fingerprint,caseFrom(updated));
  });
}
