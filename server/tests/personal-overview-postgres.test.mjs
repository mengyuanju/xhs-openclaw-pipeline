import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { listDeliveryItems } from '../src/delivery-ledger.mjs';
import { readPersonalWorkspace } from '../src/personal-workspace.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';

const NODE_ID = 'personal-overview-test';
const OLD_READY_AT = '2026-09-01T10:00:00+08:00';

test('personal overview reads the real current pending pool and actual today pass events for every role', {
  skip: process.env.RUN_PERSONAL_WORKSPACE_POSTGRES !== '1', timeout: 180_000,
}, async t => {
  const database = await startTemporaryPostgres18();
  const repository = new PostgresControlPlaneRepository({ connectionString: database.connectionString });
  try {
    await repository.initialize();
    const db = repository.pool;
    await db.query('INSERT INTO executor_nodes(id,name) VALUES($1,$2)', [NODE_ID, '个人概览测试']);
    const users = (await db.query(`INSERT INTO app_users(username,display_name,role,password_hash,status,created_at)
      VALUES ('personal-overview-a','标注甲','USER','fixture','ACTIVE','2025-01-01'),
        ('personal-overview-b','标注乙','USER','fixture','ACTIVE','2025-01-01'),
        ('personal-overview-admin','管理员','ADMIN','fixture','ACTIVE','2025-01-01'),
        ('personal-overview-qa','质检员','REVIEWER','fixture','ACTIVE','2025-01-01')
      RETURNING id,username,role`)).rows;
    const [a, b, admin, reviewer] = users.map(row => ({ userId: Number(row.id), username: row.username, role: row.role }));

    async function readyTask(name, { owner = a, gate = 'legacy', input = {} } = {}) {
      const taskId = Number((await db.query(`INSERT INTO tasks(query,input,state,current_stage,
        created_by_node_id,created_by_user_id,assigned_to_user_id,assignment_source,assigned_at,created_at)
        VALUES($1,$2,'IMAGE_RUNNING','IMAGE_RUNNING',$3,$4,$4,'MANUAL',
          '2026-09-01T10:00:00+08:00','2026-08-01') RETURNING id`, [name, input, NODE_ID, owner.username])).rows[0].id);
      const copyRevisionId = Number((await db.query(`INSERT INTO copy_revisions(task_id,revision,content)
        VALUES($1,1,'{}') RETURNING id`, [taskId])).rows[0].id);
      const imageRunId = randomUUID();
      await db.query(`INSERT INTO image_runs(id,task_id,copy_revision_id,status,result,image_production_chain_id)
        VALUES($1,$2,$3,'COMPLETED','{}',$1)`, [imageRunId, taskId, copyRevisionId]);
      let approvalId = null;
      if (gate === 'released') approvalId = Number((await db.query(`INSERT INTO image_approval_events(
        task_id,copy_revision_id,image_run_id,submitted_by_account_id,submitted_by_username,
        review_session_id,image_set_sha256,submitted_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [taskId, copyRevisionId, imageRunId, owner.userId, owner.username, randomUUID(), 'a'.repeat(64), OLD_READY_AT])).rows[0].id);
      await db.query(`UPDATE tasks SET state='REVIEWED',current_stage='REVIEWED',
        current_copy_revision_id=$2,current_image_run_id=$3 WHERE id=$1`, [taskId, copyRevisionId, imageRunId]);
      await db.query(`UPDATE tasks SET image_qc_legacy_accepted=$2,image_qc_released_approval_event_id=$3 WHERE id=$1`,
        [taskId, gate === 'legacy', approvalId]);
      const entryId = Number((await db.query(`INSERT INTO delivery_entries(
        task_id,copy_revision_id,image_run_id,status,approved_by_account_id,approved_by_username,approved_at)
        VALUES($1,$2,$3,'READY',$4,$5,$6) RETURNING id`,
      [taskId, copyRevisionId, imageRunId, admin.userId, admin.username, OLD_READY_AT])).rows[0].id);
      return { taskId, copyRevisionId, imageRunId, entryId, name };
    }

    async function pack(task, confirmed = false) {
      const publicId = randomUUID();
      const batchId = Number((await db.query(`INSERT INTO delivery_batches(public_id,code,scope,
        archive_file_name,archive_byte_size,archive_sha256,task_count,created_by_account_id,created_by_username,created_at)
        VALUES($1,$2,'SELECTED','fixture.zip',1,$3,1,$4,$5,$6) RETURNING id`,
      [publicId, 'JF-' + publicId.slice(0, 8).toUpperCase(), 'f'.repeat(64), admin.userId, admin.username, OLD_READY_AT])).rows[0].id);
      const itemId = Number((await db.query(`INSERT INTO delivery_batch_items(delivery_batch_id,delivery_entry_id,
        ordinal,task_id,copy_revision_id,image_run_id,query_snapshot)
        VALUES($1,$2,1,$3,$4,$5,$6) RETURNING id`,
      [batchId, task.entryId, task.taskId, task.copyRevisionId, task.imageRunId, task.name])).rows[0].id);
      if (confirmed) await db.query(`INSERT INTO delivery_item_confirmations(item_id,actor_account_id,
        actor_username,confirmed_at,source) VALUES($1,$2,$3,$4,'ITEM')`,
      [itemId, admin.userId, admin.username, OLD_READY_AT]);
    }

    const unpacked = await readyTask('上月入池，今天仍可交付');
    await pack(await readyTask('上月打包，今天待交付'));
    await readyTask('已通过正式图片质量门禁', { gate: 'released' });
    await pack(await readyTask('已确认交付'), true);
    const withdrawn = await readyTask('已撤回');
    await db.query("UPDATE delivery_entries SET status='WITHDRAWN',withdrawn_at=now() WHERE id=$1", [withdrawn.entryId]);
    const noEntry = await readyTask('无入池记录');
    await db.query('DELETE FROM delivery_entries WHERE id=$1', [noEntry.entryId]);
    await readyTask('缺少图片质量门禁', { gate: 'none' });
    await readyTask('测试作业', { input: { testRun: true } });
    const notReviewed = await readyTask('状态已回到待审核');
    await db.query("UPDATE tasks SET state='MANUAL_ARCHIVE' WHERE id=$1", [notReviewed.taskId]);
    const staleCopy = await readyTask('文案版本已更新');
    const nextCopyId = Number((await db.query("INSERT INTO copy_revisions(task_id,revision,content) VALUES($1,2,'{}') RETURNING id",
      [staleCopy.taskId])).rows[0].id);
    await db.query('UPDATE tasks SET current_copy_revision_id=$2 WHERE id=$1', [staleCopy.taskId, nextCopyId]);
    await db.query('UPDATE tasks SET image_qc_legacy_accepted=true WHERE id=$1', [staleCopy.taskId]);
    const staleImage = await readyTask('图片批次已更新'), nextRunId = randomUUID();
    await db.query(`INSERT INTO image_runs(id,task_id,copy_revision_id,status,result,image_production_chain_id)
      VALUES($1,$2,$3,'COMPLETED','{}',$1)`, [nextRunId, staleImage.taskId, staleImage.copyRevisionId]);
    await db.query('UPDATE tasks SET current_image_run_id=$2 WHERE id=$1', [staleImage.taskId, nextRunId]);
    await db.query('UPDATE tasks SET image_qc_legacy_accepted=true WHERE id=$1', [staleImage.taskId]);
    await readyTask('其他标注人员的交付池', { owner: b });
    await readyTask('管理员自己的交付池', { owner: admin });
    const reassigned = await readyTask('后来改派给乙');
    await db.query(`UPDATE tasks SET assigned_to_user_id=$2,assigned_at='2026-09-20T00:00:00+08:00' WHERE id=$1`,
      [reassigned.taskId, b.username]);

    async function fact(key, stage, action, at, account = a, extra = {}) {
      await db.query(`INSERT INTO account_quality_events(event_key,task_id,stage,account_id,action,
        establishes_sample,occurred_at,data) VALUES($1,$2,$3,$4,$5,true,$6,$7)`,
      [key, unpacked.taskId, stage, account.userId, action, at, { reviewerId: reviewer.userId, ...extra }]);
    }
    await fact('overview-yesterday-pass', 'COPY', 'PASS', '2026-09-28T15:59:59.999Z');
    await fact('overview-copy-first-pass', 'COPY', 'PASS', '2026-09-28T16:00:00Z');
    await fact('overview-copy-return', 'COPY', 'RETURN', '2026-09-29T01:00:00Z');
    await fact('overview-copy-rework-pass', 'COPY', 'PASS', '2026-09-29T02:00:00Z', a, { sampleKind: 'MANDATORY_RECHECK' });
    await fact('overview-copy-repeat-pass', 'COPY', 'PASS', '2026-09-29T03:00:00Z');
    await fact('overview-image-pass', 'IMAGE', 'PASS', '2026-09-29T04:00:00Z');
    await fact('overview-image-return', 'IMAGE', 'RETURN', '2026-09-29T04:30:00Z');
    await fact('overview-tomorrow-pass', 'IMAGE', 'PASS', '2026-09-29T16:00:00Z');
    await fact('overview-other-annotator-pass', 'COPY', 'PASS', '2026-09-29T03:00:00Z', b);
    await db.query(`INSERT INTO quality_review_activity_events(event_key,account_id,task_id,stage,kind,occurred_at,data)
      VALUES('overview-qa-actual',$1,$2,'COPY','QA_REVIEW','2026-09-29T03:00:00Z','{"outcome":"PASS"}')`,
    [reviewer.userId, unpacked.taskId]);
    await db.query(`INSERT INTO quality_review_coverage_events(event_key,account_id,task_id,stage,
      kind,review_item_key,operation_key,occurred_at,data)
      VALUES('overview-qa-auto-release',$1,$2,'IMAGE','BATCH_RELEASE','fixture-image-item',
        'fixture-release','2026-09-29T03:30:00Z','{"affectedCount":999}')`,
    [a.userId, unpacked.taskId]);

    let current = Date.parse('2026-09-29T15:59:59.999Z');
    t.mock.method(Date, 'now', () => current);
    const overview = person => readPersonalWorkspace(db, person, { section: 'overview', period: 'custom',
      from: '2026-08-01', to: '2026-08-01', personalScope: 'CREATED' }, { report: true });
    const mine = await overview(a);
    assert.equal(mine.delivery.ready, 3, 'old ready entries, unpacked and packed, remain pending');
    assert.deepEqual(mine.passed, { COPY: 3, IMAGE: 1 }, 'every pass verdict belongs to its actual annotation account');
    assert.deepEqual(mine.range, { from: '2026-09-29', to: '2026-09-29' });
    assert.equal((await overview(b)).delivery.ready, 2, 'current assignments include reassigned pool work');
    const adminOverview = await overview(admin);
    assert.equal(adminOverview.delivery.ready, 1, 'administrator card never counts the global pool');
    assert.deepEqual(adminOverview.passed, { COPY: 0, IMAGE: 0 });
    const qaOverview = await overview(reviewer);
    assert.equal(qaOverview.delivery.ready, 0);
    assert.equal(qaOverview.delivery.href, null);
    assert.deepEqual(qaOverview.passed, { COPY: 0, IMAGE: 0 }, 'QA operator pass/release activity is not annotation success');
    const personalLedger = await listDeliveryItems(db, { view: 'CURRENT', state: 'PENDING' }, a);
    assert.equal(mine.delivery.ready, new Set(personalLedger.items.map(item => item.taskId)).size);
    const globalLedger = await listDeliveryItems(db, { view: 'CURRENT', state: 'PENDING' }, admin);
    assert.equal(globalLedger.total, 6, 'global administrator ledger demonstrates role separation');
    current++;
    const nextDay = await overview(a);
    assert.deepEqual(nextDay.range, { from: '2026-09-30', to: '2026-09-30' });
    assert.deepEqual(nextDay.passed, { COPY: 0, IMAGE: 1 });
    assert.equal(nextDay.delivery.ready, 3);
  } finally {
    await repository.close();
    await database.stop();
  }
});
