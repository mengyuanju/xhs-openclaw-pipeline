import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  claimXhsQuerySearch,
  completeXhsQuerySearch,
  retryFailedXhsQuerySearch,
} from '../src/xhs-query-search.mjs';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import {
  XIAOHONGSHU_SEARCH_PROTOCOL_VERSION,
  XIAOHONGSHU_SEARCH_SETTINGS_KEY,
} from '../../src/xhs-query-search.mjs';

function fakeSearchDatabase({ resultLimit = 3 } = {}) {
  const state = {
    settings: { resultLimit },
    job: {
      id: 51,
      query_package_item_id: 91,
      task_id: null,
      query_snapshot: '桌面收纳',
      status: 'PENDING',
      attempt_count: 0,
      claimed_by_node_id: null,
      lease_token: null,
      lease_expires_at: null,
      retry_after: null,
      blocked_reason: null,
      result_limit: 3,
      result_count: 0,
      searched_at: null,
      updated_at: new Date('2026-09-10T01:00:00.000Z'),
    },
    links: [],
  };
  const query = async (sql, values = []) => {
    const source = String(sql).replace(/\s+/gu, ' ').trim();
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(source)) return { rows: [] };
    if (source.startsWith('INSERT INTO xhs_query_search_nodes')) return { rows: [] };
    if (source.startsWith('SELECT id FROM xhs_query_search_nodes')) return { rows: [{ id: values[0] }] };
    if (source.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}] };
    if (source.startsWith('UPDATE xhs_query_search_jobs') && source.includes('lease_expires_at <= now()')) {
      return { rows: [] };
    }
    if (source.startsWith('SELECT id FROM xhs_query_search_jobs')
        && source.includes("status = 'RUNNING' OR status = 'BLOCKED'")) return { rows: [] };
    if (source.startsWith('SELECT job.id') && source.includes('FOR UPDATE OF job SKIP LOCKED')) {
      return { rows: state.job.status === 'PENDING' ? [{ id: state.job.id }] : [] };
    }
    if (source.startsWith('SELECT value FROM global_settings') && source.includes('FOR SHARE')) {
      assert.equal(values[0], XIAOHONGSHU_SEARCH_SETTINGS_KEY);
      return { rows: [{ value: structuredClone(state.settings) }] };
    }
    if (source.startsWith('UPDATE xhs_query_search_jobs') && source.includes("status = 'RUNNING'")) {
      Object.assign(state.job, {
        status: 'RUNNING',
        attempt_count: state.job.attempt_count + 1,
        claimed_by_node_id: values[1],
        lease_token: values[2],
        lease_expires_at: new Date('2026-09-10T01:05:00.000Z'),
        result_limit: Number(values[4]),
      });
      return { rows: [{ ...state.job }] };
    }
    if (source.startsWith('SELECT job.*, job.lease_expires_at')) {
      return { rows: [{ ...state.job, source_active: true, lease_active: true }] };
    }
    if (source.startsWith('DELETE FROM xhs_query_links')) {
      state.links = [];
      return { rows: [] };
    }
    if (source.startsWith('INSERT INTO xhs_query_links')) {
      state.links = JSON.parse(values[1]);
      return { rows: [] };
    }
    if (source.startsWith('UPDATE xhs_query_search_jobs') && source.includes("status = 'SUCCEEDED'")) {
      Object.assign(state.job, {
        status: 'SUCCEEDED',
        result_count: Number(values[1]),
        claimed_by_node_id: null,
        lease_token: null,
        lease_expires_at: null,
      });
      return { rows: [{ ...state.job }] };
    }
    if (source.startsWith('UPDATE xhs_query_search_jobs AS job')
        && source.includes("WHERE job.status = 'FAILED'")) {
      const matchesJob = values[0] === null || Number(values[0]) === state.job.id;
      const matchesTask = values[1] === null || Number(values[1]) === state.job.task_id;
      if (state.job.status !== 'FAILED' || !matchesJob || !matchesTask) return { rows: [] };
      Object.assign(state.job, {
        status: 'PENDING',
        attempt_count: 0,
        claimed_by_node_id: null,
        lease_token: null,
        lease_expires_at: null,
        retry_after: null,
        blocked_reason: null,
        result_count: 0,
        searched_at: null,
      });
      return { rows: [{ id: state.job.id }] };
    }
    throw new Error(`unexpected SQL: ${source}`);
  };
  const client = { query, release() {} };
  return { state, pool: { connect: async () => client, query } };
}

