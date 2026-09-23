import { createHash, randomInt } from 'node:crypto';
import {
  ControlPlaneAuthenticationError, ControlPlaneAuthorizationError,
  ControlPlaneConflictError, ControlPlaneNotFoundError, normalizeTaskId, normalizeUuid,
} from './domain.mjs';
import { resolveEffectiveCopySamplingPolicy } from '../../src/copy-sampling-policy.mjs';
import { readWorkflowQualitySettings } from './workflow-quality-settings.mjs';
import { resolveCopyQaReasonSnapshots } from './copy-qa-reason-tags.mjs';
import { MAX_COPY_QA_REASON_CODES } from '../../src/copy-qa-reasons.mjs';
import { escalateNewCopyQaReturn, cleanReassignmentFiles } from './secondary-assignment.mjs';

const conflict = (code, message) => { throw new ControlPlaneConflictError(code, message); };
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const integer = (value) => Number.isSafeInteger(Number(value)) ? Number(value) : null;

async function transaction(pool, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if(['40P01','55P03','23505'].includes(error?.code))conflict('QA_BATCH_BUSY','质检批次或任务正在被处理，请刷新重试');
    throw error;
  } finally { client.release(); }
}

async function activeActor(client, rawActor, { admin = false, qc = false } = {}) {
  const id = integer(rawActor?.userId);
  if (!id || id < 1) throw new ControlPlaneAuthenticationError();
  const actor = (await client.query(`SELECT * FROM app_users WHERE id=$1 AND username=$2
    AND role=$3 AND status='ACTIVE' AND credential_version=$4 FOR SHARE`,
  [id,rawActor.username,rawActor.role,rawActor.credentialVersion])).rows[0];
  if (!actor) throw new ControlPlaneAuthenticationError();
  if (admin && actor.role !== 'ADMIN') throw new ControlPlaneAuthorizationError('仅管理员可以创建文案质检批次');
  if (qc && actor.role !== 'ADMIN' && !actor.copy_qc_enabled) {
    throw new ControlPlaneAuthorizationError('文案质检权限已关闭');
  }
  return actor;
}

const CANDIDATE_SQL = `SELECT task.id AS task_id,task.query,task.current_copy_revision_id AS copy_revision_id,
  task.copy_qa_cycle,approval.id AS approval_event_id,approval.content_sha256,
  approval.approved_by_account_id AS account_id,approval.approved_by_username AS username,
  approval.approved_at,approver.display_name,approver.copy_sampling_rate_bps_override,
  approver.auto_copy_batch_size,approver.auto_copy_batch_enabled,approver.copy_full_inspection,
  approver.version AS account_version
  FROM tasks AS task
  JOIN copy_approval_events AS approval ON approval.task_id=task.id
    AND approval.copy_revision_id=task.current_copy_revision_id
    AND approval.approval_mode='MANUAL'
  LEFT JOIN app_users AS approver ON approver.id=approval.approved_by_account_id
  WHERE task.state='COPY_QC_PENDING'
    AND NOT EXISTS (SELECT 1 FROM copy_qa_batch_members_v2 AS member
      WHERE member.task_id=task.id AND member.copy_revision_id=task.current_copy_revision_id)`;

export async function listCopyQaCandidatesV2(pool, actor, accountId = null) {
  const id = accountId == null ? null : normalizeTaskId(accountId);
  await activeActor(pool, actor, { admin: true });
  const [users, tasks, counts] = await Promise.all([
    pool.query(`SELECT id,username,display_name,status,auto_copy_batch_enabled,
      auto_copy_batch_size,copy_full_inspection,copy_sampling_rate_bps_override
      FROM app_users ORDER BY display_name,id`),
    pool.query(`${CANDIDATE_SQL} AND ($1::bigint IS NULL OR approval.approved_by_account_id=$1)
      ORDER BY approval.approved_at,task.id LIMIT 5000`, [id]),
    pool.query(`SELECT approval.approved_by_account_id AS account_id,count(*) AS pending_count
      FROM tasks AS task JOIN copy_approval_events AS approval
        ON approval.task_id=task.id AND approval.copy_revision_id=task.current_copy_revision_id
       AND approval.approval_mode='MANUAL'
      WHERE task.state='COPY_QC_PENDING' AND NOT EXISTS (
        SELECT 1 FROM copy_qa_batch_members_v2 AS member
        WHERE member.task_id=task.id AND member.copy_revision_id=task.current_copy_revision_id)
      GROUP BY approval.approved_by_account_id`),
  ]);
  const pendingCounts = new Map(counts.rows.map(row=>[Number(row.account_id),Number(row.pending_count)]));
  return {
    users: users.rows.map(row => ({ id:Number(row.id), username:row.username, displayName:row.display_name,
      status:row.status, pendingCount:pendingCounts.get(Number(row.id)) ?? 0,
      autoBatchEnabled:row.auto_copy_batch_enabled, autoBatchSize:row.auto_copy_batch_size,
      fullInspection:row.copy_full_inspection, samplingRateBpsOverride:row.copy_sampling_rate_bps_override })),
    tasks: tasks.rows.map(row => ({ taskId:Number(row.task_id), query:row.query,
      approverAccountId:Number(row.account_id), approverUsername:row.username,
      approvedAt:row.approved_at, copyRevisionId:Number(row.copy_revision_id) })),
    truncated: tasks.rows.length === 5000,
  };
}

