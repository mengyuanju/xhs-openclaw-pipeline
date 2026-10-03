import assert from 'node:assert/strict';
import test from 'node:test';
import { listCopyQaCandidatesV2 } from '../src/copy-qa-v2.mjs';
import { installQualityRoutes } from '../src/http-quality-routes.mjs';

const actor = { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 };
function fixture() {
  const reads = [];
  const pool = { async query(sql, values) {
    reads.push({ sql, values });
    if (sql.includes('SELECT * FROM app_users')) return { rows: [{ id: 1, role: 'ADMIN' }] };
    if (sql.includes('FROM app_users ORDER BY')) return { rows: [
      { id: 1, username: 'admin', display_name: '管理员', auto_copy_batch_enabled: true, auto_copy_batch_size: 20 },
      { id: 2, username: 'peer', display_name: '审核人' },
    ] };
    if (sql.includes('GROUP BY approval.approved_by_account_id')) return { rows: [
      { account_id: 1, pending_count: '3' }, { account_id: 2, pending_count: '9000' },
    ] };
    if (sql.includes('LIMIT 5000')) return { rows: [{ task_id: 88, query: '需选择后才读取的任务', account_id: 1,
      username: 'admin', approved_at: '2026-10-02T00:00:00Z', copy_revision_id: 9 }] };
    throw Error(`Unexpected SQL: ${sql}`);
  } };
  return { pool, reads };
}

test('personal overview skips the candidate query but keeps global eligibility counters and settings', async () => {
  const { pool, reads } = fixture();
  const summary = await listCopyQaCandidatesV2(pool, actor, 1, { summaryOnly: true });
  assert.deepEqual(summary.tasks, []); assert.equal(summary.truncated, false);
  assert.deepEqual(summary.users.map(user => user.pendingCount), [3, 9000]);
  assert.equal(summary.users[0].autoBatchSize, 20);
  assert.equal(reads.length, 3); assert.equal(reads.some(read => read.sql.includes('LIMIT 5000')), false);
  const full = await listCopyQaCandidatesV2(pool, actor, 1);
  assert.deepEqual(full.users, summary.users); assert.equal(full.tasks[0].taskId, 88);
  const taskQuery = reads.find(read => read.sql.includes('LIMIT 5000'));
  assert.deepEqual(taskQuery.values, [1]);
  assert.match(taskQuery.sql, /approval\.copy_revision_id=task\.current_copy_revision_id/u);
  assert.match(taskQuery.sql, /approval\.approval_mode='MANUAL'/u);
  assert.match(taskQuery.sql, /NOT EXISTS \(SELECT 1 FROM copy_qa_batch_members_v2/u);
  await listCopyQaCandidatesV2(pool, actor);
  assert.deepEqual(reads.at(-2).values, [null]);
});

test('candidate summary rejects non-boolean flags and still verifies the active administrator', async () => {
  const { pool, reads } = fixture();
  await assert.rejects(listCopyQaCandidatesV2(pool, actor, null, { summaryOnly: 'true' }), TypeError);
  assert.equal(reads.length, 0);
  await assert.rejects(listCopyQaCandidatesV2({ async query() { return { rows: [] }; } }, actor, null, { summaryOnly: true }), /authenticated|authentication|登录|身份/i);
});

test('quality HTTP routes forward opt-in flags and reject ambiguous query values', async () => {
  const { pool } = fixture(); const routes = new Map(); const calls = [];
  const router = Object.fromEntries(['get', 'post', 'put', 'delete', 'patch'].map(method => [method, (path, handler) => routes.set(`${method} ${path}`, handler)]));
  installQualityRoutes({ router, repository: { pool, async listImageQaItems(options) { calls.push(options); return { items: [] }; } } });
  const context = query => ({ query, state: { actor } });
  const candidate = context({ summaryOnly: 'true' });
  await routes.get('get /v2/copy-qa/candidates')(candidate);
  assert.deepEqual(candidate.body.data.tasks, []);
  await routes.get('get /v1/image-qa/items')(context({ includeSummary: 'true', limit: '50', offset: '50' }));
  assert.equal(calls[0].includeSummary, true); assert.equal(calls[0].offset, '50');
  await routes.get('get /v1/image-qa/items')(context({ limit: '50' }));
  assert.equal(Object.hasOwn(calls[1], 'includeSummary'), false);
  for (const [path, flag] of [['/v2/copy-qa/candidates', 'summaryOnly'], ['/v1/image-qa/items', 'includeSummary']]) {
    await assert.rejects(routes.get(`get ${path}`)(context({ [flag]: '1' })), error => error.status === 400);
  }
});
