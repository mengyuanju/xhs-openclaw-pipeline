import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createDeliveryBatch,
  deliveryBatchCode,
  recordDeliveryBatchDownload,
} from '../src/delivery-batches.mjs';

const PUBLIC_ID = '12345678-1234-4234-8234-123456789abc';
const IMAGE_RUN_ID = '22345678-1234-4234-8234-123456789abc';
const ACTOR = { userId: 7, username: 'Admin', role: 'ADMIN' };

function batchRow(overrides = {}) {
  return {
    id: 8,
    public_id: PUBLIC_ID,
    code: 'JF-12345678',
    scope: 'QUERY_PACKAGE',
    query_package_name: '九月选题',
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
