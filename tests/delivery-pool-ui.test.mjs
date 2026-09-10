import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DELIVERY_POOL_LIST_LIMIT,
  DELIVERY_POOL_SELECTION_LIMIT,
  mergeDeliveryPoolEntries,
  normalizeDeliveryPoolPage,
  normalizePreparedDeliveryExport,
  updateTaskSelection,
} from '../app/delivery-pool/types.ts';

const workbenchUrl = new URL('../app/delivery-pool/delivery-pool-workbench.tsx', import.meta.url);
const proxyUrl = new URL('../app/api/control-plane/[...path]/route.ts', import.meta.url);

function entry(id, overrides = {}) {
  return {
    id,
    taskId: 100 + id,
    query: `query-${id}`,
    copyRevisionId: 200 + id,
    imageRunId: `run-${id}`,
    status: 'READY',
    approvedAt: '2026-09-09T00:00:00.000Z',
    ...overrides,
  };
}

test('delivery pool list adapter preserves server total and rejects non-READY rows', () => {
  assert.equal(DELIVERY_POOL_LIST_LIMIT, 200);
  assert.equal(DELIVERY_POOL_SELECTION_LIMIT, 200);
  assert.deepEqual(normalizeDeliveryPoolPage({
    items: [entry(1), entry(2, { status: 'WITHDRAWN' })],
    total: 43,
  }), { items: [entry(1)], total: 43 });
  assert.equal(normalizeDeliveryPoolPage([entry(3)]).total, 1,
    'the legacy array response stays readable during a rolling deployment');
});

test('selecting a filtered result preserves selections outside the current search', () => {
  assert.deepEqual(updateTaskSelection([101], [102, 103], true), [101, 102, 103]);
  assert.deepEqual(updateTaskSelection([101, 102, 103], [102, 103], false), [101]);
});

test('selected delivery rows are capped at the server contract without disabling valid batches', () => {
  const candidates = Array.from({ length: DELIVERY_POOL_SELECTION_LIMIT + 3 }, (_, index) => index + 1);
  assert.deepEqual(
    updateTaskSelection([], candidates, true),
    candidates.slice(0, DELIVERY_POOL_SELECTION_LIMIT),
  );
});

test('loading another delivery page preserves prior rows and de-duplicates repeated boundaries', () => {
  assert.deepEqual(
    mergeDeliveryPoolEntries([entry(1), entry(2)], [entry(2, { query: 'refreshed' }), entry(3)]),
    [entry(1), entry(2, { query: 'refreshed' }), entry(3)],
  );
});

test('prepared delivery download accepts only a safe one-time archive reference', () => {
  const prepared = {
    downloadId: '12345678-1234-4234-8234-123456789abc',
    fileName: '交付池-全部可交付项.zip',
    taskCount: 51,
    expiresAt: '2026-09-09T09:00:00.000Z',
  };
  assert.deepEqual(normalizePreparedDeliveryExport({ data: prepared }), prepared);
  assert.throws(() => normalizePreparedDeliveryExport({
    data: { ...prepared, fileName: '../escape.zip' },
  }), /下载凭证无效/u);
});

test('delivery pool exposes independent selected and all-ready export contracts', async () => {
  const [source, proxy] = await Promise.all([
    readFile(workbenchUrl, 'utf8'),
    readFile(proxyUrl, 'utf8'),
  ]);
  assert.match(source, /delivery-pool\?limit=\$\{DELIVERY_POOL_LIST_LIMIT\}&offset=\$\{offset\}&includeTotal=true/u);
  assert.match(source, /load\(nextOffset\)/u,
    'delivery rows after the first 200 must remain reachable through the server offset');
  assert.doesNotMatch(source, /load\(entries\.length\)/u,
    'de-duplicated client row count must not be reused as the mutable server offset');
  assert.match(source, /\/v1\/delivery-pool\/archive/u);
  assert.match(source, /scope === 'ALL_READY' \? \{ scope \} : \{ scope, taskIds: selected \}/u,
    'ALL_READY must be a server-side scope and must not be built from the visible task ids');
  assert.match(source, /delivery-pool\/archive\/\$\{encodeURIComponent\(prepared\.downloadId\)\}/u);
  assert.doesNotMatch(source, /response\.blob\(\)|URL\.createObjectURL/u,
    'large delivery archives must use the native streamed download instead of a page-memory Blob');
  assert.match(source, /一键导出全部/u);
  assert.match(source, /批量下载（已选/u);
  assert.match(source, /不受搜索或当前显示范围影响/u);
  assert.doesNotMatch(source, /selected\.length > 20/u,
    'the UI must not disable the new delivery export contract at the legacy batch-archive limit');
  assert.match(source, /role="status" aria-live="polite"/u);
  assert.match(proxy, /role === 'REVIEWER'[\s\S]*\/v1\\\/delivery-pool/u);
  assert.match(proxy, /AbortSignal\.any\(\[request\.signal, timeoutSignal\]\)/u);
  assert.match(proxy, /'Content-Length': contentLength/u);
  assert.match(proxy, /'X-Delivery-Task-Count': deliveryTaskCount/u);
  assert.match(proxy, /export const maxDuration = 3600/u);
});