test('central search job claim and completion use a lease and store only normalized note links', async () => {
  const fixture = fakeSearchDatabase();
  const claim = await claimXhsQuerySearch(fixture.pool, {
    nodeId: 'search-node',
    protocolVersion: XIAOHONGSHU_SEARCH_PROTOCOL_VERSION,
  });
  assert.equal(claim.query, '桌面收纳');
  assert.equal(claim.status, 'RUNNING');
  assert.equal(claim.attempt, 1);
  assert.equal(claim.resultLimit, 3);
  assert.match(claim.leaseToken, /^[0-9a-f-]{36}$/u);
  const completed = await completeXhsQuerySearch(fixture.pool, claim.id, {
    leaseToken: claim.leaseToken,
    links: [
      { url: '/explore/66f000000000000000000000?xsec_token=token%3D&xsec_source=pc_search', title: '第一条' },
      { url: '/explore/77f000000000000000000001?xsec_token=token_two%3D&xsec_source=pc_search', title: '第二条' },
      { url: '/explore/88f000000000000000000002?xsec_token=token_three%3D&xsec_source=pc_search', title: '第三条' },
    ],
  });
  assert.equal(completed.status, 'SUCCEEDED');
  assert.equal(completed.resultCount, 3);
  assert.deepEqual(fixture.state.links.map((link) => [link.title, link.rank]), [
    ['第一条', 1],
    ['第二条', 2],
    ['第三条', 3],
  ]);
  assert.equal(
    new URL(fixture.state.links[0].url).searchParams.get('xsec_token'),
    'token=',
  );
});

test('central completion rejects unranked overflow and unusable bare links', async () => {
  const valid = (index) => ({
    url: `/explore/${String(index).padStart(24, '0')}?xsec_token=token_${index}%3D&xsec_source=pc_search`,
    title: `第 ${index} 条`,
  });
  for (const links of [
    [valid(1), valid(2), valid(3), valid(4)],
    [{ url: '/explore/66f000000000000000000000', title: '没有访问参数' }],
  ]) {
    const fixture = fakeSearchDatabase();
    const claim = await claimXhsQuerySearch(fixture.pool, {
      nodeId: 'search-node',
      protocolVersion: XIAOHONGSHU_SEARCH_PROTOCOL_VERSION,
    });
    await assert.rejects(completeXhsQuerySearch(fixture.pool, claim.id, {
      leaseToken: claim.leaseToken,
      links,
    }), /at most 3|signed note URLs/u);
    assert.deepEqual(fixture.state.links, []);
  }
});

test('claim requires protocol v3 and freezes the administrator result limit', async () => {
  const fixture = fakeSearchDatabase({ resultLimit: 10 });
  await assert.rejects(
    claimXhsQuerySearch(fixture.pool, { nodeId: 'legacy-search-node' }),
    /protocolVersion must be 3/u,
  );
  assert.equal(fixture.state.job.status, 'PENDING');

  const claim = await claimXhsQuerySearch(fixture.pool, {
    nodeId: 'search-node',
    protocolVersion: XIAOHONGSHU_SEARCH_PROTOCOL_VERSION,
  });
  assert.equal(claim.resultLimit, 10);
  assert.equal(fixture.state.job.result_limit, 10);

  fixture.state.settings.resultLimit = 1;
  const links = Array.from({ length: 4 }, (_, index) => ({
    url: `/explore/${String(index + 1).padStart(24, '0')}?xsec_token=frozen_${index}%3D&xsec_source=pc_search`,
    title: `冻结结果 ${index + 1}`,
  }));
  const completed = await completeXhsQuerySearch(fixture.pool, claim.id, {
    leaseToken: claim.leaseToken,
    links,
  });
  assert.equal(completed.resultLimit, 10);
  assert.equal(completed.resultCount, 4);
  assert.equal(fixture.state.links.length, 4);
});

