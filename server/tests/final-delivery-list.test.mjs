import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertTasksReadyForDelivery,
  listAllDeliveryPoolTaskIds,
  listDeliveryPool,
  listDeliveryPoolTaskIdsForPreview,
  recordDeliveryPreviewLinks,
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
const clientBatchCode = 'b9759aad96a94c109fdce96ab4455294';

function deliveryRow(id) {
  return {
    id,
    task_id: 100 + id,
    query: `query-${id}`,
    source_query_package_id: 9,
    source_query_package_name: '九月选题',
    source_client_batch_code: clientBatchCode,
    copy_revision_id: 200 + id,
    image_run_id: `run-${id}`,
    status: 'READY',
    approved_by_username: 'reviewer',
    approved_at: '2026-09-09T00:00:00.000Z',
    created_at: '2026-09-09T00:00:00.000Z',
  };
}

test('admin delivery pool combines different Query packages under one exact client batch', async () => {
  const calls = [];
  const pool = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (/AS name,[\s\S]*COUNT\(\*\)/u.test(sql)) {
        return { rows: [
          { id: '9', name: '九月选题', client_batch_code: clientBatchCode, deleted: false, count: '51', unuploaded_count: '40', published_count: '10', revoked_count: '1' },
          { id: '10', name: '十月选题', client_batch_code: clientBatchCode, deleted: true, count: '7', unuploaded_count: '7', published_count: '0', revoked_count: '0' },
          { id: null, name: null, client_batch_code: null, count: '34', unuploaded_count: '34', published_count: '0', revoked_count: '0' },
        ] };
      }
      return /COUNT\(\*\)::bigint AS total/u.test(sql)
        ? { rows: [{ total: '58' }] }
        : { rows: [deliveryRow(1)] };
    },
  };
  const page = await listDeliveryPool(pool, {
    limit: 200,
    offset: 0,
    includeTotal: true,
    clientBatchCode: `  ${clientBatchCode.toUpperCase()}  `,
  }, admin);
  assert.equal(page.total, 58);
  assert.equal(page.items[0].taskId, 101);
  assert.equal(page.items[0].queryPackageName, '九月选题');
  assert.equal(page.items[0].clientBatchCode, clientBatchCode);
  assert.equal(page.items[0].packingState, 'UNPACKED');
  assert.deepEqual(page.facets, {
    queryPackages: [
      { id: 9, name: '九月选题', clientBatchCode, deleted: false, count: 51, unuploadedCount: 40, publishedCount: 10, revokedCount: 1, pendingCount: 51, packedCount: 0, updatedCount: 0 },
      { id: 10, name: '十月选题', clientBatchCode, deleted: true, count: 7, unuploadedCount: 7, publishedCount: 0, revokedCount: 0, pendingCount: 7, packedCount: 0, updatedCount: 0 },
    ],
    clientBatches: [{ code: clientBatchCode, count: 58, pendingCount: 58,
      packedCount: 0, updatedCount: 0, queryPackageCount: 2 }],
    unassigned: { count: 34, unuploadedCount: 34, publishedCount: 0, revokedCount: 0, pendingCount: 34, packedCount: 0, updatedCount: 0 },
  });
  assert.deepEqual(page.summary, {
    readyCount: 58, pendingCount: 58, packedCount: 0, updatedCount: 0,
  });
  const pageCall = calls.find(({ sql }) => /LIMIT \$2 OFFSET \$3/u.test(sql));
  const countCall = calls.find(({ sql }) => /COUNT\(\*\)::bigint AS total/u.test(sql));
  const facetCall = calls.find(({ sql }) => /AS name,[\s\S]*COUNT\(\*\)::bigint AS count/u.test(sql));
  assert.deepEqual(pageCall.values, [clientBatchCode, 200, 0]);
  assert.deepEqual(countCall.values, [clientBatchCode]);
  assert.deepEqual(facetCall.values, []);
  assert.doesNotMatch(pageCall.sql, /task\.assigned_to_user_id/u);
  assert.doesNotMatch(countCall.sql, /task\.assigned_to_user_id/u);
  assert.doesNotMatch(facetCall.sql, /task\.assigned_to_user_id/u);
  assert.match(pageCall.sql, /task\.source_client_batch_code = \$1/u);
  assert.match(countCall.sql, /task\.source_client_batch_code = \$1/u);
  assert.match(pageCall.sql, /NOT \(task\.input @> '\{"testRun":true\}'::jsonb\)/u);
  assert.match(countCall.sql, /NOT \(task\.input @> '\{"testRun":true\}'::jsonb\)/u);
  assert.match(facetCall.sql, /NOT \(task\.input @> '\{"testRun":true\}'::jsonb\)/u);
  assert.doesNotMatch(facetCall.sql, /source_query_package_name =/u,
    'facets describe every package visible to the actor, not only the active package');
  assert.doesNotMatch(facetCall.sql, /source_query_package_name IS NOT NULL/u);
  assert.doesNotMatch(facetCall.sql, /source_query_package_id IS NOT NULL/u);
  assert.match(facetCall.sql, /delivery\.preview_id IS NULL/u);
});

