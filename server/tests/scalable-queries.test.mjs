import assert from 'node:assert/strict';
import test from 'node:test';

import { PostgresControlPlaneRepository, postgresPoolOptions } from '../src/postgres-repository.mjs';
import { listQueryPackages } from '../src/query-packages.mjs';

const admin = Object.freeze({ userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 });
const executionId = '44444444-4444-4444-8444-444444444444';

function totalFixture({ ttl = 1_000 } = {}) {
  let clock = Date.parse('2026-10-01T00:00:00Z');
  let count = 10;
  let countQueries = 0;
  const queries = [];
  const pool = {
    async query(sql, values) {
      queries.push({ sql: String(sql), values });
      if (String(sql).includes('COUNT(*) AS total')) {
        countQueries++;
        return { rows: [{ total: String(count) }] };
      }
      return { rows: [] };
    },
  };
  return {
    repository: new PostgresControlPlaneRepository({ pool, totalCacheTtlMs: ttl, now: () => clock }),
    pool, queries,
    get countQueries() { return countQueries; },
    advance(milliseconds) { clock += milliseconds; },
    setCount(value) { count = value; },
  };
}

test('pool size and timeouts are bounded configurable options without opening a database connection', () => {
  assert.deepEqual(postgresPoolOptions({}), {
    max: 10, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000,
    statement_timeout: 30_000, idle_in_transaction_session_timeout: 60_000,
  });
  assert.equal(postgresPoolOptions({ PG_POOL_MAX: '20' }).max, 20);
  assert.equal(postgresPoolOptions({ PG_STATEMENT_TIMEOUT_MS: '0' }).statement_timeout, 0);
  for (const value of ['0', '-1', '101', 'not-a-number', '1.5']) {
    assert.throws(() => postgresPoolOptions({ PG_POOL_MAX: value }), /PG_POOL_MAX/u);
  }
  assert.throws(() => postgresPoolOptions({ PG_CONNECTION_TIMEOUT_MS: '-1' }), /PG_CONNECTION_TIMEOUT_MS/u);
  assert.throws(() => new PostgresControlPlaneRepository({ pool: {}, totalCacheTtlMs: 5_001 }), /TASK_TOTAL_CACHE_TTL_MS/u);
});

test('cached totals keep the exact filtered count and disclose their calculation time', async () => {
  const fixture = totalFixture();
  const options = { includeTotal: true, countCacheIdentity: admin, state: 'COPY_QUEUED' };
  const first = await fixture.repository.listTasks(options);
  fixture.setCount(11);
  fixture.advance(400);
  const cached = await fixture.repository.listTasks({ ...options, offset: 50 });
  assert.equal(fixture.countQueries, 1);
  assert.equal(cached.total, 10);
  assert.equal(cached.totalComputedAt, first.totalComputedAt);
  assert.equal(cached.totalCacheAgeMs, 400);
  fixture.advance(600);
  const fresh = await fixture.repository.listTasks(options);
  assert.equal(fixture.countQueries, 2);
  assert.equal(fresh.total, 11);
  assert.equal(fresh.totalCacheAgeMs, 0);
});

test('total cache separates filter values, account identities, roles and credential versions', async () => {
  const fixture = totalFixture();
  const options = { includeTotal: true, countCacheIdentity: admin };
  await fixture.repository.listTasks(options);
  await fixture.repository.listTasks({ ...options, query: '夏日' });
  await fixture.repository.listTasks({ ...options, countCacheIdentity: { ...admin, userId: 2, username: 'alice' } });
  await fixture.repository.listTasks({ ...options, countCacheIdentity: { ...admin, role: 'USER' } });
  await fixture.repository.listTasks({ ...options, countCacheIdentity: { ...admin, credentialVersion: 2 } });
  assert.equal(fixture.countQueries, 5);
  await fixture.repository.listTasks(options);
  assert.equal(fixture.countQueries, 5);
});

test('refresh and last-page navigation bypass cached totals and discard the prior cache', async () => {
  const fixture = totalFixture();
  const options = { includeTotal: true, countCacheIdentity: admin };
  await fixture.repository.listTasks(options);
  fixture.setCount(20);
  assert.equal((await fixture.repository.listTasks({ ...options, refreshTotal: true })).total, 20);
  assert.equal((await fixture.repository.listTasks(options)).total, 20);
  fixture.setCount(21);
  assert.equal((await fixture.repository.listTasks({ ...options, lastPage: true })).total, 21);
  assert.equal(fixture.countQueries, 4);
  await assert.rejects(fixture.repository.listTasks({ refreshTotal: 'true' }), /refreshTotal/u);
});

