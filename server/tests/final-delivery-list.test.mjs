import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertTasksReadyForDelivery,
  listAllDeliveryPoolTaskIds,
  listDeliveryPool,
} from '../src/final-delivery.mjs';

const admin = Object.freeze({
  role: 'ADMIN',
  userId: 1,
  username: 'admin',
});
const worker = Object.freeze({
  role: 'USER',
  userId: 22,
  username: 'worker',
});

function deliveryRow(id) {
  return {
    id,
    task_id: 100 + id,
    query: `query-${id}`,
    source_query_package_name: '九月选题',
    copy_revision_id: 200 + id,
    image_run_id: `run-${id}`,
    status: 'READY',
    approved_by_username: 'reviewer',
    approved_at: '2026-09-09T00:00:00.000Z',
    created_at: '2026-09-09T00:00:00.000Z',
  };
}

test('admin delivery pool page applies an exact package-name filter and returns unfiltered facets', async () => {
  const calls = [];
  const pool = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (/AS name, COUNT\(\*\)/u.test(sql)) {
        return { rows: [{ name: '九月选题', count: '51' }, { name: '十月选题', count: '7' }] };
      }
      return /COUNT\(\*\)::bigint AS total/u.test(sql)
        ? { rows: [{ total: '51' }] }
        : { rows: [deliveryRow(1)] };
    },
  };
  const page = await listDeliveryPool(pool, {
    limit: 200,
    offset: 0,
    includeTotal: true,
    queryPackageName: '  九月选题  ',
  }, admin);
  assert.equal(page.total, 51);
  assert.equal(page.items[0].taskId, 101);
  assert.equal(page.items[0].queryPackageName, '九月选题');
  assert.deepEqual(page.facets, {
    queryPackages: [{ name: '九月选题', count: 51 }, { name: '十月选题', count: 7 }],
  });
  const pageCall = calls.find(({ sql }) => /LIMIT \$2 OFFSET \$3/u.test(sql));
  const countCall = calls.find(({ sql }) => /COUNT\(\*\)::bigint AS total/u.test(sql));
  const facetCall = calls.find(({ sql }) => /AS name, COUNT\(\*\)::bigint AS count/u.test(sql));
  assert.deepEqual(pageCall.values, ['九月选题', 200, 0]);
  assert.deepEqual(countCall.values, ['九月选题']);
  assert.deepEqual(facetCall.values, []);
  assert.doesNotMatch(pageCall.sql, /task\.assigned_to_user_id/u);
  assert.doesNotMatch(countCall.sql, /task\.assigned_to_user_id/u);
  assert.doesNotMatch(facetCall.sql, /task\.assigned_to_user_id/u);
  assert.match(pageCall.sql, /task\.source_query_package_name = \$1/u);
  assert.match(countCall.sql, /task\.source_query_package_name = \$1/u);
  assert.doesNotMatch(facetCall.sql, /source_query_package_name =/u,
    'facets describe every package visible to the actor, not only the active package');
  assert.match(facetCall.sql, /source_query_package_name IS NOT NULL/u);
});

test('complete delivery snapshot is admin-only, exact-package scoped and has no pagination clause', async () => {
  let sql;
  let values;
  const pool = {
    query: async (statement, bindings) => {
      sql = statement;
      values = bindings;
      return { rows: [{ task_id: '7' }, { task_id: '8' }] };
    },
  };
  const taskIds = await listAllDeliveryPoolTaskIds(pool, admin, {
    queryPackageName: '  九月选题  ',
  });
  assert.deepEqual(taskIds, [7, 8]);
  assert.deepEqual(values, ['九月选题']);
  assert.doesNotMatch(sql, /\bLIMIT\b|\bOFFSET\b/u);
  assert.match(sql, /delivery\.status = 'READY'/u);
  assert.match(sql, /task\.source_query_package_name = \$1/u);
});

test('delivery-list services reject users before reading the database', async () => {
  let databaseReadCount = 0;
  const pool = {
    query: async () => {
      databaseReadCount += 1;
      throw new Error('database reads are forbidden for users');
    },
  };

  await assert.rejects(listDeliveryPool(pool, {
    limit: 50,
    offset: 0,
    includeTotal: true,
    queryPackageName: '九月选题',
  }, worker), { code: 'FORBIDDEN' });
  await assert.rejects(listAllDeliveryPoolTaskIds(pool, worker, {
    queryPackageName: '九月选题',
  }), { code: 'FORBIDDEN' });

  assert.equal(databaseReadCount, 0);
});

test('delivery bindings are revalidated together in one database snapshot', async () => {
  const calls = [];
  const pool = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      return { rows: [{ matched_count: 2 }] };
    },
  };
  const bindings = [
    { taskId: 7, copyRevisionId: 17, imageRunId: '11111111-1111-4111-8111-111111111111' },
    { taskId: 8, copyRevisionId: 18, imageRunId: '22222222-2222-4222-8222-222222222222' },
  ];
  assert.deepEqual(await assertTasksReadyForDelivery(pool, bindings), bindings);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /unnest\(\$1::bigint\[\], \$2::bigint\[\], \$3::uuid\[\]\)/u);
  assert.deepEqual(calls[0].values, [
    [7, 8],
    [17, 18],
    bindings.map((binding) => binding.imageRunId),
  ]);

  pool.query = async () => ({ rows: [{ matched_count: 1 }] });
  await assert.rejects(
    assertTasksReadyForDelivery(pool, bindings),
    (error) => error?.code === 'DELIVERY_VERSION_CHANGED',
  );
});
