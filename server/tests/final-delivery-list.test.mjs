import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertTasksReadyForDelivery,
  listAllDeliveryPoolTaskIds,
  listDeliveryPool,
} from '../src/final-delivery.mjs';

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
    copy_revision_id: 200 + id,
    image_run_id: `run-${id}`,
    status: 'READY',
    approved_by_username: 'reviewer',
    approved_at: '2026-09-09T00:00:00.000Z',
    created_at: '2026-09-09T00:00:00.000Z',
  };
}

test('delivery pool page returns an authoritative total while preserving worker visibility parameters', async () => {
  const calls = [];
  const pool = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      return /COUNT\(\*\)/u.test(sql)
        ? { rows: [{ total: '51' }] }
        : { rows: [deliveryRow(1)] };
    },
  };
  const page = await listDeliveryPool(pool, {
    limit: 200,
    offset: 0,
    includeTotal: true,
  }, worker);
  assert.equal(page.total, 51);
  assert.equal(page.items[0].taskId, 101);
  const pageCall = calls.find(({ sql }) => /LIMIT \$3 OFFSET \$4/u.test(sql));
  const countCall = calls.find(({ sql }) => /COUNT\(\*\)/u.test(sql));
  assert.deepEqual(pageCall.values, ['worker', 22, 200, 0]);
  assert.deepEqual(countCall.values, ['worker', 22]);
  assert.match(pageCall.sql, /task\.assigned_to_user_id = \$1/u);
  assert.match(countCall.sql, /task\.assigned_to_user_id = \$1/u);
});

test('complete delivery snapshot is admin-only and has no pagination clause', async () => {
  let sql;
  const pool = {
    query: async (statement) => {
      sql = statement;
      return { rows: [{ task_id: '7' }, { task_id: '8' }] };
    },
  };
  const taskIds = await listAllDeliveryPoolTaskIds(pool, {
    role: 'ADMIN', userId: 1, username: 'admin',
  });
  assert.deepEqual(taskIds, [7, 8]);
  assert.doesNotMatch(sql, /\bLIMIT\b|\bOFFSET\b/u);
  assert.match(sql, /delivery\.status = 'READY'/u);
  await assert.rejects(
    listAllDeliveryPoolTaskIds(pool, worker),
    (error) => error?.code === 'FORBIDDEN',
  );
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
