import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { normalizeDeliveryFilters } from '../server/src/delivery-ledger.mjs';
import { normalizePerformanceFilters } from '../src/operator-performance.mjs';

test('administrator personnel filters use stable account ids in statistics and delivery', async () => {
  const [statistics, delivery] = await Promise.all([
    readFile(new URL('../app/workbench-statistics/operator-performance.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/delivery-pool/shared-delivery-workbench.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(statistics, /name="accountId" aria-label="人员"/u);
  assert.match(statistics, /const accountId=String\(fields\.get\('accountId'\)/u);
  assert.match(statistics, /人员：\$\{selectedAccountLabel\}/u);
  assert.match(statistics, /accountId:'',batchId:'',page:'1'/u);
  assert.doesNotMatch(statistics, /setFilters\(previous=>\(\{\.\.\.previous,query:'',accountId:''/u,
    'switching between total and account views must keep the selected person');

  for (const [field, label] of [['assigneeId', '负责人'], ['packedById', '打包人'], ['deliveredById', '交付确认人']]) {
    assert.match(delivery, new RegExp(`\\['${field}', '${label}'\\]`, 'u'));
  }
  assert.match(delivery, /人员筛选结果/u);
  assert.match(delivery, /result\.summary\.unpacked \+ result\.summary\.packed/u);
  assert.match(delivery, /assigneeId: '', packedById: '', deliveredById: ''/u);

  assert.equal(normalizePerformanceFilters({ accountId: '17' }).accountId, 17);
  assert.throws(() => normalizePerformanceFilters({ accountId: '0' }), /统计编号或页码无效/u);
  assert.deepEqual(
    normalizeDeliveryFilters({ assigneeId: '17', packedById: '18', deliveredById: '19' }),
    {
      view: 'CURRENT', state: 'ALL', dateField: 'READY', archiveState: 'ALL', versionState: 'ALL',
      from: null, to: null, search: '', assigneeId: 17, deliveredById: 19, packedById: 18,
      packageName: '', clientBatchCode: '',
    },
  );
  assert.throws(() => normalizeDeliveryFilters({ assigneeId: '0' }), /taskId must be a positive integer/u);
});
