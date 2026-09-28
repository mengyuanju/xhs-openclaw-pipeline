import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { listDeliveryItems } from '../src/delivery-ledger.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { readTaskDataReport } from '../src/task-data-report.mjs';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';

const DAY = '2026-09-20';
const BOUNDARY_DAY = '2026-09-25';
const FIRST_REVIEW_AT = new Date('2026-09-01T12:00:00+08:00');
const NODE_ID = 'report-overview-node';

test('delivery overview uses ready dates with mutually exclusive current-version stages and frozen owners', {
  skip: process.env.RUN_POSTGRES_E2E !== '1', timeout: 180_000,
}, async t => {
  const database = await startTemporaryPostgres18();
  const repository = new PostgresControlPlaneRepository({ connectionString: database.connectionString });
  try {
    await repository.initialize();
    const db = repository.pool;
    await db.query('INSERT INTO executor_nodes(id,name) VALUES($1,$2)', [NODE_ID, '概览测试机']);
    const accounts = (await db.query(`INSERT INTO app_users(
      username,display_name,role,password_hash,status,copy_review_enabled,copy_qc_enabled,image_qc_enabled,created_at)
      VALUES('overview-admin','质检和打包管理员','ADMIN','test-only','ACTIVE',true,true,true,'2025-01-01'),
        ('overview-a','标注甲','USER','test-only','ACTIVE',true,false,false,'2025-01-01'),
        ('overview-b','标注乙','USER','test-only','ACTIVE',true,false,false,'2025-01-01'),
        ('overview-c','标注丙','USER','test-only','ACTIVE',true,false,false,'2025-01-01')
      RETURNING id,username,role,credential_version`)).rows;
    const [admin, a, b, c] = accounts.map(row => ({
      userId: Number(row.id), username: row.username, role: row.role,
      credentialVersion: Number(row.credential_version),
    }));
    const annotator = person => ({ field: 'ANNOTATOR', op: 'EQ', value: person.userId });

    const empty = await readTaskDataReport(db, admin, {
      time: { field: 'FIRST_COPY_REVIEW_ACTION', mode: 'ABSOLUTE', from: DAY, to: DAY },
    });
    assert.deepEqual(empty.poolOverview, {
      copyReviewPending: 0, copyReworkPending: 0, secondAssignmentPending: 0, copyQaPending: 0, imageGenerating: 0,
      imageReviewPending: 0, imageQaPending: 0, deliveryTotal: 0,
    }, 'an empty task pool returns zero for all eight global overview fields');

    async function version(task, approvedAt, qa = 'legacy') {
      await db.query(`UPDATE delivery_entries SET status='WITHDRAWN',withdrawn_at=$2
        WHERE task_id=$1 AND status='READY'`, [task.taskId, approvedAt]);
      const copyRevisionId = Number((await db.query(`INSERT INTO copy_revisions(
        task_id,revision,content,approved_at,approval_mode)
        SELECT $1,COALESCE(max(revision),0)+1,$2,$3,'MANUAL' FROM copy_revisions WHERE task_id=$1
        RETURNING id`, [task.taskId, { copy: { title: task.name, body: '冻结交付正文', tags: [] } },
        FIRST_REVIEW_AT])).rows[0].id);
      const imageRunId = randomUUID();
      await db.query(`INSERT INTO image_runs(
        id,task_id,copy_revision_id,status,result,image_production_chain_id)
        VALUES($1,$2,$3,'COMPLETED','{}',$1)`, [imageRunId, task.taskId, copyRevisionId]);
      let approvalEventId = null;
      if (qa === 'released') approvalEventId = Number((await db.query(`INSERT INTO image_approval_events(
        task_id,copy_revision_id,image_run_id,submitted_by_account_id,submitted_by_username,
        review_session_id,image_set_sha256,submitted_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [task.taskId, copyRevisionId, imageRunId, a.userId, a.username,
        randomUUID(), 'a'.repeat(64), approvedAt])).rows[0].id);
      await db.query(`UPDATE tasks SET current_copy_revision_id=$2,current_image_run_id=$3,
        state='REVIEWED',current_stage='REVIEWED',copy_qc_released_revision_id=$2 WHERE id=$1`,
      [task.taskId, copyRevisionId, imageRunId]);
      await db.query(`UPDATE tasks SET image_qc_legacy_accepted=$2,
        image_qc_released_approval_event_id=$3 WHERE id=$1`,
      [task.taskId, qa === 'legacy', approvalEventId]);
      const entryId = Number((await db.query(`INSERT INTO delivery_entries(
        task_id,copy_revision_id,image_run_id,approved_by_account_id,approved_by_username,approved_at)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [task.taskId, copyRevisionId, imageRunId, admin.userId, admin.username, approvedAt])).rows[0].id);
      return { ...task, copyRevisionId, imageRunId, entryId };
    }

    async function readyTask(name, { owner = a, readyAt = '2026-09-20T10:00:00+08:00',
      qa = 'legacy', input = {} } = {}) {
      const taskId = Number((await db.query(`INSERT INTO tasks(query,input,state,current_stage,
        created_by_node_id,created_by_user_id,assigned_to_user_id,assignment_source,assigned_at,created_at)
        VALUES($1,$2,'IMAGE_RUNNING','IMAGE_RUNNING',$3,$4,$4,'MANUAL',
          '2026-09-01T10:00:00+08:00','2026-08-01') RETURNING id`,
      [name, input, NODE_ID, owner.username])).rows[0].id);
      return version({ taskId, name }, readyAt, qa);
    }

    async function reassign(task, previous, target, assignedAt) {
      await db.query(`UPDATE tasks SET assigned_to_user_id=$2,assignment_source='MANUAL',
        assigned_at=$3 WHERE id=$1`, [task.taskId, target.username, assignedAt]);
      await db.query(`INSERT INTO task_assignment_events(task_id,actor_username,
        previous_assignee_user_id,assignee_user_id,source,created_at)
        VALUES($1,$2,$3,$4,'MANUAL',$5)`,
      [task.taskId, admin.username, previous.username, target.username, assignedAt]);
    }

    async function pack(task, packedAt, confirmedAt = null) {
      const publicId = randomUUID();
      const batchId = Number((await db.query(`INSERT INTO delivery_batches(
        public_id,code,scope,archive_file_name,archive_byte_size,archive_sha256,task_count,
        created_by_account_id,created_by_username,created_at)
        VALUES($1,$2,'SELECTED','fixture.zip',1,$3,1,$4,$5,$6) RETURNING id`,
      [publicId, 'JF-' + publicId.slice(0, 8).toUpperCase(), 'f'.repeat(64),
        admin.userId, admin.username, packedAt])).rows[0].id);
      const itemId = Number((await db.query(`INSERT INTO delivery_batch_items(
        delivery_batch_id,delivery_entry_id,ordinal,task_id,copy_revision_id,image_run_id,query_snapshot)
        VALUES($1,$2,1,$3,$4,$5,$6) RETURNING id`,
      [batchId, task.entryId, task.taskId, task.copyRevisionId, task.imageRunId, task.name])).rows[0].id);
      assert.ok((await db.query('SELECT account_id FROM delivery_item_owners WHERE item_id=$1',
        [itemId])).rows[0], 'the delivery item trigger must freeze the annotator owner');
      if (confirmedAt) await db.query(`INSERT INTO delivery_item_confirmations(
        item_id,actor_account_id,actor_username,confirmed_at,source)
        VALUES($1,$2,$3,$4,'ITEM')`, [itemId, a.userId, a.username, confirmedAt]);
      return itemId;
    }

    async function report(day = DAY, conditions = [], to = day) {
      return readTaskDataReport(db, admin, {
        time: { field: 'FIRST_COPY_REVIEW_ACTION', mode: 'ABSOLUTE', from: day, to },
        conditions,
      });
    }

    async function assertOverview(expected, day = DAY) {
      const result = await report(day);
      assert.deepEqual(result.overview, expected);
      assert.equal(result.total, 0, 'the detail list keeps its first COPY review date outside the query interval');
      assert.equal(result.summary.total, 0, 'overview delivery dates do not change the detail summary');
      assert.equal(result.summary.copyInitialReviewPending, 0,
        'the new detail initial review count still follows the first COPY review cohort');
      assert.equal(result.summary.copyReworkPending, 0);

      assert.equal(result.summary.packingDelivery, 0,
        'current delivery eligibility still uses first COPY review dates in the lower summary');
      const ledger = await listDeliveryItems(db, {
        view: 'CURRENT', dateField: 'READY', from: day, to: day,
      }, admin);
      assert.deepEqual({
        unpacked: ledger.summary.unpacked, packed: ledger.summary.packed, delivered: ledger.summary.delivered,
      }, expected, 'overview stages match the CURRENT delivery ledger filtered by ready dates');
    }

    const unpackedA = await readyTask('进入交付池后改派，仍归甲', {
      readyAt: '2026-09-20T08:00:00+08:00', qa: 'released',
    });
    await reassign(unpackedA, a, c, '2026-09-21T10:00:00+08:00');
    const unpackedEventB = await readyTask('进入交付池前历史事件改派给乙', {
      readyAt: '2026-09-20T10:00:00+08:00',
    });
    // A historical assignment event can be newer than the oldest assignment record.
    await db.query(`INSERT INTO task_assignment_events(task_id,actor_username,
      previous_assignee_user_id,assignee_user_id,source,created_at)
      VALUES($1,$2,$3,$4,'MANUAL','2026-09-20T09:00:00+08:00')`,
    [unpackedEventB.taskId, admin.username, a.username, b.username]);
    await reassign(unpackedEventB, a, c, '2026-09-21T11:00:00+08:00');
    const packedB = await readyTask('乙打包后改派给丙，仍待交付', {
      owner: b, readyAt: '2026-09-20T07:00:00+08:00',
    });
    await pack(packedB, '2026-09-20T12:00:00+08:00');
    await reassign(packedB, b, c, '2026-09-21T12:00:00+08:00');
    const deliveredB = await readyTask('同日进入池、打包和交付，只算已交付', {
      owner: b, readyAt: '2026-09-20T07:30:00+08:00',
    });
    await pack(deliveredB, '2026-09-20T09:30:00+08:00', '2026-09-20T13:00:00+08:00');
    await reassign(deliveredB, b, c, '2026-09-21T13:00:00+08:00');

    await t.test('the current tuple occupies one stage and uses its annotator at the relevant operation', async () => {
      await assertOverview({ unpacked: 2, packed: 1, delivered: 1 });
      assert.deepEqual((await report(DAY, [annotator(a)])).overview, { unpacked: 1, packed: 0, delivered: 0 });
      assert.deepEqual((await report(DAY, [annotator(b)])).overview, { unpacked: 1, packed: 1, delivered: 1 });
      assert.deepEqual((await report(DAY, [annotator(c)])).overview, { unpacked: 0, packed: 0, delivered: 0 },
        'a later reassignment does not change the operation-time owner');
      assert.deepEqual((await report(DAY, [annotator(admin)])).overview, { unpacked: 0, packed: 0, delivered: 0 },
        'the QA approver and packing operator are not the annotator owner');
    });

    await t.test('a later confirmation and an old delivered version cannot leave a task in multiple stages', async () => {
      const deliveredAfterRange = await readyTask('范围后才交付，仍归进入交付池当天', {
        owner: b, readyAt: '2026-09-20T14:00:00+08:00',
      });
      await pack(deliveredAfterRange, '2026-09-20T15:00:00+08:00', '2026-09-21T15:00:00+08:00');
      const oldDelivered = await readyTask('旧版本已交付，新版本未打包', {
        readyAt: '2026-09-19T10:00:00+08:00',
      });
      const oldItemId = await pack(oldDelivered, '2026-09-19T11:00:00+08:00', '2026-09-20T09:00:00+08:00');
      const newVersion = await version(oldDelivered, '2026-09-20T16:00:00+08:00');
      assert.notEqual(newVersion.copyRevisionId, oldDelivered.copyRevisionId);
      assert.ok((await db.query('SELECT item_id FROM delivery_item_confirmations WHERE item_id=$1',
        [oldItemId])).rows[0], 'the earlier confirmation remains in immutable history');
      await assertOverview({ unpacked: 3, packed: 1, delivered: 2 });
      assert.deepEqual((await report('2026-09-21')).overview, { unpacked: 0, packed: 0, delivered: 0 },
        'a later confirmation does not move the ready-date cohort to the confirmation day');
      assert.deepEqual((await report(DAY, [], '2026-09-21')).overview,
        { unpacked: 3, packed: 1, delivered: 2 }, 'each current tuple is counted once even when packing and confirmation span several days');
    });

    const invalidDetailTasks = [];
    let testRunTask;
    await t.test('withdrawn, cancelled, stale, test and ungated tuples are excluded from all overview stages', async () => {
      const withdrawn = await readyTask('已撤回交付版本');
      await pack(withdrawn, '2026-09-20T12:00:00+08:00');
      await db.query(`UPDATE delivery_entries SET status='WITHDRAWN',
        withdrawn_at='2026-09-22T10:00:00+08:00' WHERE id=$1`, [withdrawn.entryId]);
      const cancelled = await readyTask('交付过但当前已废弃', { owner: b });
      await pack(cancelled, '2026-09-20T12:00:00+08:00', '2026-09-20T13:00:00+08:00');
      await db.query(`UPDATE tasks SET state='CANCELLED',cancelled_from_state='REVIEWED',
        finished_at='2026-09-22T10:00:00+08:00',progress_message='任务已被人工废弃' WHERE id=$1`,
      [cancelled.taskId]);
      const staleCopy = await readyTask('文案版本与READY入口不匹配');
      const changedRevisionId = Number((await db.query(`INSERT INTO copy_revisions(
        task_id,revision,content,approved_at,approval_mode)
        VALUES($1,2,'{}',$2,'MANUAL') RETURNING id`, [staleCopy.taskId, FIRST_REVIEW_AT])).rows[0].id);
      await db.query('UPDATE tasks SET current_copy_revision_id=$2 WHERE id=$1',
        [staleCopy.taskId, changedRevisionId]);
      const staleImage = await readyTask('图片版本与READY入口不匹配');
      await pack(staleImage, '2026-09-20T12:00:00+08:00');
      const newRunId = randomUUID();
      await db.query(`INSERT INTO image_runs(id,task_id,copy_revision_id,status,image_production_chain_id)
        VALUES($1,$2,$3,'COMPLETED',$1)`, [newRunId, staleImage.taskId, staleImage.copyRevisionId]);
      await db.query('UPDATE tasks SET current_image_run_id=$2 WHERE id=$1', [staleImage.taskId, newRunId]);
      await db.query('UPDATE tasks SET image_qc_legacy_accepted=true WHERE id=$1', [staleImage.taskId]);
      const noQa = await readyTask('图片质检还未放行', { qa: 'none' });
      await pack(noQa, '2026-09-20T12:00:00+08:00', '2026-09-20T13:00:00+08:00');
      testRunTask = await readyTask('测试任务不进入真实交付数量', { input: { testRun: true } });
      const testWithdrawn = await readyTask('测试 #264 已撤回但状态REVIEWED', { input: { testRun: true } });
      await db.query(`UPDATE delivery_entries SET status='WITHDRAWN',
        withdrawn_at='2026-09-22T10:00:00+08:00' WHERE id=$1`, [testWithdrawn.entryId]);
      const noReady = await readyTask('没有READY交付入口');
      await db.query('DELETE FROM delivery_entries WHERE id=$1', [noReady.entryId]);
      const notReviewed = await readyTask('状态不是REVIEWED');
      await db.query("UPDATE tasks SET state='IMAGE_QC_PENDING' WHERE id=$1", [notReviewed.taskId]);
      invalidDetailTasks.push(withdrawn, cancelled, staleCopy, staleImage, noQa, noReady, notReviewed);
      await assertOverview({ unpacked: 3, packed: 1, delivered: 2 });
    });

    await t.test('upper and lower delivery counts share eligibility and differ only in their date basis', async () => {
      const readyPeriod = await report(DAY);
      assert.deepEqual(readyPeriod.overview, { unpacked: 3, packed: 1, delivered: 2 });
      assert.equal(readyPeriod.summary.packingDelivery, 0);
      const reviewPeriod = await report('2026-09-01');
      assert.deepEqual(reviewPeriod.overview, { unpacked: 0, packed: 0, delivered: 0 });
      assert.equal(reviewPeriod.summary.packingDelivery, 6);
      const wide = await report('2026-09-01', [], '2026-09-22');
      assert.equal(wide.total, 13, 'testRun tasks are omitted while ordinary non-deliverable tasks remain');
      assert.equal(wide.summary.packingDelivery, 6);
      assert.equal(wide.overview.unpacked + wide.overview.packed + wide.overview.delivered,
        wide.summary.packingDelivery);
      assert.equal(wide.summary.delivered, 2,
        'a historical confirmation for the old version does not mark the new unpacked version delivered');
      assert.equal(wide.summary.discarded, 1, 'normal discarded tasks remain in the detail statistics');
      assert.equal(wide.summary.qaPending, 1, 'normal pending QA tasks remain in the detail statistics');
      for (const fixture of invalidDetailTasks) assert.ok(wide.items.some(item => item.taskId === fixture.taskId),
        'non-delivery eligibility must not hide ordinary detail tasks');
      assert.equal(wide.items.some(item => item.taskId === testRunTask.taskId), false);
      assert.equal(wide.items.some(item => item.taskName.startsWith('测试')), false);
    });

    await t.test('all current stages use the ready timestamp with inclusive Beijing days', async () => {
      for (const stage of ['unpacked', 'packed', 'delivered']) {
        for (const [label, readyAt] of [
          ['起点', '2026-09-25T00:00:00+08:00'],
          ['当日末尾', '2026-09-25T23:59:59.999+08:00'],
          ['起点之前', '2026-09-24T23:59:59.999+08:00'],
          ['结束之后', '2026-09-26T00:00:00+08:00'],
        ]) {
          const task = await readyTask(stage + ' ' + label, { readyAt });
          if (stage === 'packed') await pack(task, '2026-09-27T10:00:00+08:00');
          if (stage === 'delivered') await pack(task, '2026-09-27T11:00:00+08:00',
            '2026-09-28T12:00:00+08:00');
        }
      }
      await assertOverview({ unpacked: 2, packed: 2, delivered: 2 }, BOUNDARY_DAY);
    });

    await t.test('only dates and annotator conditions change the fixed overview', async () => {
      const extraConditions = [
        { field: 'STATE', op: 'EQ', value: 'IMAGE_FAILED' },
        { field: 'TASK_ID_OR_NAME', op: 'CONTAINS', value: 'definitely-no-matching-task' },
        { field: 'REJECTION_COUNT', op: 'GTE', value: 99 },
        { field: 'REASSIGNMENT_COUNT', op: 'GTE', value: 99 },
        { field: 'COPY_QA_REVIEWER', op: 'EQ', value: admin.userId },
        { field: 'IMAGE_QA_REVIEWER', op: 'EQ', value: admin.userId },
      ];
      const result = await report(DAY, extraConditions);
      assert.equal(result.total, 0);
      assert.equal(result.summary.total, 0);
      assert.deepEqual(result.overview, { unpacked: 3, packed: 1, delivered: 2 });
      assert.deepEqual((await report(DAY, [annotator(a), ...extraConditions])).overview,
        { unpacked: 2, packed: 0, delivered: 0 });
      assert.deepEqual((await report(DAY, [annotator(b), ...extraConditions])).overview,
        { unpacked: 1, packed: 1, delivered: 2 });
    });
    await t.test('pool overview is global, excludes future tasks and shares the report snapshot', async () => {
      const baseline = await report();
      assert.deepEqual(baseline.poolOverview, {
        copyReviewPending: 0, copyReworkPending: 0, secondAssignmentPending: 0, copyQaPending: 0, imageGenerating: 0,
        imageReviewPending: 0, imageQaPending: 1, deliveryTotal: 18,
      }, 'only valid current deliveries and the existing pending QA task occupy the global pool');
      const currentLedger = await listDeliveryItems(db, { view: 'CURRENT' }, admin);
      assert.equal(currentLedger.summary.total, 18);
      assert.equal(currentLedger.summary.unpacked + currentLedger.summary.packed + currentLedger.summary.delivered,
        baseline.poolOverview.deliveryTotal, 'the global delivery total shares CURRENT ledger eligibility');
      const allStates = [
        'COPY_REVIEW_PENDING', 'PENDING_SECOND_ASSIGNMENT', 'COPY_QC_PENDING',
        'IMAGE_QUEUED', 'IMAGE_RUNNING', 'MANUAL_ARCHIVE', 'IMAGE_REWORK_PENDING', 'IMAGE_QC_PENDING',
        'REVIEWED', 'CANCELLED', 'COPY_QUEUED', 'COPY_RUNNING', 'COPY_FAILED', 'IMAGE_FAILED',
      ];
      const poolStates = allStates.slice(0, 8);
      async function poolTask(state, { testRun = false, future = false, taskKind = 'CONTENT',
        owner = null, rework = false, mandatoryOrigin = null } = {}) {
        return (await db.query(`INSERT INTO tasks(query,input,state,current_stage,created_by_node_id,
          task_kind,created_at,assigned_to_user_id,assignment_source,assigned_at,copy_qa_rework_pending,
          mandatory_copy_qc,mandatory_copy_qc_origin)
          VALUES($1,$2,$3::text,$3::text,$4,$5,
            clock_timestamp()+CASE WHEN $6::boolean THEN interval '1 day' ELSE interval '-1 second' END,
            $7::varchar,CASE WHEN $7::varchar IS NOT NULL THEN 'MANUAL' END,
            CASE WHEN $7::varchar IS NOT NULL THEN clock_timestamp()-interval '1 second' END,$8,$9,$10)
          RETURNING id,created_at,assigned_to_user_id,copy_qa_rework_pending,
            mandatory_copy_qc,mandatory_copy_qc_origin`,
        ['全池回归 ' + state, { testRun }, state, NODE_ID, taskKind, future, owner?.username ?? null,
          rework, mandatoryOrigin !== null, mandatoryOrigin])).rows[0];
      }
      async function firstCopyReview(fixture, owner, currentOrigin = null) {
        const reviewedRevisionId = Number((await db.query(`INSERT INTO copy_revisions(task_id,revision,content,
          revision_origin,approved_at,approval_mode)
          VALUES($1,1,'{}','GENERATION',clock_timestamp()-interval '500 milliseconds','MANUAL') RETURNING id`,
        [fixture.id])).rows[0].id);
        await db.query(`INSERT INTO copy_approval_events(task_id,copy_revision_id,approval_mode,
          approved_by_account_id,approved_by_username,content_sha256,approved_at)
          VALUES($1,$2,'MANUAL',$3,$4,$5,clock_timestamp()-interval '400 milliseconds')`,
        [fixture.id, reviewedRevisionId, owner.userId, owner.username, 'b'.repeat(64)]);
        let currentRevisionId = reviewedRevisionId;
        if (currentOrigin) currentRevisionId = Number((await db.query(`INSERT INTO copy_revisions(task_id,
          revision,content,parent_revision_id,revision_origin)
          VALUES($1,2,'{}',$2,$3) RETURNING id`, [fixture.id, reviewedRevisionId, currentOrigin])).rows[0].id);
        await db.query('UPDATE tasks SET current_copy_revision_id=$2 WHERE id=$1',
          [fixture.id, currentRevisionId]);
      }
      const normalRows = [];
      for (const state of allStates) normalRows.push(await poolTask(state));
      const unassignedOnly = await report();
      assert.equal(unassignedOnly.poolOverview.copyReviewPending, 0,
        'an unassigned COPY_REVIEW_PENDING task is not work waiting for an annotator to review');
      assert.equal(unassignedOnly.poolOverview.secondAssignmentPending, 1,
        'PENDING_SECOND_ASSIGNMENT occupies its own pool stage instead of the COPY review count');
      const assignedFirstReview = await poolTask('COPY_REVIEW_PENDING', { owner: a });
      const assignedRework = await poolTask('COPY_REVIEW_PENDING', { owner: b, rework: true });
      await firstCopyReview(assignedRework, b, 'QA_RETURN');
      normalRows.push(assignedFirstReview, assignedRework);
      assert.equal(assignedFirstReview.assigned_to_user_id, a.username);
      assert.equal(assignedRework.copy_qa_rework_pending, true);
      const firstAndRework = await report();
      assert.equal(firstAndRework.poolOverview.copyReviewPending, 1);
      assert.equal(firstAndRework.poolOverview.copyReworkPending, 1,
        'a QA return needs real historical COPY review evidence rather than a flag alone');
      const reassignedRound = await poolTask('COPY_REVIEW_PENDING', { owner: b, mandatoryOrigin: 'SECOND_ASSIGNMENT' });
      await firstCopyReview(reassignedRound, b, 'SECOND_ASSIGNMENT_RESET');
      const restoredRound = await poolTask('COPY_REVIEW_PENDING', { owner: a, mandatoryOrigin: 'DISCARD_RESTORE' });
      await firstCopyReview(restoredRound, a, 'DISCARD_RESTORE');
      const legacyQaReturn = await poolTask('COPY_REVIEW_PENDING', { owner: a, mandatoryOrigin: 'QA_RETURN' });
      await firstCopyReview(legacyQaReturn, a, 'QA_RETURN');
      const finalReviewReturn = await poolTask('COPY_REVIEW_PENDING', { owner: b, mandatoryOrigin: 'FINAL_REWORK' });
      await firstCopyReview(finalReviewReturn, b, 'FINAL_REWORK');
      normalRows.push(reassignedRound, restoredRound, legacyQaReturn, finalReviewReturn);
      for (const flags of [{ rework: true }, { mandatoryOrigin: 'QA_RETURN' }]) {
        normalRows.push(await poolTask('COPY_REVIEW_PENDING', { owner: a, ...flags }));
      }
      const classifiedRounds = await report();
      assert.equal(classifiedRounds.poolOverview.copyReviewPending, 4,
        'second assignment, restored and FINAL_REWORK rounds without active COPY QA return remain pending review');
      assert.equal(classifiedRounds.poolOverview.copyReworkPending, 2,
        'current and legacy COPY QA returns need first review evidence; FINAL_REWORK alone is not COPY QA rework');
      for (const state of allStates) await poolTask(state, { testRun: true });
      await poolTask('COPY_REVIEW_PENDING', { testRun: true, owner: a });
      const testRework = await poolTask('COPY_REVIEW_PENDING', { testRun: true, owner: b, rework: true });
      await firstCopyReview(testRework, b, 'QA_RETURN');
      const futureRows = [];
      for (const state of poolStates) futureRows.push(await poolTask(state, { future: true }));
      futureRows.push(await poolTask('COPY_REVIEW_PENDING', { future: true, owner: a }));
      const futureReady = await readyTask('未来创建但有有效READY交付入口');
      futureRows.push((await db.query(`UPDATE tasks SET created_at=clock_timestamp()+interval '1 day'
        WHERE id=$1 RETURNING id,created_at`, [futureReady.taskId])).rows[0]);
      assert.equal((await listDeliveryItems(db, { view: 'CURRENT' }, admin)).summary.total, 19,
        'the future task qualifies as a current delivery before the report snapshot cutoff is applied');
      await poolTask('MANUAL_ARCHIVE', { taskKind: 'STANDALONE_IMAGE_EDIT' });
      const expected = {
        copyReviewPending: 4, copyReworkPending: 2, secondAssignmentPending: 1, copyQaPending: 1, imageGenerating: 2,
        imageReviewPending: 2, imageQaPending: 2, deliveryTotal: 18,
      };
      const input = {
        time: { field: 'FIRST_COPY_REVIEW_ACTION', mode: 'ABSOLUTE', from: DAY, to: DAY },
      };
      const reference = await readTaskDataReport(db, admin, input, { now: new Date('2040-01-01T00:00:00Z') });
      assert.deepEqual(reference.poolOverview, expected,
        'current review rounds and proven active QA returns occupy separate pool stages');
      assert.equal(reference.summary.copyInitialReviewPending, 0,
        'global current review rounds do not enter details outside their first review dates');
      assert.equal(reference.summary.copyReworkPending, 0);

      assert.deepEqual(Object.keys(reference.poolOverview).sort(), Object.keys(expected).sort(),
        'the eight-field pool overview exposes rework and second assignment without a task-pool total');
      for (const row of normalRows) assert.ok(row.created_at <= new Date(reference.asOf),
        'ordinary pool tasks were created by the response snapshot cutoff');
      for (const row of futureRows) assert.ok(row.created_at > new Date(reference.asOf),
        'future task creation is compared with DB asOf, not the caller-provided future now');
      const conditions = [
        annotator(admin),
        { field: 'STATE', op: 'EQ', value: 'IMAGE_FAILED' },
        { field: 'TASK_ID_OR_NAME', op: 'CONTAINS', value: 'definitely-no-matching-task' },
        { field: 'REJECTION_COUNT', op: 'GTE', value: 99 },
        { field: 'REASSIGNMENT_COUNT', op: 'GTE', value: 99 },
        { field: 'COPY_QA_REVIEWER', op: 'EQ', value: admin.userId },
        { field: 'IMAGE_QA_REVIEWER', op: 'EQ', value: admin.userId },
      ];
      const filtered = await readTaskDataReport(db, admin, {
        time: { field: 'CREATED_AT', mode: 'ABSOLUTE', from: '1999-01-01', to: '1999-01-01' },
        conditions,
      });
      assert.equal(filtered.total, 0);
      assert.deepEqual(filtered.poolOverview, expected,
        'date, time dimension, annotator, status and advanced report filters do not change the full pool');

      let insertedAfterSnapshot = null;
      let readyAfterSnapshot = null;
      const concurrentPool = {
        async connect() {
          const client = await db.connect();
          return {
            async query(sql, params) {
              const result = await client.query(sql, params);
              if (sql === 'SELECT clock_timestamp() AS at' && insertedAfterSnapshot === null) {
                const createdAt = new Date(new Date(result.rows[0].at).getTime() - 1000);
                insertedAfterSnapshot = (await db.query(`INSERT INTO tasks(query,input,state,current_stage,
                  created_by_node_id,created_at) VALUES('快照之后并发新任务','{}','COPY_QC_PENDING',
                    'COPY_QC_PENDING',$1,$2) RETURNING id,created_at`, [NODE_ID, createdAt])).rows[0];
                readyAfterSnapshot = await readyTask('快照之后并发新增有效交付任务');
                readyAfterSnapshot.createdAt = (await db.query('SELECT created_at FROM tasks WHERE id=$1',
                  [readyAfterSnapshot.taskId])).rows[0].created_at;
              }
              return result;
            },
            release() { client.release(); },
          };
        },
      };
      const sameSnapshot = await readTaskDataReport(concurrentPool, admin, input);
      assert.ok(insertedAfterSnapshot, 'a real separate DB connection committed the concurrent task');
      assert.ok(insertedAfterSnapshot.created_at <= new Date(sameSnapshot.asOf),
        'the concurrent row passes the timestamp predicate and can only be excluded by snapshot isolation');
      assert.ok(readyAfterSnapshot?.createdAt <= new Date(sameSnapshot.asOf),
        'the concurrent READY task also passes the cutoff but is excluded by the shared report snapshot');
      assert.deepEqual(sameSnapshot.poolOverview, expected,
        'pool statistics use the same repeatable-read snapshot as the report asOf');
      const nextSnapshot = await readTaskDataReport(db, admin, input);
      assert.deepEqual(nextSnapshot.poolOverview, {
        ...expected, copyQaPending: expected.copyQaPending + 1, deliveryTotal: expected.deliveryTotal + 1,
      }, 'the subsequent report includes both committed tasks in its new snapshot');
    });

    await t.test('later packing and confirmation never move delivery additions away from their ready day', async () => {
      const earlierPacked = await readyTask('较早入池、后来打包仍按入池日期', {
        owner: a, readyAt: '2026-09-10T08:00:00+08:00',
      });
      await reassign(earlierPacked, a, b, '2026-09-10T12:00:00+08:00');
      await pack(earlierPacked, '2026-09-11T10:00:00+08:00');
      await reassign(earlierPacked, b, c, '2026-09-12T10:00:00+08:00');
      const earlierDelivered = await readyTask('较早入池、后来确认仍按入池日期', {
        owner: b, readyAt: '2026-09-10T09:00:00+08:00',
      });
      await pack(earlierDelivered, '2026-09-10T11:00:00+08:00', '2026-09-11T11:00:00+08:00');
      const laterDelivered = await readyTask('当天入池、以后打包交付仍归进入池当天', {
        owner: b, readyAt: '2026-09-12T08:00:00+08:00',
      });
      await pack(laterDelivered, '2026-09-13T10:00:00+08:00', '2026-09-14T11:00:00+08:00');

      await assertOverview({ unpacked: 0, packed: 1, delivered: 1 }, '2026-09-10');
      await assertOverview({ unpacked: 0, packed: 0, delivered: 0 }, '2026-09-11');
      await assertOverview({ unpacked: 0, packed: 0, delivered: 1 }, '2026-09-12');
      await assertOverview({ unpacked: 0, packed: 0, delivered: 0 }, '2026-09-13');
      await assertOverview({ unpacked: 0, packed: 0, delivered: 0 }, '2026-09-14');
      assert.deepEqual((await report('2026-09-10', [annotator(b)])).overview,
        { unpacked: 0, packed: 1, delivered: 1 },
        'ready-date filtering preserves the annotator snapshot taken when the content was packed');
      for (const person of [a, c]) assert.deepEqual((await report('2026-09-10', [annotator(person)])).overview,
        { unpacked: 0, packed: 0, delivered: 0 },
        'neither the pre-packing nor the later assignee replaces the frozen packed owner');
    });
  } finally {
    await repository.close();
    await database.stop();
  }
});
