import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DELIVERY_POOL_LIST_LIMIT,
  DELIVERY_POOL_SELECTION_LIMIT,
  buildDeliveryPoolExportInput,
  filterDeliveryPoolEntries,
  mergeDeliveryPoolEntries,
  normalizeDeliveryPoolPage,
  normalizePreparedDeliveryExport,
  normalizePreparedDeliveryXlsxExport,
  parseDeliveryPoolSearchTerms,
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

test('Excel export uses selected task ids and otherwise requests the complete READY pool', () => {
  assert.deepEqual(buildDeliveryPoolExportInput([]), { scope: 'ALL_READY' });
  assert.deepEqual(buildDeliveryPoolExportInput([103, 101, 103]), {
    scope: 'SELECTED',
    taskIds: [103, 101],
  });
  assert.throws(() => buildDeliveryPoolExportInput([0]), /导出范围无效/u);
  assert.throws(
    () => buildDeliveryPoolExportInput(Array.from(
      { length: DELIVERY_POOL_SELECTION_LIMIT + 1 },
      (_, index) => index + 1,
    )),
    /导出范围无效/u,
  );
});

test('loading another delivery page preserves prior rows and de-duplicates repeated boundaries', () => {
  assert.deepEqual(
    mergeDeliveryPoolEntries([entry(1), entry(2)], [entry(2, { query: 'refreshed' }), entry(3)]),
    [entry(1), entry(2, { query: 'refreshed' }), entry(3)],
  );
});

test('delivery pool search treats non-empty lines as independent OR conditions', () => {
  const entries = [
    entry(1, { query: '租房桌面收纳' }),
    entry(2, { query: '通勤穿搭指南' }),
    entry(3, { query: '周末露营装备' }),
  ];
  assert.deepEqual(
    filterDeliveryPoolEntries(entries, ' 桌面收纳 \r\n\n通勤穿搭\r未命中'),
    entries.slice(0, 2),
  );
});

test('delivery pool multi-line search ignores blank and duplicate lines without duplicating rows', () => {
  const entries = [
    entry(1, { query: 'Travel Guide' }),
    entry(2, { taskId: 2048, query: '本地生活' }),
  ];
  assert.deepEqual(parseDeliveryPoolSearchTerms(' GUIDE\n\n guide \r\n2048 '), ['guide', '2048']);
  assert.deepEqual(filterDeliveryPoolEntries(entries, ' GUIDE\n\n guide \r\n2048 '), entries);
  assert.strictEqual(filterDeliveryPoolEntries(entries, ' \r\n\r '), entries,
    'an all-whitespace search should preserve the unfiltered list');
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

test('prepared Excel download accepts only a safe xlsx one-time reference', () => {
  const prepared = {
    downloadId: '22345678-1234-4234-8234-123456789abc',
    fileName: '交付池-已选数据.xlsx',
    taskCount: 2,
    expiresAt: '2026-09-09T09:00:00.000Z',
  };
  assert.deepEqual(normalizePreparedDeliveryXlsxExport({ data: prepared }), prepared);
  assert.throws(() => normalizePreparedDeliveryXlsxExport({
    data: { ...prepared, fileName: '../escape.xlsx' },
  }), /下载凭证无效/u);
  assert.throws(() => normalizePreparedDeliveryXlsxExport({
    data: { ...prepared, fileName: '交付池.zip' },
  }), /下载凭证无效/u);
  assert.throws(() => normalizePreparedDeliveryXlsxExport({
    data: { ...prepared, fileName: '交付池\n.xlsx' },
  }), /下载凭证无效/u);
});

test('delivery pool exposes independent selected and all-ready export contracts', async () => {
  const [source, proxy] = await Promise.all([
    readFile(workbenchUrl, 'utf8'),
    readFile(proxyUrl, 'utf8'),
  ]);
  assert.match(source, /delivery-pool\?limit=\$\{DELIVERY_POOL_LIST_LIMIT\}&offset=\$\{offset\}&includeTotal=true/u);
  assert.match(source, /<Textarea[\s\S]*id="delivery-pool-search"/u,
    'delivery pool search must accept pasted line breaks');
  assert.match(source, /filterDeliveryPoolEntries\(entries, search\)/u);
  assert.match(source, /每行一条，匹配任意一条即显示/u);
  assert.match(source, /searchInputRef\.current\?\.focus\(\)/u,
    'clearing a multi-line search should return focus to its textarea');
  assert.match(source, /load\(nextOffset\)/u,
    'delivery rows after the first 200 must remain reachable through the server offset');
  assert.doesNotMatch(source, /load\(entries\.length\)/u,
    'de-duplicated client row count must not be reused as the mutable server offset');
  assert.match(source, /\/v1\/delivery-pool\/archive/u);
  assert.match(source, /scope === 'ALL_READY' \? \{ scope \} : \{ scope, taskIds: selected \}/u,
    'ALL_READY must be a server-side scope and must not be built from the visible task ids');
  assert.match(source, /delivery-pool\/archive\/\$\{encodeURIComponent\(prepared\.downloadId\)\}/u);
  assert.match(source, /\/v1\/delivery-pool\/xlsx/u);
  assert.match(source, /buildDeliveryPoolExportInput\(selectedTaskIds\)/u,
    'the Excel scope must be derived from a stable snapshot of the checked task ids');
  assert.match(source, /delivery-pool\/xlsx\/\$\{encodeURIComponent\(prepared\.downloadId\)\}/u);
  assert.doesNotMatch(source, /response\.blob\(\)|URL\.createObjectURL/u,
    'delivery archives and Excel files must use native streamed downloads instead of page-memory Blobs');
  assert.match(source, /const exportBusy = exporting !== null \|\| xlsxExporting/u);
  assert.match(source, /aria-busy=\{xlsxExporting\}/u);
  assert.match(source, /导出 Excel（已选/u);
  assert.match(source, /导出 Excel（全部/u);
  assert.match(source, /Excel 按原文件字节内嵌图片/u);
  assert.match(source, /只调整表格中的显示尺寸，不重新编码或二次压缩/u);
  assert.match(source, /图片原文件不重新编码、不二次压缩/u);
  assert.match(source, /Excel 一次最多导出.*请先勾选后分批导出/u);
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