function randomSubset(taskIds, count) {
  const shuffled = [...taskIds];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const pick = randomInt(index + 1);
    [shuffled[index], shuffled[pick]] = [shuffled[pick], shuffled[index]];
  }
  return new Set(shuffled.slice(0,count));
}

export function plannedSampleCount(memberCount,rateBps) {
  if(!Number.isSafeInteger(memberCount)||memberCount<0||!Number.isInteger(rateBps)
    ||rateBps<0||rateBps>10000)throw new RangeError('invalid sample plan');
  return Math.ceil(memberCount*rateBps/10000);
}

export function rejectionTriggerCount(sampleCount,thresholdBps) {
  if(!Number.isSafeInteger(sampleCount)||sampleCount<0||!Number.isInteger(thresholdBps)
    ||thresholdBps<1||thresholdBps>10000)throw new RangeError('invalid rejection threshold');
  return sampleCount===0?0:Math.max(1,Math.ceil(sampleCount*thresholdBps/10000));
}

function blindContent(content) {
  const value=content&&typeof content==='object'&&!Array.isArray(content)?content:{};
  const raw=value.copy??value.reviewed?.copy??value.post??{};
  const plan=value.imagePlan??value.reviewed?.imagePlan??value.post?.imagePlan;
  return {copy:{title:typeof raw.title==='string'?raw.title:'',
    body:typeof raw.body==='string'?raw.body:'',
    tags:Array.isArray(raw.tags)?raw.tags.filter(tag=>typeof tag==='string').slice(0,8):[]},
    imagePlan:Array.isArray(plan)?plan.slice(0,5).map(page=>({
      kind:typeof page?.kind==='string'?page.kind:'',
      headline:typeof page?.headline==='string'?page.headline:'',
      subtitle:typeof page?.subtitle==='string'?page.subtitle:'',
      bullets:Array.isArray(page?.bullets)?page.bullets.filter(item=>typeof item==='string').slice(0,5):[],
      prompt:typeof page?.prompt==='string'?page.prompt:'',
    })):[]};
}

