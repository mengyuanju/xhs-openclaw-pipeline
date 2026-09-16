import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  confirmDeliveryBatch,
  createDeliveryBatch,
  deliveryBatchCode,
  listDeliveryBatches,
  recordDeliveryBatchDownload,
} from '../src/delivery-batches.mjs';

const PUBLIC_ID = '12345678-1234-4234-8234-123456789abc';
const IMAGE_RUN_ID = '22345678-1234-4234-8234-123456789abc';
const CLIENT_BATCH_CODE = 'b9759aad96a94c109fdce96ab4455294';
const ACTOR = { userId: 7, username: 'Admin', role: 'ADMIN' };
const OPERATOR = { userId: 12, username: 'Alice', role: 'USER' };

function batchRow(overrides = {}) {
  return {
    id: 8,
    public_id: PUBLIC_ID,
    code: 'JF-12345678',
    scope: 'QUERY_PACKAGE',
    query_package_name: '九月选题',
    client_batch_code: null,
    status: 'GENERATED',
    archive_file_name: 'JF-12345678-九月选题-交付资源.zip',
    archive_byte_size: '2048',
    archive_sha256: 'a'.repeat(64),
    task_count: 1,
    created_by_account_id: 7,
    created_by_username: 'admin',
    created_at: '2026-09-15T00:00:00.000Z',
    first_downloaded_at: null,
    last_downloaded_at: null,
    download_count: 0,
    ...overrides,
  };
}

test('delivery batch migration stores immutable version members and download events', async () => {
  const sql = await readFile(new URL('../migrations/0054_delivery_batches.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE delivery_batches/u);
  assert.match(sql, /UNIQUE\(task_id, copy_revision_id, image_run_id\)/u);
  assert.match(sql, /CREATE TABLE delivery_batch_download_events/u);
  assert.match(sql, /delivery batch history is append-only/u);
  assert.doesNotMatch(sql, /delivery_entry_id bigint REFERENCES/u,
    'history must survive later task or delivery-entry removal');
});

test('operator delivery migration records origin and an explicit append-only confirmation', async () => {
  const sql = await readFile(
    new URL('../migrations/0061_operator_delivery_batches.sql', import.meta.url),
    'utf8',
  );
  assert.match(sql, /OPERATOR_DELIVERY/u);
  assert.match(sql, /status IN \('GENERATED', 'DOWNLOADED', 'DELIVERED'\)/u);
  assert.match(sql, /CREATE TABLE delivery_batch_confirmation_events/u);
  assert.match(sql, /delivery_batch_confirmation_events_append_only/u);
});

test('one client-batch manifest combines immutable members from different Query packages', async () => {
  const secondImageRunId = '32345678-1234-4234-8234-123456789abc';
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('FOR UPDATE OF delivery')) return { rows: [{
      delivery_entry_id: 31, task_id: 11, copy_revision_id: 21,
      image_run_id: IMAGE_RUN_ID, query: '桌面收纳', source_query_package_id: 4,
      source_query_package_snapshot_id: null, source_query_package_name: '九月选题',
      source_client_batch_code: CLIENT_BATCH_CODE,
    }, {
      delivery_entry_id: 32, task_id: 12, copy_revision_id: 22,
      image_run_id: secondImageRunId, query: '衣柜分区', source_query_package_id: 5,
      source_query_package_snapshot_id: null, source_query_package_name: '九月补充词包',
      source_client_batch_code: CLIENT_BATCH_CODE,
    }] };
    if (sql.includes('JOIN delivery_batch_items AS existing')) return { rows: [] };
    if (sql.includes('INSERT INTO delivery_batches')) return { rows: [batchRow({
      scope: 'CLIENT_BATCH', query_package_name: null, client_batch_code: CLIENT_BATCH_CODE,
      archive_file_name: `${CLIENT_BATCH_CODE}-交付资源.zip`, task_count: 2,
    })] };
    if (sql.includes('INSERT INTO delivery_batch_items')) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  } };

  const created = await createDeliveryBatch(client, {
    publicId: PUBLIC_ID,
    scope: 'CLIENT_BATCH',
    clientBatchCode: CLIENT_BATCH_CODE.toUpperCase(),
    fileName: `${CLIENT_BATCH_CODE}-交付资源.zip`,
    byteSize: 2048,
    sha256: 'a'.repeat(64),
    bindings: [
      { taskId: 11, copyRevisionId: 21, imageRunId: IMAGE_RUN_ID },
      { taskId: 12, copyRevisionId: 22, imageRunId: secondImageRunId },
    ],
  }, ACTOR);

  assert.equal(created.clientBatchCode, CLIENT_BATCH_CODE);
  assert.deepEqual(created.queryPackageNames, ['九月选题', '九月补充词包']);
  const header = calls.find((call) => call.sql.includes('INSERT INTO delivery_batches'));
  assert.equal(header.values[4], CLIENT_BATCH_CODE);
  const manifest = calls.find((call) => call.sql.includes('INSERT INTO delivery_batch_items'));
  assert.deepEqual(manifest.values[8], [CLIENT_BATCH_CODE, CLIENT_BATCH_CODE]);
});