test('complete delivery snapshot is admin-only, exact-client-batch scoped and has no pagination clause', async () => {
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
    clientBatchCode,
  });
  assert.deepEqual(taskIds, [7, 8]);
  assert.deepEqual(values, [clientBatchCode]);
  assert.doesNotMatch(sql, /\bLIMIT\b|\bOFFSET\b/u);
  assert.match(sql, /delivery\.status = 'READY'/u);
  assert.match(sql, /task\.source_client_batch_code = \$1/u);
  assert.match(sql, /NOT \(task\.input @> '\{"testRun":true\}'::jsonb\)/u);
});

test('delivery packing state follows the exact copy and image version instead of a recycled entry id', async () => {
  const calls = [];
  const pool = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      return { rows: [deliveryRow(1)] };
    },
  };
  const items = await listDeliveryPool(pool, { packingState: 'PENDING' }, admin);
  assert.equal(items[0].packingState, 'UNPACKED');
  assert.match(calls[0].sql, /packed_item\.task_id = delivery\.task_id/u);
  assert.match(calls[0].sql, /packed_item\.copy_revision_id = delivery\.copy_revision_id/u);
  assert.match(calls[0].sql, /packed_item\.image_run_id = delivery\.image_run_id/u);
  assert.doesNotMatch(calls[0].sql, /packed_item\.delivery_entry_id = delivery\.id/u);

  calls.length = 0;
  await listAllDeliveryPoolTaskIds(pool, admin, { unpackedOnly: true });
  assert.match(calls[0].sql, /packed_item\.task_id = delivery\.task_id/u);
  assert.match(calls[0].sql, /packed_item\.copy_revision_id = delivery\.copy_revision_id/u);
  assert.match(calls[0].sql, /packed_item\.image_run_id = delivery\.image_run_id/u);
});

test('delivery rows distinguish a packed current version from a newly approved replacement', async () => {
  const pool = { query: async () => ({ rows: [{
    ...deliveryRow(1),
    delivery_batch_id: '11',
    delivery_batch_public_id: '11111111-1111-4111-8111-111111111111',
    delivery_batch_code: 'JF-11111111',
    delivery_batch_status: 'DOWNLOADED',
    delivery_batch_created_at: '2026-09-09T01:00:00.000Z',
    delivery_batch_last_downloaded_at: '2026-09-09T02:00:00.000Z',
  }, {
    ...deliveryRow(2),
    previous_delivery_batch_id: '12',
    previous_delivery_batch_public_id: '22222222-2222-4222-8222-222222222222',
    previous_delivery_batch_code: 'JF-22222222',
    previous_delivery_batch_created_at: '2026-09-09T03:00:00.000Z',
  }] }) };
  const items = await listDeliveryPool(pool, {}, admin);
  assert.equal(items[0].packingState, 'PACKED');
  assert.equal(items[0].deliveryBatch.code, 'JF-11111111');
  assert.equal(items[0].deliveryBatch.status, 'DOWNLOADED');
  assert.equal(items[1].packingState, 'VERSION_UPDATED');
  assert.equal(items[1].deliveryBatch, null);
  assert.equal(items[1].previousDeliveryBatch.code, 'JF-22222222');
});

test('preview candidate snapshot is admin-limited and excludes entries already bound to a preview', async () => {
  let sql;
  let values;
  const pool = {
    query: async (statement, bindings) => {
      sql = statement;
      values = bindings;
      return { rows: bindings[2]?.length
        ? bindings[2].map((taskId) => ({ task_id: String(taskId) }))
        : [{ task_id: '7' }, { task_id: '8' }] };
    },
  };
  assert.deepEqual(await listDeliveryPoolTaskIdsForPreview(pool, admin, {
    queryPackageIds: [9, 10],
    includeUnassigned: true,
    limit: 200,
  }), [7, 8]);
  assert.deepEqual(values, [[9, 10], true, [], 200]);
  assert.match(sql, /delivery\.preview_id IS NULL/u);
  assert.match(sql, /COALESCE\(task\.source_query_package_id, task\.source_query_package_snapshot_id\) = ANY\(\$1::bigint\[\]\)/u);
  assert.match(sql, /\$2::boolean AND task\.source_query_package_id IS NULL[\s\S]*task\.source_query_package_snapshot_id IS NULL/u);
  assert.match(sql, /cardinality\(\$3::bigint\[\]\) = 0 OR task\.id = ANY\(\$3::bigint\[\]\)/u);
  assert.match(sql, /LIMIT \$4/u);
  assert.deepEqual(await listDeliveryPoolTaskIdsForPreview(pool, admin, {
    queryPackageIds: [],
    includeUnassigned: true,
    limit: 34,
  }), [7, 8]);
  assert.deepEqual(values, [[], true, [], 34]);
  assert.deepEqual(await listDeliveryPoolTaskIdsForPreview(pool, admin, {
    queryPackageIds: [],
    includeUnassigned: true,
    testTaskId: 588,
    limit: 1,
  }), [588]);
  assert.deepEqual(values, [[], true, [588], 1]);
  assert.deepEqual(await listDeliveryPoolTaskIdsForPreview(pool, admin, {
    queryPackageIds: [9],
    taskIds: [8, 7],
    limit: 2,
  }), [8, 7]);
  assert.deepEqual(values, [[9], false, [8, 7], 2]);
  await assert.rejects(listDeliveryPoolTaskIdsForPreview(pool, admin, {
    queryPackageIds: ['9'],
    limit: 10,
  }), /positive integers/u);
  await assert.rejects(listDeliveryPoolTaskIdsForPreview(pool, admin, {
    queryPackageIds: [9],
    taskIds: [7, 8],
    limit: 1,
  }), /must match taskIds count/u);
  await assert.rejects(listDeliveryPoolTaskIdsForPreview({
    query: async () => ({ rows: [{ task_id: '7' }] }),
  }, admin, {
    queryPackageIds: [9],
    taskIds: [7, 8],
    limit: 2,
  }), (error) => error?.code === 'DELIVERY_PREVIEW_SELECTION_CHANGED');
});