async function createBatchInTransaction(client, rows, {
  mode, accountId = null, selectedTaskIds = null, actorId = null,
  requestId = null, requestFingerprint = null, rateBps = null, fullInspection = false,
}) {
  if (!rows.length) conflict('EMPTY_BATCH', '没有可成批的任务');
  const settings = await readWorkflowQualitySettings(client);
  const ids = rows.map(row => Number(row.task_id));
  const selected = selectedTaskIds ?? randomSubset(ids,
    plannedSampleCount(ids.length,rateBps ?? settings.copySampling.rateBps));
  if ([...selected].some(id => !ids.includes(id))) throw new TypeError('抽检项必须属于批次成员');
  const sampleCount = selected.size;
  const returnThresholdBps = settings.copySampling.returnThresholdBps;
  const triggerCount = rejectionTriggerCount(sampleCount,returnThresholdBps);
  const batch = (await client.query(`INSERT INTO copy_qa_batches_v2(
    mode,account_id,full_inspection,blind_review_enabled,sampling_rate_bps,return_threshold_bps,
    return_trigger_count,member_count,sample_count,created_by_account_id,request_id,request_fingerprint)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
  [mode,accountId,fullInspection,settings.copySampling.blindReviewEnabled,
    rateBps,returnThresholdBps,triggerCount,ids.length,sampleCount,actorId,requestId,requestFingerprint])).rows[0];
  for (const row of rows) {
    const isSelected = selected.has(Number(row.task_id));
    await client.query(`INSERT INTO copy_qa_batch_members_v2(batch_id,task_id,copy_revision_id,
      approval_event_id,approver_account_id,quality_cycle,content_sha256,selected,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [batch.id,row.task_id,row.copy_revision_id,row.approval_event_id,row.account_id,
      row.copy_qa_cycle,row.content_sha256,isSelected,isSelected?'PENDING':'NOT_SELECTED']);
  }
  if (!sampleCount) await completeBatch(client,batch.id,'COMPLETED');
  return { id:batch.public_id, displayName:batch.display_name, memberCount:ids.length, sampleCount, mode };
}

export async function createCopyQaBatchV2(pool, input, actor) {
  const requestId = normalizeUuid(input?.requestId,'requestId');
  const mode = input?.mode;
  if (!['PERSONAL_MANUAL','PERSONAL_AUTO','MIXED_MANUAL'].includes(mode)) throw new TypeError('mode is invalid');
  const rawIds = input?.taskIds;
  if (!Array.isArray(rawIds) || !rawIds.length || rawIds.length > 5000) throw new TypeError('taskIds must contain 1–5000 tasks');
  const ids = [...new Set(rawIds.map(id=>normalizeTaskId(id)))].sort((a,b)=>a-b);
  if (ids.length !== rawIds.length) throw new TypeError('taskIds must be unique');
  const selectedIds = mode === 'PERSONAL_AUTO' ? null : new Set((input.sampleTaskIds ?? []).map(id=>normalizeTaskId(id)));
  const accountId = mode === 'MIXED_MANUAL' ? null : normalizeTaskId(input.accountId);
  const requestFingerprint=fingerprint({mode,ids,selectedIds:selectedIds?[...selectedIds].sort((a,b)=>a-b):null,accountId});
  return transaction(pool, async client => {
    const user = await activeActor(client,actor,{admin:true});
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',[`copy-qa-create:${user.id}`,requestId]);
    const replay=(await client.query(`SELECT * FROM copy_qa_batches_v2
      WHERE created_by_account_id=$1 AND request_id=$2`,[user.id,requestId])).rows[0];
    if(replay){
      if(replay.request_fingerprint!==requestFingerprint)conflict('REQUEST_ID_REUSED','请求编号已用于不同的成批内容');
      return {id:replay.public_id,displayName:replay.display_name,memberCount:replay.member_count,sampleCount:replay.sample_count,mode:replay.mode};
    }
    const rows=(await client.query(`${CANDIDATE_SQL} AND task.id=ANY($1::bigint[])
      ORDER BY task.id FOR UPDATE OF task NOWAIT`,[ids])).rows;
    if(rows.length!==ids.length)conflict('STALE_BATCH_SELECTION','部分任务已成批或状态发生变化，请刷新');
    if(accountId!==null && rows.some(row=>Number(row.account_id)!==accountId)){
      throw new TypeError('个人批次只能包含该用户审核通过的任务');
    }
    let rateBps=null,fullInspection=false;
    if(accountId!==null){
      const settings=await readWorkflowQualitySettings(client);
      const policy=resolveEffectiveCopySamplingPolicy({globalEnabled:settings.copySampling.enabled,
        globalRateBps:settings.copySampling.rateBps,globalPolicyVersion:settings.version,
        accountRateBpsOverride:rows[0].copy_sampling_rate_bps_override});
      rateBps=policy.rateBps;
      fullInspection=rows[0].copy_full_inspection===true;
    }
    return createBatchInTransaction(client,rows,{mode,accountId,selectedTaskIds:selectedIds,
      actorId:Number(user.id),requestId,requestFingerprint,rateBps,fullInspection});
  });
}

export async function autoCreateCopyQaBatchesV2(client, accountId) {
  const id=normalizeTaskId(accountId);
  const account=(await client.query(`SELECT * FROM app_users WHERE id=$1 FOR SHARE`,[id])).rows[0];
  if(!account?.auto_copy_batch_enabled || account.status!=='ACTIVE')return [];
  const settings=await readWorkflowQualitySettings(client);
  if(!settings.copySampling.enabled)return [];
  const size=Number(account.auto_copy_batch_size);
  const policy=resolveEffectiveCopySamplingPolicy({globalEnabled:true,
    globalRateBps:settings.copySampling.rateBps,globalPolicyVersion:settings.version,
    accountRateBpsOverride:account.copy_sampling_rate_bps_override});
  const created=[];
  while(true){
    const rows=(await client.query(`${CANDIDATE_SQL}
      AND approval.approved_by_account_id=$1 ORDER BY approval.approved_at,task.id
      LIMIT $2 FOR UPDATE OF task SKIP LOCKED`,[id,size])).rows;
    if(rows.length<size)break;
    created.push(await createBatchInTransaction(client,rows,{mode:'PERSONAL_AUTO',accountId:id,
      rateBps:policy.rateBps,fullInspection:account.copy_full_inspection===true}));
  }
  return created;
}

export async function routeCopyApprovalV2(client,{task,revision,approval,actor,aiDisclosureEnabled}) {
  const settings=await readWorkflowQualitySettings(client);
  if(!settings.copySampling.enabled){
    const result=await client.query(`UPDATE tasks SET state='IMAGE_QUEUED',current_stage='IMAGE_QUEUED',
      current_copy_revision_id=$2,copy_qc_released_revision_id=$2,copy_qa_rework_pending=false,mandatory_copy_qc=false,
      mandatory_copy_qc_origin=NULL,ai_disclosure_enabled=$3,progress_percent=0,
      current_execution_id=NULL,current_image_run_id=NULL,pending_snapshot=NULL,
      execution_started_at=NULL,finished_at=NULL,error=NULL,last_activity_at=now(),
      progress_message='文案审核通过，等待生图',updated_at=now() WHERE id=$1 RETURNING *`,
    [task.id,revision.id,aiDisclosureEnabled]);
    return {task:result.rows[0],approval};
  }
  const result=await client.query(`UPDATE tasks SET state='COPY_QC_PENDING',current_stage='COPY_QC_PENDING',
    current_copy_revision_id=$2,copy_qc_released_revision_id=NULL,copy_qa_rework_pending=false,mandatory_copy_qc=false,
    mandatory_copy_qc_origin=NULL,ai_disclosure_enabled=$3,progress_percent=100,
    current_execution_id=NULL,current_image_run_id=NULL,pending_snapshot=NULL,
    execution_started_at=NULL,finished_at=NULL,error=NULL,last_activity_at=now(),
    progress_message='文案审核通过，等待质检成批',updated_at=now() WHERE id=$1 RETURNING *`,
  [task.id,revision.id,aiDisclosureEnabled]);
  await autoCreateCopyQaBatchesV2(client,approval.approved_by_account_id);
  return {task:result.rows[0],approval};
}

export async function listCopyQaBatchesV2(pool,actor,view='PENDING') {
  if(!['PENDING','FINISHED'].includes(view))throw new TypeError('view is invalid');
  await activeActor(pool,actor,{qc:true});
  const own=actor.role==='ADMIN'?null:Number(actor.userId);
  const result=await pool.query(`SELECT batch.*,
    count(*) FILTER(WHERE member.status='PENDING' AND member.selected) AS pending_count,
    count(*) FILTER(WHERE member.status='PASSED') AS passed_count,
    count(*) FILTER(WHERE member.status='RETURNED') AS returned_count,
    count(*) FILTER(WHERE member.status='BATCH_AFFECTED') AS affected_count
    FROM copy_qa_batches_v2 AS batch
    JOIN copy_qa_batch_members_v2 AS member ON member.batch_id=batch.id
    WHERE (($2='PENDING' AND batch.status='INSPECTING')
      OR ($2='FINISHED' AND batch.status IN ('COMPLETED','AUTO_RETURNED')))
      AND ($1::bigint IS NULL OR member.approver_account_id<>$1)
    GROUP BY batch.id ORDER BY batch.created_at DESC,batch.id DESC`,[own,view]);
  return result.rows.map(row=>({id:row.public_id,displayName:row.display_name,mode:row.mode,status:row.status,
    accountId:row.account_id==null?null:Number(row.account_id),
    fullInspection:row.full_inspection,memberCount:row.member_count,sampleCount:row.sample_count,
    pendingCount:Number(row.pending_count),passedCount:Number(row.passed_count),
    returnedCount:Number(row.returned_count),affectedCount:Number(row.affected_count),
    returnTriggerCount:row.return_trigger_count,createdAt:row.created_at}));
}

export async function listCopyQaBatchItemsV2(pool,batchId,actor) {
  const id=normalizeUuid(batchId,'batchId');
  await activeActor(pool,actor,{qc:true});
  const own=actor.role==='ADMIN'?null:Number(actor.userId);
  const batch=(await pool.query('SELECT * FROM copy_qa_batches_v2 WHERE public_id=$1',[id])).rows[0];
  if(!batch)throw new ControlPlaneNotFoundError('质检批次不存在');
  const rows=(await pool.query(`SELECT member.*,task.query,revision.content,
      approval.approved_by_username AS approver_username
    FROM copy_qa_batch_members_v2 AS member
    JOIN tasks AS task ON task.id=member.task_id
    JOIN copy_revisions AS revision ON revision.id=member.copy_revision_id
    JOIN copy_approval_events AS approval ON approval.id=member.approval_event_id
    WHERE member.batch_id=$1 AND member.selected AND ($2::bigint IS NULL OR member.approver_account_id<>$2)
    ORDER BY member.id`,[batch.id,own])).rows;
  const blind=batch.blind_review_enabled&&actor.role!=='ADMIN';
  return {batch:{id:batch.public_id,displayName:batch.display_name,mode:batch.mode,status:batch.status,
    memberCount:batch.member_count,sampleCount:batch.sample_count,fullInspection:batch.full_inspection,
    returnTriggerCount:batch.return_trigger_count},items:rows.map(row=>({
      id:row.public_id,taskId:blind?null:Number(row.task_id),
      query:blind?null:row.query,content:blind?blindContent(row.content):row.content,status:row.status,
      approverUsername:blind?null:row.approver_username,revisionToken:row.content_sha256,
      createdAt:row.created_at,
    }))};
}

async function releaseMember(client,member) {
  const updated=await client.query(`UPDATE tasks SET state='IMAGE_QUEUED',current_stage='IMAGE_QUEUED',
    copy_qc_released_revision_id=current_copy_revision_id,mandatory_copy_qc=false,
    mandatory_copy_qc_origin=NULL,progress_percent=0,
    progress_message='文案质检已放行，等待生图',updated_at=now()
    WHERE id=$1 AND state='COPY_QC_PENDING' AND current_copy_revision_id=$2`,
  [member.task_id,member.copy_revision_id]);
  if(updated.rowCount!==1)conflict('STALE_QA_ITEM','任务状态或版本已变化');
}

async function completeBatch(client,batchId,status) {
  const members=(await client.query(`SELECT * FROM copy_qa_batch_members_v2 WHERE batch_id=$1
    AND status='NOT_SELECTED' ORDER BY task_id FOR UPDATE`,[batchId])).rows;
  for(const member of members)await releaseMember(client,member);
  await client.query(`UPDATE copy_qa_batch_members_v2 SET status='RELEASED'
    WHERE batch_id=$1 AND status='NOT_SELECTED'`,[batchId]);
  await client.query(`UPDATE copy_qa_batches_v2 SET status=$2,completed_at=now(),version=version+1
    WHERE id=$1 AND status='INSPECTING'`,[batchId,status]);
}

async function recordQualityOutcome(client,member,actor,outcome,kind) {
  const isSelf=Number(member.approver_account_id)===Number(actor.userId);
  const context=(await client.query(`SELECT approval.approved_by_username,task.production_batch_id
    FROM copy_approval_events AS approval JOIN tasks AS task ON task.id=approval.task_id
    WHERE approval.id=$1`,[member.approval_event_id])).rows[0];
  const data={batchId:context?.production_batch_id==null?null:Number(context.production_batch_id),
    qaBatchId:Number(member.batch_id),samplingItemId:Number(member.id),
    reviewerId:actor.userId,username:context?.approved_by_username??null,
    selected:member.selected,source:kind};
  if(!isSelf)await client.query(`INSERT INTO account_quality_events(
    event_key,task_id,stage,account_id,action,establishes_sample,occurred_at,data)
    VALUES($1,$2,'COPY',$3,$4,true,clock_timestamp(),$5)
    ON CONFLICT DO NOTHING`,[`copy-v2:${member.id}`,member.task_id,member.approver_account_id,
      outcome,data]);
  if(kind!=='BATCH_AFFECTED')await client.query(`INSERT INTO quality_review_activity_events(
    event_key,account_id,task_id,stage,kind,occurred_at,data)
    VALUES($1,$2,$3,'COPY','QA_REVIEW',clock_timestamp(),$4)
    ON CONFLICT DO NOTHING`,[`copy-v2:${member.id}`,actor.userId,member.task_id,
      {...data,outcome,
        ...(isSelf?{exclusion:'SELF_REVIEW'}:{})}]);
}

async function returnMember(client,member,actor,{note,reasonCodes=[],reasonSnapshots=[],kind,storageRoot,caseIds}) {
  const task=(await client.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[member.task_id])).rows[0];
  if(!task || task.state!=='COPY_QC_PENDING' || Number(task.current_copy_revision_id)!==Number(member.copy_revision_id)){
    conflict('STALE_QA_ITEM','任务版本或状态已变化');
  }
  const prior=Number((await client.query(`SELECT count(*) AS count FROM copy_qa_return_events_v2
    WHERE task_id=$1 AND quality_cycle=$2`,[member.task_id,member.quality_cycle])).rows[0].count);
  await client.query(`UPDATE copy_qa_batch_members_v2 SET status=$2,reviewed_by_account_id=$3,
    reason_codes=$4,reason_snapshots=$5::jsonb,note=$6,decided_at=now() WHERE id=$1`,
  [member.id,kind==='DIRECT'?'RETURNED':'BATCH_AFFECTED',actor.userId,reasonCodes,JSON.stringify(reasonSnapshots),note]);
  await client.query(`INSERT INTO copy_qa_return_events_v2(task_id,quality_cycle,member_id,kind)
    VALUES($1,$2,$3,$4)`,[member.task_id,member.quality_cycle,member.id,kind]);
  await recordQualityOutcome(client,member,actor,'RETURN',kind);
  if(prior>0){
    const caseId=await escalateNewCopyQaReturn(client,task,member,actor,{note,reasonCodes,storageRoot});
    caseIds?.push(caseId);
    return;
  }
  const current=(await client.query(`SELECT * FROM copy_revisions WHERE id=$1`,[member.copy_revision_id])).rows[0];
  const revision=(await client.query(`INSERT INTO copy_revisions(task_id,revision,content,parent_revision_id,
    revision_origin,copy_content_changed_from_machine,copy_rework_satisfied)
    SELECT $1,coalesce(max(revision),0)+1,$2,$3,'QA_RETURN',$4,false
    FROM copy_revisions WHERE task_id=$1 RETURNING id`,
  [member.task_id,{...current.content,qualityReturn:{origin:kind,baseRevisionId:Number(member.copy_revision_id),
    samplingItemId:member.public_id,returnedByUsername:actor.username,
    reasonCodes,reasonSnapshots,note,returnedAt:new Date().toISOString()}},member.copy_revision_id,
    current.copy_content_changed_from_machine===true])).rows[0];
  await client.query(`UPDATE tasks SET state='COPY_REVIEW_PENDING',current_stage='COPY_REVIEW_PENDING',
    current_copy_revision_id=$2,copy_qc_released_revision_id=NULL,
    copy_qa_rework_pending=true,mandatory_copy_qc=false,mandatory_copy_qc_origin=NULL,
    current_execution_id=NULL,current_image_run_id=NULL,pending_snapshot=NULL,error=NULL,
    finished_at=now(),last_activity_at=now(),
    progress_message='文案质检驳回，修改并重新审核后按普通规则成批',updated_at=now()
    WHERE id=$1`,[member.task_id,revision.id]);
}