test('creating a delivery batch locks READY versions and writes one immutable manifest', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('FOR UPDATE OF delivery')) return { rows: [{
      delivery_entry_id: 31,
      task_id: 11,
      copy_revision_id: 21,
      image_run_id: IMAGE_RUN_ID,
      query: '桌面收纳',
      source_query_package_id: 4,
      source_query_package_snapshot_id: null,
      source_query_package_name: '九月选题',
    }] };
    if (sql.includes('JOIN delivery_batch_items AS existing')) return { rows: [] };
    if (sql.includes('INSERT INTO delivery_batches')) return { rows: [batchRow()] };
    if (sql.includes('INSERT INTO delivery_batch_items')) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  } };

  const created = await createDeliveryBatch(client, {
    publicId: PUBLIC_ID,
    scope: 'QUERY_PACKAGE',
    queryPackageName: ' 九月选题 ',
    fileName: 'JF-12345678-九月选题-交付资源.zip',
    byteSize: 2048,
    sha256: 'a'.repeat(64),
    bindings: [{ taskId: 11, copyRevisionId: 21, imageRunId: IMAGE_RUN_ID }],
  }, ACTOR);

  assert.equal(deliveryBatchCode(PUBLIC_ID), 'JF-12345678');
  assert.equal(created.code, 'JF-12345678');
  assert.deepEqual(created.queryPackageNames, ['九月选题']);
  const manifest = calls.find((call) => call.sql.includes('INSERT INTO delivery_batch_items'));
  assert.deepEqual(manifest.values.slice(1, 5), [[31], [11], [21], [IMAGE_RUN_ID]]);
  assert.ok(calls[0].sql.includes('ORDER BY delivery.id'));
});

test('an already packed version is rejected with its original batch code', async () => {
  const client = { query: async (sql) => {
    if (sql.includes('FOR UPDATE OF delivery')) return { rows: [{
      delivery_entry_id: 31, task_id: 11, copy_revision_id: 21,
      image_run_id: IMAGE_RUN_ID, query: '桌面收纳',
      source_query_package_id: 4, source_query_package_name: '九月选题',
    }] };
    if (sql.includes('JOIN delivery_batch_items AS existing')) {
      return { rows: [{ task_id: 11, code: 'JF-AAAAAAAA' }] };
    }
    throw new Error('unexpected mutation');
  } };
  await assert.rejects(createDeliveryBatch(client, {
    publicId: PUBLIC_ID,
    scope: 'SELECTED',
    fileName: 'JF-12345678-已选资源.zip',
    byteSize: 9,
    sha256: 'b'.repeat(64),
    bindings: [{ taskId: 11, copyRevisionId: 21, imageRunId: IMAGE_RUN_ID }],
  }, ACTOR), { code: 'DELIVERY_ALREADY_PACKED' });
});

test('an operator can create a selected batch only for the stable current assignee', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('FOR UPDATE OF delivery')) return { rows: [{
      delivery_entry_id: 31, task_id: 11, copy_revision_id: 21,
      image_run_id: IMAGE_RUN_ID, query: '桌面收纳',
      source_query_package_id: 4, source_query_package_snapshot_id: null,
      source_query_package_name: '九月选题', source_client_batch_code: CLIENT_BATCH_CODE,
      assigned_to_user_id: 'alice', assigned_to_account_id: 12,
    }] };
    if (sql.includes('JOIN delivery_batch_items AS existing')) return { rows: [] };
    if (sql.includes('INSERT INTO delivery_batches')) return { rows: [batchRow({
      scope: 'SELECTED', query_package_name: null, client_batch_code: null,
      batch_kind: 'OPERATOR_DELIVERY', created_by_role: 'USER',
      created_by_account_id: 12, created_by_username: 'alice',
    })] };
    if (sql.includes('INSERT INTO delivery_batch_items')) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  } };

  const created = await createDeliveryBatch(client, {
    publicId: PUBLIC_ID,
    scope: 'SELECTED',
    fileName: 'JF-12345678-交付池-已选资源.zip',
    byteSize: 2048,
    sha256: 'a'.repeat(64),
    bindings: [{ taskId: 11, copyRevisionId: 21, imageRunId: IMAGE_RUN_ID }],
  }, OPERATOR);

  assert.equal(created.batchKind, 'OPERATOR_DELIVERY');
  assert.equal(created.createdByRole, 'USER');
  const header = calls.find((call) => call.sql.includes('INSERT INTO delivery_batches'));
  assert.deepEqual(header.values.slice(-2), ['OPERATOR_DELIVERY', 'USER']);

  await assert.rejects(createDeliveryBatch({ query: async (sql) => {
    if (sql.includes('FOR UPDATE OF delivery')) return { rows: [{
      delivery_entry_id: 31, task_id: 11, copy_revision_id: 21,
      image_run_id: IMAGE_RUN_ID, query: '桌面收纳',
      assigned_to_user_id: 'bob', assigned_to_account_id: 19,
    }] };
    throw new Error('operator ownership must reject before writing');
  } }, {
    publicId: PUBLIC_ID,
    scope: 'SELECTED',
    fileName: 'JF-12345678-交付池-已选资源.zip',
    byteSize: 2048,
    sha256: 'a'.repeat(64),
    bindings: [{ taskId: 11, copyRevisionId: 21, imageRunId: IMAGE_RUN_ID }],
  }, OPERATOR), { code: 'FORBIDDEN' });

  await assert.rejects(createDeliveryBatch({ query: async () => {
    throw new Error('invalid scope must reject before querying');
  } }, {
    publicId: PUBLIC_ID,
    scope: 'ALL_READY',
    fileName: 'JF-12345678-交付池.zip',
    byteSize: 2048,
    sha256: 'a'.repeat(64),
    bindings: [{ taskId: 11, copyRevisionId: 21, imageRunId: IMAGE_RUN_ID }],
  }, OPERATOR), { code: 'FORBIDDEN' });
});

