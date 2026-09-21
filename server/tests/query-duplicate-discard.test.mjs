import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import {
  buildDuplicateQueryDiscardPlan,
  DUPLICATE_QUERY_SKIP_REASONS,
} from '../src/query-duplicate-discard.mjs';

const admin = Object.freeze({
  userId: 1,
  username: 'admin',
  role: 'ADMIN',
  credentialVersion: 1,
});

function row(id, overrides = {}) {
  return {
    id,
    query: ' 旅行   攻略 ',
    query_identity: '旅行 攻略',
    input: { audience: '新手' },
    requested_image_count: 'auto',
    skip_copy_review: false,
    state: 'COPY_QUEUED',
    current_execution_id: null,
    current_copy_revision_id: null,
    current_image_run_id: null,
    pending_snapshot: null,
    pristine: true,
    created_by_user_id: 'admin',
    creator_account_id: '1',
    assigned_to_user_id: 'alice',
    assignee_account_id: '2',
    source_query_package_id: '11',
    source_query_package_item_id: '21',
    source_query_package_name: '九月词包',
    production_batch_id: null,
    created_at: `2026-09-10T00:00:0${id % 10}.000Z`,
    updated_at: `2026-09-10T00:01:0${id % 10}.000Z`,
    ...overrides,
  };
}

test('duplicate Query planning keeps progressed work and only discards pristine same-context tasks', () => {
  const rows = [
    row(5, { state: 'CANCELLED', pristine: false }),
    row(4, { input: { audience: '专家' } }),
    row(3, { state: 'COPY_RUNNING', pristine: false, current_execution_id: 'running' }),
    row(2, { query: '旅行 攻略' }),
    row(1),
  ];
  const preview = buildDuplicateQueryDiscardPlan(rows, [2]);

  assert.equal(preview.version, 1);
  assert.match(preview.previewFingerprint, /^[0-9a-f]{64}$/u);
  assert.deepEqual(preview.summary, {
    queryGroupCount: 1,
    discardableCount: 2,
    skippedCount: 2,
  });
  assert.equal(preview.groups[0].keeper.id, 3);
  assert.deepEqual(preview.groups[0].discardable.map((task) => task.id), [1, 2]);
  assert.deepEqual(preview.groups[0].skipped.map(({ id, reasonCode }) => [id, reasonCode]), [
    [4, DUPLICATE_QUERY_SKIP_REASONS.DIFFERENT_BUSINESS_CONTEXT],
    [5, DUPLICATE_QUERY_SKIP_REASONS.ALREADY_CANCELLED],
  ]);
});

test('all-pristine groups keep the smallest task ID and never use CANCELLED as keeper', () => {
  const preview = buildDuplicateQueryDiscardPlan([
    row(9),
    row(7),
    row(8, { state: 'CANCELLED', pristine: false }),
  ], [9]);
  assert.equal(preview.groups[0].keeper.id, 7);
  assert.deepEqual(preview.groups[0].discardable.map(({ id }) => id), [9]);

  const cancelledOnly = buildDuplicateQueryDiscardPlan([
    row(12, { state: 'CANCELLED', pristine: false }),
    row(13, { state: 'CANCELLED', pristine: false }),
  ], [12]);
  assert.equal(cancelledOnly.groups[0].keeper, null);
  assert.equal(cancelledOnly.summary.discardableCount, 0);
  assert.equal(cancelledOnly.groups[0].skipped[0].reasonCode, 'ALREADY_CANCELLED');
});

test('stable account IDs prevent same-name replacement owners from sharing a business context', () => {
  const preview = buildDuplicateQueryDiscardPlan([
    row(1, { creator_account_id: null }),
    row(2, { creator_account_id: null }),
  ], [1]);
  assert.equal(preview.groups[0].keeper.id, 1);
  assert.equal(preview.summary.discardableCount, 0);
  assert.deepEqual(preview.groups[0].skipped.map(({ id, reasonCode }) => [id, reasonCode]), [
    [2, 'DIFFERENT_BUSINESS_CONTEXT'],
  ]);
});