test('completion enforces the limit frozen on its own claimed job', async () => {
  const fixture = fakeSearchDatabase({ resultLimit: 1 });
  const claim = await claimXhsQuerySearch(fixture.pool, {
    nodeId: 'search-node',
    protocolVersion: XIAOHONGSHU_SEARCH_PROTOCOL_VERSION,
  });
  const links = [1, 2].map((index) => ({
    url: `/explore/${String(index).padStart(24, '0')}?xsec_token=limited_${index}%3D&xsec_source=pc_search`,
  }));
  await assert.rejects(completeXhsQuerySearch(fixture.pool, claim.id, {
    leaseToken: claim.leaseToken,
    links,
  }), /at most 1 ranked link/u);
  assert.deepEqual(fixture.state.links, []);
});

test('the administrator Xiaohongshu setting is strictly normalized before persistence', async () => {
  const writes = [];
  const repository = new PostgresControlPlaneRepository({ pool: {
    async query(sql, values) {
      writes.push({ sql: String(sql), values });
      return { rows: [{
        key: values[0], value: values[1], version: 2,
        updated_at: new Date('2026-09-10T02:00:00.000Z'),
      }] };
    },
  } });

  const saved = await repository.upsertSetting(XIAOHONGSHU_SEARCH_SETTINGS_KEY, {
    resultLimit: 10,
  });
  assert.deepEqual(saved.value, { resultLimit: 10 });
  assert.equal(saved.version, 2);
  for (const value of [
    { resultLimit: 0 },
    { resultLimit: 11 },
    { resultLimit: 1.5 },
    { resultLimit: '5' },
    { resultLimit: 5, extra: true },
  ]) {
    await assert.rejects(
      repository.upsertSetting(XIAOHONGSHU_SEARCH_SETTINGS_KEY, value),
      /resultLimit|unsupported fields/u,
    );
  }
  assert.equal(writes.length, 1, 'invalid settings must be rejected before PostgreSQL is called');
});

test('health advertises the administrator-controlled Xiaohongshu search protocol', async () => {
  const repository = new PostgresControlPlaneRepository({ pool: {
    query: async () => ({ rows: [{ now: new Date('2026-09-10T02:00:00.000Z') }] }),
  } });
  const health = await repository.health();
  assert.equal(health.capabilities.xiaohongshuQuerySearchVersion, 3);
});

