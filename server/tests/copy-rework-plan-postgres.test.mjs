import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { applyMigrations, loadMigrations } from '../src/database-migrations.mjs';
import { passCopyQaItem, returnCopyQaItem } from '../src/copy-quality-control.mjs';
import { startTemporaryPostgres18 } from './temporary-postgres18.mjs';

const content = {
  copy: {
    title: '整理桌面的实用方法',
    body: '先清理不再使用的物品，再按照使用频率划分区域。'.repeat(20),
    tags: ['#桌面整理', '#收纳方法', '#效率提升'],
  },
  imagePlan: [
    { kind: 'hero', headline: '桌面整理', subtitle: '', bullets: ['清空桌面', '重新分区'], prompt: '明亮自然光下整洁桌面的前后对比画面', layout: { mode: 'CUSTOM' } },
    { kind: 'steps', headline: '先做减法', subtitle: '', bullets: ['判断使用频率', '移走低频物品'], prompt: '展示物品分类和筛选过程的真实桌面场景' },
    { kind: 'summary', headline: '固定位置', subtitle: '', bullets: ['每天复位', '每周检查'], prompt: '整洁桌面与标签明确的收纳区域近景画面' },
  ],
};

test('PostgreSQL: plan-only direct submit, saved/reverted plans and repeated returns use the current rework round', {
  skip: process.env.RUN_POSTGRES_E2E !== '1', timeout: 120_000,
}, async t => {
  const postgres = await startTemporaryPostgres18('xhs-rework-plan-');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: postgres.connectionString });
  t.after(async () => { await pool.end(); await postgres.stop(); });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyMigrations(client, await loadMigrations());
    await client.query('COMMIT');
  } finally { client.release(); }
  const repository = new PostgresControlPlaneRepository({ pool });
  await pool.query("INSERT INTO executor_nodes(id, name) VALUES ('plan-test', 'test')");
  const actors = [];
  for (const [username, role] of [['worker', 'USER'], ['inspector', 'REVIEWER']]) {
    const row = (await pool.query(`INSERT INTO app_users(username, display_name, role, password_hash,
      copy_review_enabled, copy_qc_enabled) VALUES ($1, $1, $2, 'test-only', true, true) RETURNING *`,
    [username, role])).rows[0];
    actors.push({ userId: Number(row.id), username, role, credentialVersion: Number(row.credential_version) });
  }
  const [worker, inspector] = actors;
  for (const target of ['COPY', 'BOTH']) {
    await t.test(`final ${target} and subsequent QA returns accept plan-only corrections`, async () => {
      const taskId = Number((await pool.query(`INSERT INTO tasks(query, created_by_node_id, state,
        assigned_to_user_id, assignment_source, assigned_at, mandatory_copy_qc, mandatory_copy_qc_origin)
        VALUES ('返工测试', 'plan-test', 'COPY_REVIEW_PENDING', 'worker', 'MANUAL', now(), true, 'FINAL_REWORK')
        RETURNING id`)).rows[0].id);
      const returnedContent = { ...structuredClone(content), finalRework: { target, note: '调整封面说明' } };
      let revisionId = Number((await pool.query(`INSERT INTO copy_revisions(task_id, revision, content, revision_origin)
        VALUES ($1, 1, $2, 'FINAL_REWORK') RETURNING id`, [taskId, returnedContent])).rows[0].id);
      await pool.query('UPDATE tasks SET current_copy_revision_id = $2 WHERE id = $1', [taskId, revisionId]);
      const submit = (decision, edits, extra = {}) => repository.approveCopy(taskId, {
        revisionId, nodeId: 'plan-test', decision, ...(edits ? { edits } : {}),
        reviewSessionId: randomUUID(), ...extra,
      }, { actor: worker });
      await assert.rejects(submit('APPROVE'), { code: 'COPY_REWORK_NOT_SATISFIED' });
      await assert.rejects(submit('APPROVE', content), { code: 'COPY_REWORK_NOT_SATISFIED' });
      if (target === 'BOTH') {
        await assert.rejects(submit('APPROVE', { ...content, imageSettings: { format: 'JPEG' } }),
          { code: 'COPY_REWORK_NOT_SATISFIED' });
      }
      const corrected = structuredClone(content);
      corrected.imagePlan[0].headline = '规划改动即可送审';
      const requestId = randomUUID();
      const first = await submit('APPROVE', corrected, { reviewSessionId: requestId });
      assert.equal(first.state, 'COPY_QC_PENDING');
      assert.equal(first.mandatoryCopyQc, true);
      assert.equal((await submit('APPROVE', corrected, { reviewSessionId: requestId })).currentCopyRevisionId,
        first.currentCopyRevisionId, 'retry must not create a duplicate revision or review item');
      let detail = await repository.getTask(taskId);
      let current = detail.copyRevisions.find(row => row.id === detail.currentCopyRevisionId);
      assert.deepEqual(current.content.copy, content.copy);
      assert.equal(current.revisionOrigin, 'PLAN_EDIT');
      assert.equal(current.copyContentChangedFromMachine, false);
      assert.equal(current.copyReworkSatisfied, true);
      assert.equal(current.content.imagePlan[0].layout.mode, 'CUSTOM', 'rework must preserve intentional layouts');
      assert.equal(detail.humanQualityAssessments.at(-1).score, 3);
      let item = (await pool.query(`SELECT * FROM copy_sampling_items WHERE task_id = $1 ORDER BY id DESC LIMIT 1`, [taskId])).rows[0];
      assert.equal(item.sample_kind, 'MANDATORY_RECHECK');
      await returnCopyQaItem(pool, item.public_id, {
        requestId: randomUUID(), expectedCopyRevisionId: Number(item.copy_revision_id), note: '副标题仍需调整',
      }, inspector);
      detail = await repository.getTask(taskId);
      revisionId = detail.currentCopyRevisionId;
      current = detail.copyRevisions.find(row => row.id === revisionId);
      assert.equal(current.copyReworkSatisfied, false);
      assert.equal(current.reworkOrigin, 'QA_RETURN');
      await assert.rejects(submit('APPROVE'), { code: 'COPY_REWORK_NOT_SATISFIED' });
      const second = structuredClone(corrected);
      second.imagePlan[0].subtitle = '补充封面说明';
      const saved = await submit('SAVE_PLAN', second);
      revisionId = saved.currentCopyRevisionId;
      assert.equal(saved.state, 'COPY_REVIEW_PENDING');
      detail = await repository.getTask(taskId);
      assert.equal(detail.copyRevisions.find(row => row.id === revisionId).copyReworkSatisfied, true);
      const reverted = await submit('SAVE', corrected);
      revisionId = reverted.currentCopyRevisionId;
      assert.equal((await repository.getTask(taskId)).copyRevisions.find(row => row.id === revisionId).copyReworkSatisfied, false);
      // A stale cached true must not permit content restored to the return baseline.
      await pool.query('UPDATE copy_revisions SET copy_rework_satisfied = true WHERE id = $1', [revisionId]);
      await assert.rejects(submit('APPROVE'), { code: 'COPY_REWORK_NOT_SATISFIED' });
      revisionId = (await submit('SAVE_PLAN', second)).currentCopyRevisionId;
      // Existing saved plan revisions have a false flag from the old implementation.
      await pool.query('UPDATE copy_revisions SET copy_rework_satisfied = false WHERE id = $1', [revisionId]);
      assert.equal((await repository.getTask(taskId)).copyRevisions.find(row => row.id === revisionId).copyReworkSatisfied, true);
      const approved = await submit('APPROVE');
      assert.equal(approved.state, 'COPY_QC_PENDING');
      assert.equal(approved.currentCopyRevisionId, revisionId);
      item = (await pool.query(`SELECT * FROM copy_sampling_items WHERE task_id = $1 ORDER BY id DESC LIMIT 1`, [taskId])).rows[0];
      assert.equal(item.sample_kind, 'MANDATORY_RECHECK');
      await passCopyQaItem(pool, item.public_id, {
        requestId: randomUUID(), expectedCopyRevisionId: revisionId,
      }, inspector);
      detail = await repository.getTask(taskId);
      assert.equal(detail.state, 'IMAGE_QUEUED');
      assert.equal(detail.mandatoryCopyQc, false);
    });
  }
});