test('cache can be disabled and internal calls without a complete identity do not share counts', async () => {
  for (const options of [{}, { countCacheIdentity: {} }]) {
    const fixture = totalFixture();
    await fixture.repository.listTasks({ includeTotal: true, ...options });
    await fixture.repository.listTasks({ includeTotal: true, ...options });
    assert.equal(fixture.countQueries, 2);
  }
  const fixture = totalFixture({ ttl: 0 });
  await fixture.repository.listTasks({ includeTotal: true, countCacheIdentity: admin });
  await fixture.repository.listTasks({ includeTotal: true, countCacheIdentity: admin });
  assert.equal(fixture.countQueries, 2);
});

test('simultaneous readers share one in-flight count and rejected counts can be retried', async () => {
  let attempts = 0;
  let reject;
  const pending = new Promise((_, fail) => { reject = fail; });
  const pool = { async query(sql) {
    if (!String(sql).includes('COUNT(*) AS total')) return { rows: [] };
    attempts++;
    if (attempts === 1) return pending;
    return { rows: [{ total: '12' }] };
  } };
  const repository = new PostgresControlPlaneRepository({ pool });
  const options = { includeTotal: true, countCacheIdentity: admin };
  const readers = [repository.listTasks(options), repository.listTasks(options)];
  assert.equal(attempts, 1);
  reject(new Error('count unavailable'));
  for (const result of await Promise.allSettled(readers)) assert.equal(result.status, 'rejected');
  assert.equal((await repository.listTasks(options)).total, 12);
  assert.equal(attempts, 2);
});

test('idempotent task mutations retain totals when no list facts changed', async () => {
  const fixture = totalFixture();
  fixture.pool.connect = async () => ({
    release() {},
    async query(sql) {
      return { rows: String(sql).includes('SELECT * FROM tasks')
        ? [{ id: 1, state: 'CANCELLED', task_kind: 'CONTENT' }] : [] };
    },
  });
  const options = { includeTotal: true, countCacheIdentity: admin };
  await fixture.repository.listTasks(options);
  await fixture.repository.cancelTask(1);
  await fixture.repository.listTasks(options);
  assert.equal(fixture.countQueries, 1);
});

test('list pages select summary columns instead of fetching unused model snapshots', async () => {
  const fixture = totalFixture();
  await fixture.repository.listTasks();
  const sql = fixture.queries[0].sql;
  assert.doesNotMatch(sql, /SELECT \* FROM tasks|pending_snapshot/u);
  assert.match(sql, /priority_sort_at/u);
});