test('a task with completed Xiaohongshu research is progressed and becomes the keeper', () => {
  const preview = buildDuplicateQueryDiscardPlan([
    row(1),
    row(2, { pristine: false }),
  ], [1]);
  assert.equal(preview.groups[0].keeper.id, 2);
  assert.deepEqual(preview.groups[0].discardable.map(({ id }) => id), [1]);
});

test('production-batch members are never treated as recoverable pristine duplicates', () => {
  const preview = buildDuplicateQueryDiscardPlan([
    row(1, { production_batch_id: '71' }),
    row(2, { production_batch_id: '71' }),
  ], [2]);
  assert.equal(preview.summary.discardableCount, 0);
  assert.equal(preview.groups[0].keeper.id, 1);
  assert.deepEqual(preview.groups[0].skipped.map(({ id, reasonCode }) => [id, reasonCode]), [
    [2, 'NOT_PRISTINE_COPY_QUEUED'],
  ]);
});

test('production-affecting toggles, executor routing and package snapshots stay in the context fingerprint', () => {
  const preview = buildDuplicateQueryDiscardPlan([
    row(1),
    row(2, { ai_disclosure_enabled: false }),
    row(3, { copy_executor_node_id: 'node-other' }),
    row(4, { source_query_package_name: '其他词包' }),
    row(5, { mandatory_copy_qc: true, mandatory_copy_qc_origin: 'QA_RETURN' }),
  ], [1]);
  assert.equal(preview.groups[0].keeper.id, 1);
  assert.equal(preview.summary.discardableCount, 0);
  assert.deepEqual(preview.groups[0].skipped.map(({ id, reasonCode }) => [id, reasonCode]), [
    [2, 'DIFFERENT_BUSINESS_CONTEXT'],
    [3, 'DIFFERENT_BUSINESS_CONTEXT'],
    [4, 'DIFFERENT_BUSINESS_CONTEXT'],
    [5, 'DIFFERENT_BUSINESS_CONTEXT'],
  ]);
});

test('database-canonical jsonb text keeps unsafe integer inputs in separate contexts', () => {
  const preview = buildDuplicateQueryDiscardPlan([
    row(1, {
      input: { sequence: 9007199254740992 },
      input_canonical_json: '{"sequence": 9007199254740992}',
    }),
    row(2, {
      // JSON.parse would round this value to the same JavaScript number as row 1.
      input: { sequence: 9007199254740992 },
      input_canonical_json: '{"sequence": 9007199254740993}',
    }),
  ], [1]);
  assert.equal(preview.summary.discardableCount, 0);
  assert.deepEqual(preview.groups[0].skipped.map(({ id, reasonCode }) => [id, reasonCode]), [
    [2, 'DIFFERENT_BUSINESS_CONTEXT'],
  ]);
});

test('a selected unique Query has no duplicate group but its opaque fingerprint detects a later duplicate', () => {
  const unique = buildDuplicateQueryDiscardPlan([row(1)], [1]);
  const duplicated = buildDuplicateQueryDiscardPlan([row(1), row(2)], [1]);
  assert.deepEqual(unique.groups, []);
  assert.equal(unique.summary.queryGroupCount, 0);
  assert.notEqual(unique.previewFingerprint, duplicated.previewFingerprint);
});

function repositoryFixture({ rows, receipt = null, actorActive = true } = {}) {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const source = String(sql);
      calls.push({ sql: source, values });
      if (source.includes('SELECT id FROM app_users')) {
        return { rows: actorActive ? [{ id: '1' }] : [] };
      }
      if (source.includes('FROM task_duplicate_query_discard_requests') && source.includes('SELECT')) {
        return { rows: receipt ? [receipt] : [] };
      }
      if (source.includes('WITH selected_identities')) return { rows: rows ?? [] };
      if (source.includes('UPDATE tasks AS task SET')) {
        const plan = JSON.parse(values[0]);
        return { rows: plan.map((entry) => ({ id: entry.discarded_task_id })) };
      }
      return { rows: [] };
    },
    release() {},
  };
  return {
    calls,
    repository: new PostgresControlPlaneRepository({ pool: { connect: async () => client } }),
  };
}