test('preview noteId is saved against the exact frozen delivery version', async () => {
  const calls = [];
  const imageRunId = '11111111-1111-4111-8111-111111111111';
  const previewId = '22222222-2222-4222-8222-222222222222';
  const noteId = '0123456789abcdef0123456789abcdef';
  const queryable = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (/FOR UPDATE OF delivery/u.test(sql)) {
        return { rows: [{
          preview_id: null,
          task_id: '7',
          copy_revision_id: '107',
          image_run_id: imageRunId,
          status: 'READY',
          state: 'REVIEWED',
          current_copy_revision_id: '107',
          current_image_run_id: imageRunId,
        }] };
      }
      return { rows: [] };
    },
  };
  const saved = await recordDeliveryPreviewLinks(queryable, [{
    deliveryEntryId: 77,
    taskId: 7,
    copyRevisionId: 107,
    imageRunId,
    previewId,
    noteId,
    contentHash: 'a'.repeat(64),
    publishedAt: 1_789_000_000_000,
  }], admin);
  assert.equal(saved[0].currentReady, true);
  assert.equal(saved[0].noteId, noteId);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /WHERE delivery\.id = \$1/u);
  assert.deepEqual(calls[0].values, [77]);
  assert.match(calls[1].sql, /preview_note_id = \$3/u);
  assert.doesNotMatch(calls[1].sql, /preview_url/u);
  assert.equal(calls[1].values[1], previewId);
  assert.equal(calls[1].values[2], noteId);
  assert.equal(calls[1].values[4], admin.userId);
  assert.equal(calls[1].values[5], admin.username);
});

test('operator delivery list is limited to the current stable assignee identity', async () => {
  const calls = [];
  const pool = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (/AS name,[\s\S]*COUNT\(\*\)/u.test(sql)) return { rows: [{
        id: '9', name: '不应泄露的词包', client_batch_code: clientBatchCode,
        deleted: false, count: '1', pending_count: '1', packed_count: '0', updated_count: '0',
        unuploaded_count: '1', published_count: '0', revoked_count: '0',
      }] };
      if (/COUNT\(\*\)::bigint AS total/u.test(sql)) return { rows: [{ total: '1' }] };
      return { rows: [deliveryRow(1)] };
    },
  };
  const page = await listDeliveryPool(pool, {
    limit: 50,
    offset: 0,
    includeTotal: true,
  }, worker);
  assert.equal(page.items[0].taskId, 101);
  assert.equal(page.items[0].queryPackageId, null);
  assert.equal(page.items[0].queryPackageName, null);
  assert.equal(page.items[0].clientBatchCode, null);
  assert.deepEqual(page.facets, { queryPackages: [], clientBatches: [], unassigned: null });
  assert.deepEqual(page.summary, { readyCount: 1, pendingCount: 1, packedCount: 0, updatedCount: 0 });
  assert.equal(calls.length, 3);
  const pageCall = calls.find(({ sql }) => /ORDER BY delivery\.approved_at[\s\S]*LIMIT/u.test(sql));
  assert.deepEqual(pageCall.values, [worker.username, worker.userId, 50, 0]);
  assert.match(pageCall.sql, /task\.assigned_to_user_id = \$1/u);
  assert.match(pageCall.sql, /assignee\.id = \$2/u);
  assert.match(pageCall.sql, /assignee\.username = task\.assigned_to_user_id/u);
  assert.match(pageCall.sql, /assignee\.created_at < task\.assigned_at/u);

  const deniedPool = { query: async () => assert.fail('admin-only operations must fail before PostgreSQL') };
  await assert.rejects(listAllDeliveryPoolTaskIds(deniedPool, worker, {
    queryPackageName: '九月选题',
  }), { code: 'FORBIDDEN' });
  await assert.rejects(listDeliveryPoolTaskIdsForPreview(deniedPool, worker, {
    queryPackageIds: [9],
    limit: 1,
  }), { code: 'FORBIDDEN' });
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