test('de-duplication pages narrow task IDs before fetching task summaries', async () => {
  const fixture = totalFixture();
  await fixture.repository.listTasks({ deduplicateQuery: true });
  const sql = fixture.queries[0].sql;
  const candidate = sql.slice(sql.indexOf('SELECT DISTINCT ON'), sql.indexOf('FROM tasks', sql.indexOf('SELECT DISTINCT ON')));
  assert.match(candidate, /id, created_at, priority_paused, priority_sort_at/u);
  assert.doesNotMatch(candidate, /\binput\b|current_copy_revision_id|current_image_run_id/u);
  assert.match(sql, /FROM tasks page_task\s+JOIN \(\s+SELECT cursor_page\.id/u);
  assert.match(sql, /LIMIT \$\d+[\s\S]+page_ids ON page_task\.id = page_ids\.id/u);
});

test('progress updates address the locked task primary key and retain the current-execution guard', async () => {
  const calls = [];
  const execution = { id: executionId, task_id: 41, node_id: 'executor-a', kind: 'COPY',
    status: 'RUNNING', current_execution_id: executionId, snapshot: {}, stage: 'COPY' };
  const client = {
    release() {},
    async query(sql, values) {
      calls.push({ sql: String(sql), values });
      if (String(sql).includes('SELECT t.id')) return { rows: [{ id: 41 }] };
      if (String(sql).includes('FROM task_executions e')) return { rows: [execution] };
      if (String(sql).includes('UPDATE task_executions SET')) return { rows: [execution] };
      return { rows: [] };
    },
  };
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
  await repository.updateProgress(executionId, { stage: 'COPY', progressPercent: 30, message: '处理中' });
  const update = calls.find(call => call.sql.includes('UPDATE tasks SET'));
  assert.match(update.sql, /WHERE id = \$5 AND current_execution_id = \$1/u);
  assert.deepEqual(update.values, [executionId, 'COPY', 30, '处理中', 41]);
});

test('package listings page visible package IDs before joining and aggregating item history', async () => {
  for (const actor of [admin, { userId: 2, username: 'alice', role: 'USER' }]) {
    let request;
    await listQueryPackages({ async query(sql, values) {
      request = { sql: String(sql), values };
      return { rows: [] };
    } }, { limit: 20, offset: 40 }, actor);
    const pageEnd = request.sql.indexOf('\n  )\n');
    const pagination = request.sql.slice(0, pageEnd);
    assert.match(pagination, /WITH package_page AS MATERIALIZED/u);
    assert.match(pagination, /ORDER BY package\.updated_at DESC, package\.id DESC/u);
    assert.match(pagination, /LIMIT \$\d+ OFFSET \$\d+/u);
    assert.match(request.sql, /FROM package_page AS page JOIN query_packages AS package ON package\.id = page\.id/u);
    assert.equal(request.sql.indexOf('COUNT(item.id)') > pageEnd, true);
    if (actor.role !== 'ADMIN') {
      assert.match(pagination, /screening_assigned_to_account_id = \$1/u);
      assert.deepEqual(request.values, [2, 'alice', 20, 40]);
    } else assert.deepEqual(request.values, [20, 40]);
  }
});

test('current task details keep the return lineage and retry evidence while avoiding unrelated history', async () => {
  const calls = [];
  const chainId = '11111111-1111-4111-8111-111111111111';
  const task = { id: 41, current_copy_revision_id: 12, current_image_run_id: chainId,
    state: 'COPY_REVIEW_PENDING', current_stage: 'IMAGE_RETRY_EXHAUSTED', mandatory_copy_qc: true,
    image_production_chain_id: chainId, created_at: new Date(), updated_at: new Date() };
  const revisions = [
    { id: 12, parent_revision_id: 11, revision: 3, content: { copy: { title: '修订稿' } } },
    { id: 11, parent_revision_id: 10, revision: 2, content: { copy: { title: '原稿' } } },
    { id: 10, revision: 1, revision_origin: 'QA_RETURN', content: { copy: { title: '原稿' }, qualityReturn: { target: 'COPY' } } },
  ].map(row => ({ task_id: 41, ...row }));
  const failures = [3, 2, 1].map(attempt => ({
    id: `${attempt}1111111-1111-4111-8111-111111111111`, task_id: 41, kind: 'IMAGE', status: 'FAILED',
    image_production_chain_id: chainId, error: `失败 ${attempt}`, stage: 'IMAGE',
    started_at: `2026-10-01T00:00:0${attempt}Z`, snapshot: { imageRetry: { failedAttempts: attempt - 1 } },
  }));
  const repository = new PostgresControlPlaneRepository({ pool: { async query(sql) {
    const source = String(sql);
    calls.push(source);
    if (source.includes('WITH task AS')) return { rows: [task] };
    if (source.includes('FROM task_executions WHERE task_id')) return { rows: failures };
    if (source.includes('THEN revision.content END')) return { rows: revisions };
    return { rows: [] };
  } } });
  const detail = await repository.getTask(41, { historyMode: 'current' });
  assert.equal(detail.copyRevisions[0].copyReworkSatisfied, true);
  assert.equal(detail.copyRevisions[0].reworkTarget, 'COPY');
  assert.deepEqual(detail.imageRetryFailures.map(failure => failure.attempt), [1, 2, 3]);
  assert.equal(detail.executions.some(execution => Object.hasOwn(execution, 'snapshot')), false);
  const executionSql=calls.find(sql=>sql.includes('FROM task_executions WHERE task_id'));
  assert.doesNotMatch(executionSql,/SELECT \*/u);
  assert.match(executionSql,/snapshot->'imageRetry'->'failedAttempts'/u);
  assert.deepEqual(detail.history.availableKinds, ['executions', 'copyRevisions', 'imageRuns', 'assessments']);
  const copySql = calls.find(sql => sql.includes('THEN revision.content END'));
  assert.match(copySql, /WITH RECURSIVE current_copy_lineage/u);
  assert.match(copySql, /\bUNION\s+SELECT parent\.id/u);
  assert.doesNotMatch(copySql, /child\.path/u);
  assert.match(calls.find(sql => sql.includes('SELECT * FROM image_runs')), /image_rework_source_run_id/u);
  assert.doesNotMatch(calls[0], /pending_snapshot/u);
  await assert.rejects(repository.getTask(41, { historyMode: 'unbounded' }), /history mode/u);
});

test('history metadata is paged by task and kind with microsecond precision and no large payloads', async () => {
  const calls = [];
  const pool = { async query(sql, values) {
    calls.push({ sql: String(sql), values });
    return { rows: [3, 2, 1].map(id => ({ id: String(id), task_id: 41, revision: id,
      content: { confidentialLargePayload: true }, created_at: new Date('2026-10-01T00:00:00Z'),
      history_cursor_time: `2026-10-01 00:00:00.00000${id}+00` })) };
  } };
  const repository = new PostgresControlPlaneRepository({ pool });
  const page = await repository.listTaskHistory(41, { kind: 'copyRevisions', limit: 2 });
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.items.map(item => item.id), [3, 2]);
  assert.equal(page.items.some(item => Object.hasOwn(item, 'content')), false);
  assert.doesNotMatch(calls[0].sql, /SELECT \*|\bcontent\b|\bresult\b|\bsnapshot\b/u);
  assert.deepEqual(calls[0].values, [41, 3]);
  await repository.listTaskHistory(41, { kind: 'copyRevisions', limit: 2, cursor: page.nextCursor });
  assert.deepEqual(calls[1].values, [41, '2026-10-01 00:00:00.000002+00', 2, 3]);
  assert.match(calls[1].sql, /\(created_at, id\) < \(\$2::timestamptz, \$3::bigint\)/u);
  const before = calls.length;
  await assert.rejects(repository.listTaskHistory(42, { kind: 'copyRevisions', cursor: page.nextCursor }), /does not match/u);
  await assert.rejects(repository.listTaskHistory(41, { kind: 'imageRuns', cursor: page.nextCursor }), /does not match/u);
  for (const time of ['0', '2026-02-31 00:00:00+00', '0000-01-01 00:00:00+00', '2026-10-01 00:00:00+20']) {
    const cursor = Buffer.from(JSON.stringify({ v: 1, taskId: 41, kind: 'copyRevisions', id: 2, time })).toString('base64url');
    await assert.rejects(repository.listTaskHistory(41, { kind: 'copyRevisions', cursor }), /does not match/u);
  }
  await assert.rejects(repository.listTaskHistory(41, { kind: 'copyRevisions; DELETE' }), /kind/u);
  await assert.rejects(repository.listTaskHistory(41, { kind: 'copyRevisions', limit: 101 }), /history limit/u);
  assert.equal(calls.length, before);
});

test('expanded image history reads one task-bound version and its own visible assets', async () => {
  const calls = [];
  const runId = '11111111-1111-4111-8111-111111111111';
  const repository = new PostgresControlPlaneRepository({ pool: { async query(sql, values) {
    calls.push({ sql: String(sql), values });
    if (String(sql).includes('FROM image_runs')) return { rows: [{ id: runId, task_id: 41,
      copy_revision_id: 12, result: { images: [{ assetId: 5 }] }, status: 'COMPLETED' }] };
    return { rows: [{ id: 5, task_id: 41, image_run_id: runId, media_type: 'image/png', byte_size: 100 }] };
  } } });
  const detail = await repository.getTaskHistoryItem(41, { kind: 'imageRuns', itemId: runId });
  assert.deepEqual(detail.item.result, { images: [{ assetId: 5 }] });
  assert.equal(detail.assets[0].id, 5);
  assert.deepEqual(calls.map(call => call.values), [[41, runId], [41, runId]]);
  assert.match(calls[0].sql, /task_id = \$1 AND id = \$2/u);
  assert.match(calls[1].sql, /image_run_id = \$2/u);
  assert.match(calls[1].sql, /content_cleared_at IS NULL/u);
});