test('repository preview revalidates the administrator and uses the task-list identity globally', async () => {
  const fixture = repositoryFixture({ rows: [row(1), row(2)] });
  const preview = await fixture.repository.previewDuplicateQueryDiscard({ representativeTaskIds: [2] }, { actor: admin });
  assert.equal(preview.groups[0].keeper.id, 1);
  assert.deepEqual(preview.groups[0].discardable.map(({ id }) => id), [2]);
  assert.equal(fixture.calls[0].sql, 'BEGIN ISOLATION LEVEL READ COMMITTED');
  const actorLock = fixture.calls.find(({ sql }) => sql.includes('SELECT id FROM app_users'));
  const discovery = fixture.calls.find(({ sql }) => sql.includes('WITH selected_identities'));
  assert.deepEqual(actorLock.values, [1, 'admin', 1]);
  assert.match(discovery.sql, /lower\(regexp_replace\(btrim\(representative\.query\), '\\s\+'/u);
  assert.match(discovery.sql, /creator\.created_at < task\.created_at/u);
  assert.match(discovery.sql, /assignee\.created_at < task\.assigned_at/u);
  assert.match(discovery.sql, /NOT EXISTS \(SELECT 1 FROM task_executions/u);
  assert.match(discovery.sql, /search\.status = 'SUCCEEDED'/u);
  assert.match(discovery.sql, /task\.production_batch_id IS NULL/u);
  assert.equal(fixture.calls.at(-1).sql, 'COMMIT');
});

test('commit locks, revalidates, cancels searches, audits and saves an actor-bound receipt atomically', async () => {
  const rows = [row(1), row(2), row(3, { input: { audience: '专家' } })];
  const preview = buildDuplicateQueryDiscardPlan(rows, [2]);
  const fixture = repositoryFixture({ rows });
  const requestId = '11111111-1111-4111-8111-111111111111';
  const result = await fixture.repository.discardDuplicateQueries({
    requestId,
    representativeTaskIds: [2],
    previewFingerprint: preview.previewFingerprint,
    confirmedDiscardCount: 1,
  }, { actor: admin });

  assert.deepEqual(result, {
    requestId,
    discardedTaskIds: [2],
    keeperTaskIds: [1],
    discardedCount: 1,
    skippedCount: 1,
  });
  assert.equal(fixture.calls[0].sql, 'BEGIN ISOLATION LEVEL READ COMMITTED');
  const advisory = fixture.calls.find(({ sql }) => sql.includes('pg_advisory_xact_lock'));
  assert.deepEqual(advisory.values, ['duplicate-query-discard:1', requestId]);
  const discovery = fixture.calls.find(({ sql }) => sql.includes('WITH selected_identities'));
  assert.match(discovery.sql, /ORDER BY task\.id[\s\S]*FOR UPDATE OF task/u);
  const taskUpdate = fixture.calls.find(({ sql }) => sql.includes('UPDATE tasks AS task SET'));
  assert.match(taskUpdate.sql, /cancelled_from_state = 'COPY_QUEUED'/u);
  assert.match(taskUpdate.sql, /重复 Query 已废弃/u);
  assert.equal(/DELETE FROM tasks/u.test(taskUpdate.sql), false);
  const searchUpdate = fixture.calls.find(({ sql }) => sql.includes('UPDATE xhs_query_search_jobs SET'));
  assert.match(searchUpdate.sql, /status <> 'SUCCEEDED'/u);
  for (const column of ['claimed_by_node_id', 'lease_token', 'lease_expires_at', 'retry_after', 'blocked_reason']) {
    assert.match(searchUpdate.sql, new RegExp(`${column} = NULL`, 'u'));
  }
  const audit = fixture.calls.find(({ sql }) => sql.includes('INSERT INTO task_duplicate_query_discard_audits'));
  assert.ok(audit);
  const receipt = fixture.calls.find(({ sql }) => sql.includes('INSERT INTO task_duplicate_query_discard_requests'));
  assert.deepEqual(receipt.values.slice(0, 3), [1, 'admin', requestId]);
  assert.equal(fixture.calls.at(-1).sql, 'COMMIT');
});

test('stale preview rolls back without changing a task, search, audit or receipt', async () => {
  const fixture = repositoryFixture({ rows: [row(1), row(2)] });
  await assert.rejects(fixture.repository.discardDuplicateQueries({
    requestId: '22222222-2222-4222-8222-222222222222',
    representativeTaskIds: [2],
    previewFingerprint: '0'.repeat(64),
    confirmedDiscardCount: 1,
  }, { actor: admin }), { code: 'DUPLICATE_QUERY_PREVIEW_STALE' });
  assert.equal(fixture.calls.some(({ sql }) => sql.includes('UPDATE tasks AS task SET')), false);
  assert.equal(fixture.calls.some(({ sql }) => sql.includes('UPDATE xhs_query_search_jobs SET')), false);
  assert.equal(fixture.calls.some(({ sql }) => sql.includes('INSERT INTO task_duplicate_query_discard_audits')), false);
  assert.equal(fixture.calls.some(({ sql }) => sql.includes('INSERT INTO task_duplicate_query_discard_requests')), false);
  assert.equal(fixture.calls.at(-1).sql, 'ROLLBACK');
});

test('a PostgreSQL serialization or deadlock retry is exposed as a stale-preview conflict', async () => {
  const calls = [];
  const databaseError = Object.assign(new Error('serialization failure'), { code: '40001' });
  const client = {
    async query(sql) {
      const source = String(sql);
      calls.push(source);
      if (source.includes('SELECT id FROM app_users')) return { rows: [{ id: '1' }] };
      if (source.includes('pg_advisory_xact_lock')) throw databaseError;
      return { rows: [] };
    },
    release() {},
  };
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
  await assert.rejects(repository.discardDuplicateQueries({
    requestId: '44444444-4444-4444-8444-444444444444',
    representativeTaskIds: [1],
    previewFingerprint: 'a'.repeat(64),
    confirmedDiscardCount: 0,
  }, { actor: admin }), { code: 'DUPLICATE_QUERY_PREVIEW_STALE' });
  assert.equal(calls.at(-1), 'ROLLBACK');
});

test('an exact request retry replays its receipt before locking task rows', async () => {
  const rows = [row(1), row(2)];
  const preview = buildDuplicateQueryDiscardPlan(rows, [2]);
  const response = {
    requestId: '33333333-3333-4333-8333-333333333333',
    discardedTaskIds: [2], keeperTaskIds: [1], discardedCount: 1, skippedCount: 0,
  };
  // Capture the request fingerprint generated by one ordinary run.
  const first = repositoryFixture({ rows });
  await first.repository.discardDuplicateQueries({
    requestId: response.requestId,
    representativeTaskIds: [2],
    previewFingerprint: preview.previewFingerprint,
    confirmedDiscardCount: 1,
  }, { actor: admin });
  const requestFingerprint = first.calls
    .find(({ sql }) => sql.includes('INSERT INTO task_duplicate_query_discard_requests')).values[3];

  const replay = repositoryFixture({ receipt: { request_fingerprint: requestFingerprint, response } });
  assert.deepEqual(await replay.repository.discardDuplicateQueries({
    requestId: response.requestId,
    representativeTaskIds: [2],
    previewFingerprint: preview.previewFingerprint,
    confirmedDiscardCount: 1,
  }, { actor: admin }), response);
  assert.equal(replay.calls.some(({ sql }) => sql.includes('WITH selected_identities')), false);
  assert.equal(replay.calls.some(({ sql }) => sql.includes('UPDATE tasks AS task SET')), false);
  assert.equal(replay.calls.at(-1).sql, 'COMMIT');
});

test('preview validates unique numeric IDs and rejects stale or non-admin actors before discovery', async () => {
  const fixture = repositoryFixture({ rows: [row(1)], actorActive: false });
  await assert.rejects(
    fixture.repository.previewDuplicateQueryDiscard({ representativeTaskIds: [1] }, { actor: admin }),
    { code: 'SESSION_STALE' },
  );
  assert.equal(fixture.calls.some(({ sql }) => sql.includes('WITH selected_identities')), false);

  await assert.rejects(
    fixture.repository.previewDuplicateQueryDiscard({ representativeTaskIds: [1, 1] }, { actor: admin }),
    /unique/u,
  );
  await assert.rejects(
    fixture.repository.previewDuplicateQueryDiscard({ representativeTaskIds: ['1'] }, { actor: admin }),
    /numbers/u,
  );
  await assert.rejects(
    fixture.repository.previewDuplicateQueryDiscard({ representativeTaskIds: [1] }, { actor: {
      ...admin, userId: 2, username: 'reviewer', role: 'REVIEWER',
    } }),
    { code: 'FORBIDDEN' },
  );
});

test('preview refuses an unexpectedly broad global Query match before returning a giant plan', async () => {
  const rows = Array.from({ length: 1_001 }, (_, index) => row(index + 1));
  const fixture = repositoryFixture({ rows });
  await assert.rejects(
    fixture.repository.previewDuplicateQueryDiscard({ representativeTaskIds: [1] }, { actor: admin }),
    { code: 'DUPLICATE_QUERY_SCOPE_TOO_LARGE' },
  );
  const discovery = fixture.calls.find(({ sql }) => sql.includes('WITH selected_identities'));
  assert.equal(discovery.values[1], 1_001);
  assert.equal(fixture.calls.at(-1).sql, 'ROLLBACK');
});

test('requeue restores only audited duplicate-cleanup searches and never rewrites SUCCEEDED jobs', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      const source = String(sql);
      calls.push(source);
      if (source.includes('SELECT * FROM tasks WHERE id')) {
        return { rows: [row(41, { state: 'CANCELLED', cancelled_from_state: 'COPY_QUEUED' })] };
      }
      if (source.includes('UPDATE tasks SET state = $2')) {
        return { rows: [row(41, { state: 'COPY_QUEUED', cancelled_from_state: null })] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
  await repository.requeueCancelledTask(41);
  const restore = calls.find((sql) => sql.includes('UPDATE xhs_query_search_jobs AS search'));
  assert.match(restore, /search\.task_id = \$1 AND search\.status = 'CANCELLED'/u);
  assert.match(restore, /task_duplicate_query_discard_audits/u);
  assert.match(restore, /status = 'PENDING', attempt_count = 0/u);
  for (const column of ['claimed_by_node_id', 'lease_token', 'lease_expires_at', 'retry_after', 'blocked_reason', 'error']) {
    assert.match(restore, new RegExp(`${column} = NULL`, 'u'));
  }
  assert.doesNotMatch(restore, /status = 'SUCCEEDED'/u);
});

test('migration stores immutable receipts/audits and adds the shared Query identity index', async () => {
  const sql = await readFile(new URL('../migrations/0032_duplicate_query_discard.sql', import.meta.url), 'utf8');
  assert.match(sql, /PRIMARY KEY\(actor_account_id, request_id\)/u);
  assert.match(sql, /discarded_task_id bigint NOT NULL[\s\S]*keeper_task_id bigint NOT NULL/u);
  assert.match(sql, /CHECK \(discarded_task_id <> keeper_task_id\)/u);
  assert.match(sql, /lower\(regexp_replace\(btrim\(query\), '\\s\+', ' ', 'g'\)\)/u);
  assert.doesNotMatch(sql, /REFERENCES app_users/u);
});