test('operators list only delivery batches created by their stable account identity', async () => {
  const calls = [];
  const pool = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('SELECT COUNT(*)')) return { rows: [{ total: '1' }] };
    return { rows: [batchRow({
      scope: 'SELECTED', query_package_name: null,
      batch_kind: 'OPERATOR_DELIVERY', created_by_role: 'USER',
      created_by_account_id: 12, created_by_username: 'alice',
    })] };
  } };
  const page = await listDeliveryBatches(pool, {}, OPERATOR);
  assert.equal(page.items[0].batchKind, 'OPERATOR_DELIVERY');
  for (const call of calls) {
    assert.match(call.sql, /created_by_account_id = \$1/u);
    assert.match(call.sql, /created_by_username = \$2/u);
    assert.deepEqual(call.values.slice(0, 2), [12, 'alice']);
  }
});

test('successful downloads update the batch and append an actor event', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('UPDATE delivery_batches')) return { rows: [batchRow({
      status: 'DOWNLOADED', download_count: 2,
      first_downloaded_at: '2026-09-15T00:01:00.000Z',
      last_downloaded_at: '2026-09-15T00:02:00.000Z',
    })] };
    if (sql.includes('INSERT INTO delivery_batch_download_events')) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  } };
  const result = await recordDeliveryBatchDownload(client, PUBLIC_ID, ACTOR);
  assert.equal(result.downloadCount, 2);
  assert.deepEqual(calls[1].values, [8, 7, 'admin']);
});

test('delivery confirmation is allowed only after a completed download and is idempotent', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('SELECT * FROM delivery_batches')) return { rows: [batchRow({
      scope: 'SELECTED', query_package_name: null, status: 'DOWNLOADED', download_count: 1,
      batch_kind: 'OPERATOR_DELIVERY', created_by_role: 'USER',
      created_by_account_id: 12, created_by_username: 'alice',
    })] };
    if (sql.includes('UPDATE delivery_batches')) return { rows: [batchRow({
      scope: 'SELECTED', query_package_name: null, status: 'DELIVERED', download_count: 1,
      batch_kind: 'OPERATOR_DELIVERY', created_by_role: 'USER',
      created_by_account_id: 12, created_by_username: 'alice',
      delivered_at: '2026-09-15T00:03:00.000Z', delivered_by_account_id: 12,
      delivered_by_username: 'alice',
    })] };
    if (sql.includes('INSERT INTO delivery_batch_confirmation_events')) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  } };
  const result = await confirmDeliveryBatch(client, PUBLIC_ID, OPERATOR);
  assert.equal(result.status, 'DELIVERED');
  assert.equal(result.deliveredByUsername, 'alice');
  assert.deepEqual(calls.at(-1).values, [8, 12, 'alice']);

  const alreadyDelivered = batchRow({
    scope: 'SELECTED', query_package_name: null, status: 'DELIVERED', download_count: 1,
    batch_kind: 'OPERATOR_DELIVERY', created_by_role: 'USER',
    created_by_account_id: 12, created_by_username: 'alice',
    delivered_at: '2026-09-15T00:03:00.000Z', delivered_by_account_id: 12,
    delivered_by_username: 'alice',
  });
  const replay = await confirmDeliveryBatch({ query: async () => ({ rows: [alreadyDelivered] }) },
    PUBLIC_ID, OPERATOR);
  assert.equal(replay.status, 'DELIVERED');

  await assert.rejects(confirmDeliveryBatch({ query: async () => ({ rows: [batchRow()] }) },
    PUBLIC_ID, ACTOR), { code: 'DELIVERY_BATCH_NOT_DOWNLOADED' });
});
