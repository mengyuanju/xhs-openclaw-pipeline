import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { buildAnnotationJobReport } from '../../src/annotation-job-report.mjs';
import { readAnnotationAssignmentReport } from '../src/annotation-assignment-report.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { recordQualityReviewCoverage } from '../src/quality-review-coverage.mjs';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';

const DAY = '2026-09-20';
const at = (day, clock = '09:00:00') => new Date(day + 'T' + clock + '+08:00').toISOString();
const SUBMITTED_AT = at(DAY);
const RELEASED_AT = at('2026-09-21', '12:00:00');
const AS_OF = at('2026-09-22', '23:59:59');
const SHA = 'a'.repeat(64);

test('first COPY pass includes completed unsampled releases for the exact first approval', {
  skip: process.env.RUN_POSTGRES_E2E !== '1', timeout: 180_000,
}, async (t) => {
  const database = await startTemporaryPostgres18();
  const repository = new PostgresControlPlaneRepository({ connectionString: database.connectionString });
  try {
    await repository.initialize();
    const db = repository.pool;
    await db.query("INSERT INTO executor_nodes(id,name) VALUES('first-copy-pass-node','First COPY Pass')");
    const accounts = (await db.query(`INSERT INTO app_users(
      username,display_name,role,password_hash,status,created_at)
      VALUES('first-copy-pass-admin','管理员','ADMIN','test-only','ACTIVE','2025-01-01'),
        ('first-copy-pass-worker','标注人','USER','test-only','ACTIVE','2025-01-01'),
        ('first-copy-pass-qa','质检人','REVIEWER','test-only','ACTIVE','2025-01-01')
      RETURNING id,username,display_name`)).rows;
    const [admin, worker, qa] = accounts.map(row => ({
      userId: Number(row.id), username: row.username, displayName: row.display_name,
    }));

    async function submit(fixture, { number = 1, parentId = null, submittedAt = SUBMITTED_AT } = {}) {
      const revisionId = Number((await db.query(`INSERT INTO copy_revisions(task_id,revision,
        content,parent_revision_id,revision_origin,approved_at,approval_mode)
        VALUES($1,$2,$3,$4,$5,$6,'MANUAL') RETURNING id`,
      [fixture.taskId, number, { copy: { title: '首次通过测试', body: '正文', tags: [] }, imagePlan: [] },
        parentId, number === 1 ? 'GENERATION' : 'QA_RETURN', submittedAt])).rows[0].id);
      await db.query('UPDATE tasks SET current_copy_revision_id=$2 WHERE id=$1', [fixture.taskId, revisionId]);
      const approvalId = Number((await db.query(`INSERT INTO copy_approval_events(task_id,
        copy_revision_id,approval_mode,approved_by_account_id,approved_by_username,content_sha256,approved_at)
        VALUES($1,$2,'MANUAL',$3,$4,$5,$6) RETURNING id`,
      [fixture.taskId, revisionId, worker.userId, worker.username, SHA, submittedAt])).rows[0].id);
      return { ...fixture, revisionId, approvalId, submittedAt };
    }

    async function task(name) {
      const assignedAt = at('2026-09-19');
      const taskId = Number((await db.query(`INSERT INTO tasks(query,input,state,created_by_node_id,
        assigned_to_user_id,assignment_source,assigned_at,created_at)
        VALUES($1,'{}','COPY_QC_PENDING','first-copy-pass-node',$2,'MANUAL',$3,$3) RETURNING id`,
      [name, worker.username, assignedAt])).rows[0].id);
      await db.query(`INSERT INTO task_assignment_events(task_id,actor_username,
        previous_assignee_user_id,assignee_user_id,source,created_at)
        VALUES($1,$2,NULL,$3,'MANUAL',$4)`, [taskId, admin.username, worker.username, assignedAt]);
      return submit({ taskId });
    }

    async function v2(fixture, { status = 'RELEASED', selected = false,
      batchStatus = 'COMPLETED', completedAt = RELEASED_AT, decidedAt = null } = {}) {
      const batchId = Number((await db.query(`INSERT INTO copy_qa_batches_v2(mode,
        full_inspection,blind_review_enabled,sampling_rate_bps,return_threshold_bps,return_trigger_count,
        member_count,sample_count,status,created_by_account_id,created_at,completed_at)
        VALUES('MIXED_MANUAL',false,false,5000,5000,1,1,$1,$2,$3,$4,$5) RETURNING id`,
      [selected ? 1 : 0, batchStatus, admin.userId, at(DAY, '09:05:00'), completedAt])).rows[0].id);
      const memberId = Number((await db.query(`INSERT INTO copy_qa_batch_members_v2(batch_id,
        task_id,copy_revision_id,approval_event_id,approver_account_id,quality_cycle,content_sha256,
        selected,status,reviewed_by_account_id,decided_at,created_at)
        VALUES($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [batchId, fixture.taskId, fixture.revisionId, fixture.approvalId, worker.userId, SHA, selected,
        status, decidedAt === null ? null : qa.userId, decidedAt, at(DAY, '09:05:00')])).rows[0].id);
      return { ...fixture, batchId, memberId };
    }

    async function coverage(fixture, { actor = qa, selected = false, exclusion = null,
      occurredAt = RELEASED_AT } = {}) {
      const input = {
        accountId: actor.userId, taskId: fixture.taskId, stage: 'COPY',
        reviewItemKey: 'COPY:v2:' + fixture.memberId, kind: 'BATCH_RELEASE',
        operationKey: 'COPY:v2:' + fixture.batchId + ':BATCH_RELEASE', occurredAt,
        data: { qaBatchId: fixture.batchId, samplingItemId: fixture.memberId,
          copyRevisionId: fixture.revisionId, qualityCycle: 0, selected,
          sampleKind: 'RANDOM', source: 'COPY_V2', exclusion },
      };
      assert.equal(await recordQualityReviewCoverage(db, input), true);
      assert.equal(await recordQualityReviewCoverage(db, input), false,
        'replaying one release writes only one durable member coverage fact');
    }

    async function quality(fixture, action, occurredAt, source) {
      await db.query(`INSERT INTO account_quality_events(event_key,task_id,stage,account_id,
        action,establishes_sample,occurred_at,data)
        VALUES($1,$2,'COPY',$3,$4,true,$5,$6)`,
      ['first-copy-test:' + randomUUID(), fixture.taskId, worker.userId, action, occurredAt,
        { username: worker.username, approvalId: fixture.approvalId, copyRevisionId: fixture.revisionId,
          qaBatchId: fixture.batchId, samplingItemId: fixture.memberId, reviewerId: qa.userId, source }]);
    }

    async function legacy(fixture, { status = 'RELEASED', freezeStatus = 'RELEASED',
      resolvedAt = RELEASED_AT } = {}) {
      const batchId = Number((await db.query(`INSERT INTO production_batches(public_id,
        query_package_name,created_by_account_id,created_by_username,request_id,request_fingerprint,
        client_batch_code) VALUES($1,'首次通过历史批次',$2,$3,$4,$5,$6) RETURNING id`,
      [randomUUID(), admin.userId, admin.username, randomUUID(), SHA,
        randomUUID().replaceAll('-', '')])).rows[0].id);
      const freezeId = Number((await db.query(`INSERT INTO copy_sampling_freezes(public_id,
        production_batch_id,policy_version,rate_bps,seed,algorithm_version,blind_review_enabled,
        population_count,sample_count,snapshot_sha256,frozen_by_account_id,frozen_by_username,
        request_id,request_fingerprint,status,frozen_at,resolved_at)
        VALUES($1,$2,1,0,'fixture','test',false,1,0,$3,$4,$5,$6,$3,$7,$8,$9) RETURNING id`,
      [randomUUID(), batchId, SHA, admin.userId, admin.username, randomUUID(), freezeStatus,
        at(DAY, '09:05:00'), resolvedAt])).rows[0].id);
      const itemId = Number((await db.query(`INSERT INTO copy_sampling_items(public_id,freeze_id,
        task_id,approval_event_id,copy_revision_id,content_sha256,final_approver_account_id,
        final_approver_username,rank_hash,selected,status,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$6,false,$9,$10,$10) RETURNING id`,
      [randomUUID(), freezeId, fixture.taskId, fixture.approvalId, fixture.revisionId, SHA,
        worker.userId, worker.username, status, at(DAY, '09:05:00')])).rows[0].id);
      return { ...fixture, freezeId, itemId };
    }

    async function result(fixtures, asOf = AS_OF) {
      const start = at(DAY, '00:00:00'), end = at('2026-09-21', '00:00:00');
      const rows = (await db.query(`SELECT event_key,task_id,account_id,stage,occurred_at,data
        FROM operator_performance_events WHERE task_id=ANY($1::bigint[]) AND kind='SUBMIT'
          AND stage='COPY' AND occurred_at >= $2 AND occurred_at < $3 AND occurred_at <= $4
          AND data->>'exclusion' IS NULL ORDER BY occurred_at,sequence_id`,
      [fixtures.map(fixture => fixture.taskId), start, end, asOf])).rows.map(row => ({
        ...row.data, id: row.event_key, taskId: Number(row.task_id), accountId: Number(row.account_id),
        stage: row.stage, kind: 'SUBMIT', at: row.occurred_at.toISOString(),
      }));
      const snapshot = {
        timezone: 'Asia/Shanghai', asOf, range: { from: DAY, to: DAY }, rows,
        people: [{ accountId: worker.userId, username: worker.username, displayName: worker.displayName,
          annotationOverallPass: { decided: 0, failed: 0 } }],
        dataQuality: { unknownIdentity: 0, unattributedAnnotationBatchReturns: 0,
          unattributedAnnotationBatchScopes: 0 },
      };
      const annotation = await readAnnotationAssignmentReport(db, snapshot);
      const jobs = buildAnnotationJobReport(annotation.report, annotation.firstCopyVerdicts);
      return { ...annotation, person: jobs.people[0] };
    }

    function assertResults(actual, fixtures, outcomes) {
      assert.equal(actual.firstCopyVerdicts.length, fixtures.length,
        'each selected assignment cycle contributes exactly one first-approval verdict');
      const byTask = new Map(actual.firstCopyVerdicts.map(row => [row.taskId, row]));
      assert.deepEqual(fixtures.map(fixture => byTask.get(fixture.taskId)?.outcome), outcomes);
      assert.ok(actual.firstCopyVerdicts.every(row => row.submitted));
      assert.equal(actual.person.copyFirstPassed, outcomes.filter(outcome => outcome === 'PASS').length);
      assert.equal(actual.person.copyDecided, outcomes.filter(outcome => outcome !== null).length,
        'released unsampled PASS enters both the pass numerator and the decided denominator');
    }

    await t.test('completed v2 RELEASED members count PASS with a null decided_at', async () => {
      const fixtures = [
        await v2(await task('首次未抽中放行甲')),
        await v2(await task('首次未抽中放行乙')),
      ];
      const rows = (await db.query('SELECT decided_at FROM copy_qa_batch_members_v2 WHERE id=ANY($1::bigint[])',
        [fixtures.map(fixture => fixture.memberId)])).rows;
      assert.ok(rows.every(row => row.decided_at === null));
      const actual = await result(fixtures);
      assertResults(actual, fixtures, ['PASS', 'PASS']);
      assert.equal(actual.person.copyFirstPassRate, 1);
      assert.equal(actual.report.range.to, DAY,
        'the cohort keeps its first work day while the next-day release is tracked through asOf');
    });

    await t.test('uncompleted NOT_SELECTED and selected PENDING members remain unjudged', async () => {
      const unselected = await v2(await task('首次未抽中但批次未结束'), {
        status: 'NOT_SELECTED', batchStatus: 'INSPECTING', completedAt: null,
      });
      const pending = await v2(await task('首次抽中待质检'), {
        status: 'PENDING', selected: true, batchStatus: 'INSPECTING', completedAt: null,
      });
      const actual = await result([unselected, pending]);
      assertResults(actual, [unselected, pending], [null, null]);
      assert.equal(actual.person.copyFirstPending, 1);
      assert.equal(actual.person.copyFirstUnjudged, 2);
    });

    await t.test('release after asOf is counted only in a later snapshot', async () => {
      const fixture = await v2(await task('快照后才放行'), {
        completedAt: at('2026-09-23', '12:00:00'),
      });
      assertResults(await result([fixture]), [fixture], [null]);
      assertResults(await result([fixture], at('2026-09-24', '23:59:59')), [fixture], ['PASS']);
    });

    await t.test('durable release survives SUPERSEDED while self or selected coverage cannot pass', async () => {
      const historical = await v2(await task('放行后旧成员已替换'));
      await coverage(historical);
      await db.query("UPDATE copy_qa_batch_members_v2 SET status='SUPERSEDED' WHERE id=$1", [historical.memberId]);
      const self = await v2(await task('自行放行不能绕过免检排除'));
      await coverage(self, { actor: worker, exclusion: 'SELF_REVIEW' });
      const selected = await v2(await task('抽中成员覆盖不能代替人工质检'), { status: 'SUPERSEDED', selected: true });
      await coverage(selected, { selected: true });
      assertResults(await result([historical, self, selected]), [historical, self, selected], ['PASS', null, null]);
    });

    await t.test('first BATCH_AFFECTED return cannot borrow PASS from a later approval', async () => {
      const first = await v2(await task('首次整批退回后新版通过'), {
        status: 'BATCH_AFFECTED', batchStatus: 'AUTO_RETURNED', completedAt: RELEASED_AT,
        decidedAt: RELEASED_AT,
      });
      await quality(first, 'RETURN', RELEASED_AT, 'BATCH_AFFECTED');
      const later = await v2(await submit(first, {
        number: 2, parentId: first.revisionId, submittedAt: at('2026-09-21', '14:00:00'),
      }), { status: 'PASSED', selected: true, completedAt: at('2026-09-22', '10:00:00'),
        decidedAt: at('2026-09-22', '10:00:00') });
      await quality(later, 'PASS', at('2026-09-22', '10:00:00'), 'DIRECT');
      const actual = await result([first]);
      assertResults(actual, [first], ['RETURN']);
      assert.equal(actual.person.copyFirstReturned, 1);
    });

    await t.test('ADMIN_DIRECT stays excluded even if a released member and coverage exist', async () => {
      const fixture = await v2(await task('管理员直通不计首次通过'));
      await coverage(fixture);
      await db.query(`INSERT INTO copy_qa_admin_direct_approvals(task_id,copy_revision_id,
        approval_event_id,actor_account_id,actor_username,request_id,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [fixture.taskId, fixture.revisionId, fixture.approvalId, admin.userId, admin.username, randomUUID(), RELEASED_AT]);
      const actual = await result([fixture]);
      assertResults(actual, [fixture], [null]);
      assert.equal(actual.firstCopyVerdicts[0].reason, 'ADMIN_DIRECT');
      assert.equal(actual.person.copyFirstBypassed, 1);
    });

    await t.test('legacy resolved freeze or actual RELEASE is PASS, while unfinished freeze is not', async () => {
      const resolved = await legacy(await task('历史批次放行且有完成时间'));
      const eventOnly = await legacy(await task('历史真实放行事件仍有效'), {
        status: 'SUPERSEDED', freezeStatus: 'INSPECTING', resolvedAt: null,
      });
      await db.query(`INSERT INTO copy_sampling_events(freeze_id,sampling_item_id,action,
        actor_account_id,actor_username,request_id,details,created_at)
        VALUES($1,NULL,'RELEASE',$2,$3,$4,$5,$6)`,
      [eventOnly.freezeId, qa.userId, qa.username, randomUUID(),
        { taskIds: [eventOnly.taskId] }, RELEASED_AT]);
      const unfinished = await legacy(await task('历史未抽中但尚未放行'), {
        status: 'NOT_SELECTED', freezeStatus: 'INSPECTING', resolvedAt: null,
      });
      assertResults(await result([resolved, eventOnly, unfinished]), [resolved, eventOnly, unfinished],
        ['PASS', 'PASS', null]);
    });

    await t.test('release is approval-bound and overlapping member, coverage and legacy facts count once', async () => {
      const first = await task('只有后续版本放行不能借给首次版本');
      await v2(await submit(first, {
        number: 2, parentId: first.revisionId, submittedAt: at('2026-09-21', '14:00:00'),
      }), { completedAt: at('2026-09-22', '10:00:00') });
      const overlap = await v2(await task('同首次版本多来源放行只计一次'));
      await coverage(overlap);
      await legacy(overlap);
      const actual = await result([first, overlap]);
      assertResults(actual, [first, overlap], [null, 'PASS']);
      assert.equal(actual.person.copyReview, 2);
      assert.equal(actual.person.copyFirstUnjudged, 1);
    });
  } finally {
    await repository.close();
    await database.stop();
  }
});