async function maybeCloseBatch(client,batch,actor,storageRoot,caseIds) {
  const stats=(await client.query(`SELECT count(*) FILTER(WHERE selected AND status='PENDING') AS pending,
    count(*) FILTER(WHERE status='RETURNED') AS returned
    FROM copy_qa_batch_members_v2 WHERE batch_id=$1`,[batch.id])).rows[0];
  if(!batch.full_inspection && batch.return_trigger_count>0
      && Number(stats.returned)>=Number(batch.return_trigger_count)){
    const affected=(await client.query(`SELECT * FROM copy_qa_batch_members_v2
      WHERE batch_id=$1 AND status IN ('PENDING','NOT_SELECTED') ORDER BY task_id FOR UPDATE`,[batch.id])).rows;
    for(const member of affected)await returnMember(client,member,actor,
      {note:'达到批次驳回率阈值，系统自动整批驳回',kind:'BATCH_AFFECTED',storageRoot,caseIds});
    await client.query(`UPDATE copy_qa_batches_v2 SET status='AUTO_RETURNED',completed_at=now(),
      version=version+1 WHERE id=$1`,[batch.id]);
  }else if(Number(stats.pending)===0){
    await completeBatch(client,batch.id,'COMPLETED');
  }
}

export async function decideCopyQaItemV2(pool,itemId,input,actor,{storageRoot}={}) {
  const id=normalizeUuid(itemId,'itemId');
  const requestId=normalizeUuid(input?.requestId,'requestId');
  const decision=input?.decision;
  if(!['PASS','RETURN'].includes(decision))throw new TypeError('decision is invalid');
  const token=String(input?.revisionToken??'');
  const note=String(input?.note??'').trim();
  const reasonCodes=Array.isArray(input?.reasonCodes)?input.reasonCodes:[];
  if(note.length>1000||reasonCodes.length>MAX_COPY_QA_REASON_CODES||reasonCodes.some(code=>typeof code!=='string'||code.length>100))throw new TypeError('质检原因无效');
  if(new Set(reasonCodes).size!==reasonCodes.length)throw new TypeError('问题标签不能重复');
  if(decision==='RETURN'&&!note&&!reasonCodes.length)throw new TypeError('驳回需要原因');
  const requestFingerprint=fingerprint({id,decision,token,note,reasonCodes});
  const caseIds=[];
  const result=await transaction(pool,async client=>{
    await client.query("SELECT set_config('app.secondary_assignment','on',true)");
    const reviewer=await activeActor(client,actor,{qc:true});
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',[`copy-qa-decision:${reviewer.id}`,requestId]);
    const replay=(await client.query(`SELECT * FROM copy_qa_decision_requests_v2
      WHERE reviewer_account_id=$1 AND request_id=$2`,[reviewer.id,requestId])).rows[0];
    if(replay){
      if(replay.fingerprint!==requestFingerprint)conflict('REQUEST_ID_REUSED','请求编号已用于不同质检操作');
      return replay.response;
    }
    const location=(await client.query(`SELECT batch_id FROM copy_qa_batch_members_v2
      WHERE public_id=$1`,[id])).rows[0];
    if(!location)throw new ControlPlaneNotFoundError('质检项不存在');
    const batch=(await client.query(`SELECT * FROM copy_qa_batches_v2 WHERE id=$1 FOR UPDATE`,[location.batch_id])).rows[0];
    if(batch.status!=='INSPECTING')conflict('BATCH_CLOSED','质检批次已结束');
    const member=(await client.query(`SELECT * FROM copy_qa_batch_members_v2
      WHERE public_id=$1 FOR UPDATE`,[id])).rows[0];
    if(!member.selected||member.status!=='PENDING'||member.content_sha256!==token){
      conflict('STALE_QA_ITEM','质检项已变化，请刷新');
    }
    if(reviewer.role!=='ADMIN'&&Number(member.approver_account_id)===Number(reviewer.id)){
      throw new ControlPlaneAuthorizationError('不能质检自己审核通过的文案');
    }
    const reasonSnapshots=decision==='RETURN'
      ?await resolveCopyQaReasonSnapshots(client,reasonCodes,actor):[];
    if(decision==='PASS'){
      await client.query(`UPDATE copy_qa_batch_members_v2 SET status='PASSED',
        reviewed_by_account_id=$2,decided_at=now() WHERE id=$1`,[member.id,reviewer.id]);
      await recordQualityOutcome(client,member,{userId:Number(reviewer.id)},'PASS','DIRECT');
      await releaseMember(client,member);
    }else{
      await returnMember(client,member,{userId:Number(reviewer.id),username:reviewer.username},
        {note,reasonCodes,reasonSnapshots,kind:'DIRECT',storageRoot,caseIds});
    }
    await maybeCloseBatch(client,batch,{userId:Number(reviewer.id),username:reviewer.username},storageRoot,caseIds);
    const response={id,status:decision==='PASS'?'PASSED':'RETURNED'};
    await client.query(`INSERT INTO copy_qa_decision_requests_v2(
      reviewer_account_id,request_id,fingerprint,response) VALUES($1,$2,$3,$4)`,
    [reviewer.id,requestId,requestFingerprint,response]);
    return response;
  });
  for(const caseId of caseIds)await cleanReassignmentFiles(pool,caseId,storageRoot);
  return {...result,caseIds};
}
