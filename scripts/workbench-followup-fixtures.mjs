import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

const sha256 = value => createHash('sha256').update(value).digest('hex');

// Only private paused fixtures. These do not create task_executions or call a model.
export async function createFollowupFixtures({ pool, admin, node, suffix, taskIds, storageRoot, fixture = {} }) {
  await pool.query('UPDATE app_users SET auto_copy_batch_enabled=false WHERE id=$1 AND username=$2', [admin.id, admin.username]);
  const copyCandidateIds = fixture.copyCandidateIds = [];
  for (let index = 1; index <= 3; index++) {
    const task = (await pool.query(`INSERT INTO tasks(query,created_by_node_id,state,current_stage,
      created_by_user_id,assigned_to_user_id,assigned_at,assignment_source,priority_mode,priority_paused)
      VALUES($1,$2,'COPY_QC_PENDING','COPY_QC_PENDING',$3,$3,now(),'MANUAL','PAUSE',true) RETURNING id`,
    [`按需候选 ${suffix} ${index}`, node.id, admin.username])).rows[0];
    taskIds.push(Number(task.id)); copyCandidateIds.push(Number(task.id));
    const content = { copy: { title: `按需候选 ${index}`, body: '合成测试，未调用模型。', tags: [] }, imagePlan: [] };
    const revision = (await pool.query('INSERT INTO copy_revisions(task_id,revision,content,approved_at) VALUES($1,1,$2,now()) RETURNING id', [task.id, content])).rows[0];
    await pool.query('UPDATE tasks SET current_copy_revision_id=$2 WHERE id=$1', [task.id, revision.id]);
    await pool.query(`INSERT INTO copy_approval_events(task_id,copy_revision_id,approval_mode,
      approved_by_account_id,approved_by_username,content_sha256) VALUES($1,$2,'MANUAL',$3,$4,$5)`,
    [task.id, revision.id, admin.id, admin.username, sha256(JSON.stringify(content))]);
  }
  const batch = (await pool.query(`INSERT INTO production_batches(public_id,query_package_name,status,sampling_status,
    created_by_account_id,created_by_username,request_id,request_fingerprint,client_batch_code)
    VALUES($1,$2,'FROZEN','FROZEN',$3,$4,$5,$6,$7) RETURNING id`,
  [randomUUID(), `分页验证 ${suffix}`, admin.id, admin.username, randomUUID(), sha256(suffix), randomUUID().replaceAll('-', '')])).rows[0];
  fixture.productionBatchId = Number(batch.id);
  const freeze = (await pool.query(`INSERT INTO image_sampling_freezes(public_id,production_batch_id,policy_version,
    rate_bps,seed,algorithm_version,blind_review_enabled,submitter_account_id,population_count,sample_count,
    snapshot_sha256,frozen_by_account_id,frozen_by_username,request_id,close_reason)
    VALUES($1,$2,1,10000,'scoped-test','scoped-test',false,$3,55,55,$4,$3,$5,$6,'SCOPED_TEST') RETURNING id`,
  [randomUUID(), batch.id, admin.id, sha256(suffix), admin.username, randomUUID()])).rows[0];
  fixture.freezeId = Number(freeze.id);
  const bytes = await sharp({ create: { width: 24, height: 32, channels: 3, background: '#3b82f6' } }).png().toBuffer();
  const imageTaskIds = fixture.imageTaskIds = [];
  for (let index = 1; index <= 55; index++) {
    const task = (await pool.query(`INSERT INTO tasks(query,created_by_node_id,state,current_stage,
      created_by_user_id,assigned_to_user_id,assigned_at,assignment_source,priority_mode,priority_paused,production_batch_id)
      VALUES($1,$2,'IMAGE_QC_PENDING','IMAGE_QC_PENDING',$3,$3,now(),'MANUAL','PAUSE',true,$4) RETURNING id`,
    [`图片分页 ${suffix} ${index}`, node.id, admin.username, batch.id])).rows[0];
    const taskId = Number(task.id); assert.ok(Number.isSafeInteger(taskId) && taskId > 0);
    taskIds.push(taskId); imageTaskIds.push(taskId);
    const revision = (await pool.query('INSERT INTO copy_revisions(task_id,revision,content) VALUES($1,1,$2) RETURNING id',
      [task.id, { copy: { title: `合成图片分页 ${index}`, body: '合成测试，未调用模型。', tags: [] }, imagePlan: [] }])).rows[0];
    const runId = randomUUID();
    await pool.query(`INSERT INTO image_runs(id,task_id,execution_id,copy_revision_id,status,result,finished_at,image_production_chain_id)
      VALUES($1,$2,NULL,$3,'COMPLETED','{"images":[]}',now(),$1)`, [runId, task.id, revision.id]);
    const directory = join(storageRoot, 'tasks', String(taskId), `scoped-${suffix}`);
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'synthetic.png'); await writeFile(path, bytes, { flag: 'wx' });
    const asset = (await pool.query(`INSERT INTO assets(task_id,image_run_id,media_type,byte_size,sha256,storage_path,original_name,
      image_production_chain_id,origin_image_run_id,artifact_key)
      VALUES($1,$2,'image/png',$3,$4,$5,'synthetic.png',$2,$2,'synthetic') RETURNING id`,
    [task.id, runId, bytes.length, sha256(bytes), path])).rows[0];
    await pool.query('UPDATE image_runs SET result=$2 WHERE id=$1', [runId, { images: [{ assetId: Number(asset.id), pageIndex: 1 }] }]);
    await pool.query('UPDATE tasks SET current_copy_revision_id=$2,current_image_run_id=$3 WHERE id=$1', [task.id, revision.id, runId]);
    const approval = (await pool.query(`INSERT INTO image_approval_events(task_id,copy_revision_id,image_run_id,
      submitted_by_account_id,submitted_by_username,review_session_id,image_set_sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [task.id, revision.id, runId, admin.id, admin.username, randomUUID(), sha256(bytes)])).rows[0];
    await pool.query(`INSERT INTO image_sampling_items(public_id,freeze_id,task_id,approval_event_id,
      copy_revision_id,image_run_id,image_set_sha256,submitter_account_id,submitter_username,rank_hash,
      selected,sample_kind,status,score_x10,reviewed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,'PASSED',30,now())`,
    [randomUUID(), freeze.id, task.id, approval.id, revision.id, runId, sha256(bytes), admin.id, admin.username,
      sha256(String(taskId)), index % 2 ? 'RANDOM' : 'MANDATORY_RECHECK']);
  }
  fixture.expectedSummary = { total: 55, mandatoryCount: 27, assetCount: 55 };
  return fixture;
}

export async function closeFollowupFixtures(pool, fixture, admin) {
  if (!fixture) return null;
  if (fixture.freezeId) await pool.query(`UPDATE image_sampling_items SET selected=false,status='SUPERSEDED'
    WHERE freeze_id=$1 AND submitter_account_id=$2 AND submitter_username=$3`, [fixture.freezeId, admin.id, admin.username]);
  if (fixture.freezeId) await pool.query(`UPDATE image_sampling_freezes SET status='CANCELLED',resolved_at=now()
    WHERE id=$1 AND submitter_account_id=$2`, [fixture.freezeId, admin.id]);
  if (!fixture.productionBatchId) return null;
  return (await pool.query(`UPDATE production_batches SET status='CANCELLED',sampling_status='CANCELLED',updated_at=now()
    WHERE id=$1 AND created_by_account_id=$2 RETURNING id,status`, [fixture.productionBatchId, admin.id])).rows[0];
}