test('screening SQL queues selected rows and cancels unfinished rejected rows atomically', async () => {
  const source = await readFile(new URL('../src/query-packages.mjs', import.meta.url), 'utf8');
  assert.match(source, /queued_xhs_searches AS \([\s\S]*requested\.decision = 'SELECTED'/u);
  assert.match(source, /ON CONFLICT\(query_package_item_id\) DO UPDATE/u);
  assert.match(source, /cancelled_xhs_searches AS \([\s\S]*requested\.decision = 'REJECTED'[\s\S]*job\.status <> 'SUCCEEDED'/u);
  assert.match(source, /query package production did not bind every task to its Xiaohongshu search/u);
  assert.match(source, /job\.task_id IS NULL[\s\S]*job\.status NOT IN \('SUCCEEDED', 'CANCELLED'\)/u);
});

test('search rows bind to durable tasks and login resume never resets ordinary failures', async () => {
  const migration = await readFile(new URL('../migrations/0031_xhs_query_search.sql', import.meta.url), 'utf8');
  const resultLimitMigration = await readFile(
    new URL('../migrations/0034_xhs_query_search_result_limit.sql', import.meta.url),
    'utf8',
  );
  const service = await readFile(new URL('../src/xhs-query-search.mjs', import.meta.url), 'utf8');
  assert.match(migration, /query_package_item_id bigint UNIQUE[\s\S]*ON DELETE SET NULL/u);
  assert.match(migration, /task_id bigint UNIQUE REFERENCES tasks\(id\) ON DELETE CASCADE/u);
  assert.match(migration, /CREATE TABLE xhs_query_search_nodes/u);
  assert.match(migration, /claimed_by_node_id varchar\(100\) REFERENCES xhs_query_search_nodes\(id\)/u);
  assert.doesNotMatch(service, /INSERT INTO executor_nodes/u);
  assert.match(migration, /SET task_id = task\.id[\s\S]*task\.source_query_package_item_id = job\.query_package_item_id/u);
  assert.match(service, /WHERE job\.status = 'BLOCKED'/u);
  assert.doesNotMatch(service, /job\.status IN \('BLOCKED', 'FAILED'\)/u);
  assert.match(service, /WHERE job\.status = 'FAILED'/u);
  assert.match(resultLimitMigration, /VALUES \('xhs_query_search', '\{"resultLimit":3\}'::jsonb\)/u);
  assert.match(resultLimitMigration, /ADD COLUMN result_limit smallint NOT NULL DEFAULT 3/u);
  assert.match(resultLimitMigration, /CHECK \(result_limit BETWEEN 1 AND 10\)/u);
});

test('failed searches require an explicit manual retry and receive a fresh attempt budget', async () => {
  const fixture = fakeSearchDatabase();
  Object.assign(fixture.state.job, { status: 'FAILED', attempt_count: 3 });
  await assert.rejects(retryFailedXhsQuerySearch(fixture.pool), /exactly one/u);
  await assert.rejects(
    retryFailedXhsQuerySearch(fixture.pool, { jobId: 51, taskId: 42 }),
    /exactly one/u,
  );
  assert.deepEqual(await retryFailedXhsQuerySearch(fixture.pool, { jobId: 51 }), {
    retriedCount: 1,
  });
  assert.equal(fixture.state.job.status, 'PENDING');
  assert.equal(fixture.state.job.attempt_count, 0);
  assert.deepEqual(await retryFailedXhsQuerySearch(fixture.pool, { jobId: 51 }), {
    retriedCount: 0,
  });
});

test('Xiaohongshu machine routes require their independent machine token', async () => {
  const token = 'test-only-xhs-machine-token-at-least-32-characters';
  const app = createControlPlaneApp({
    repository: {
      claimXhsQuerySearch: async () => null,
      retryFailedXhsQuerySearch: async () => ({ retriedCount: 2 }),
    },
    storageRoot: 'unused',
    enforceUserAuth: true,
    xhsSearchMachineToken: token,
  });
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  const root = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = JSON.stringify({ nodeId: 'search-node' });
    assert.equal((await fetch(`${root}/v1/xhs-query-search/claim`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    })).status, 401);
    assert.equal((await fetch(`${root}/v1/xhs-query-search/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-xhs-search-token': token },
      body,
    })).status, 200);
    const retryResponse = await fetch(`${root}/v1/xhs-query-search/retry-failed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-xhs-search-token': token },
      body: JSON.stringify({ jobId: 51 }),
    });
    assert.equal(retryResponse.status, 200);
    assert.equal((await retryResponse.json()).data.retriedCount, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('task detail and delivery source expose only selected successful links with a stable empty default', async () => {
  const queries = [];
  const link = {
    noteId: '66f000000000000000000000',
    url: 'https://www.xiaohongshu.com/explore/66f000000000000000000000',
    title: '桌面整理案例',
    rank: 1,
  };
  const repository = new PostgresControlPlaneRepository({ pool: {
    async query(sql) {
      const source = String(sql);
      queries.push(source);
      if (source.includes('WITH task AS')) return { rows: [{
        id: 41,
        query: '桌面收纳',
        input: {},
        requested_image_count: 'auto',
        state: 'COPY_REVIEW_PENDING',
        created_by_node_id: 'node',
        source_query_package_item_id: 91,
        current_copy_revision_id: null,
        current_image_run_id: null,
        current_execution_id: null,
        progress_percent: 100,
        progress_message: '',
        xiaohongshu_links: [link],
        xiaohongshu_search_status: 'SUCCEEDED',
        xiaohongshu_search_blocked_reason: null,
      }] };
      return { rows: [] };
    },
  } });
  const detail = await repository.getTask(41);
  assert.deepEqual(detail.xiaohongshuLinks, [link]);
  assert.equal(detail.xiaohongshuSearchStatus, 'SUCCEEDED');
  assert.ok(queries.some((sql) => sql.includes("search.status = 'SUCCEEDED'")
    && sql.includes('search.task_id = task.id')));

  const emptyRepository = new PostgresControlPlaneRepository({ pool: {
    async query(sql) {
      if (!String(sql).includes('WITH task AS')) return { rows: [] };
      return { rows: [{
        id: 42, query: '普通任务', input: {}, requested_image_count: 'auto', state: 'COPY_QUEUED',
        created_by_node_id: 'node', current_copy_revision_id: null, current_image_run_id: null,
        current_execution_id: null, progress_percent: 0, progress_message: '',
      }] };
    },
  } });
  assert.deepEqual((await emptyRepository.getTask(42)).xiaohongshuLinks, []);
});
