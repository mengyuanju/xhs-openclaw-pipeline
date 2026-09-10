import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const queryWorkbenchUrl = new URL('../app/query-packages/query-package-workbench.tsx', import.meta.url);

test('worker import switch does not disable screening or production of an assigned package', async () => {
  const source = await readFile(queryWorkbenchUrl, 'utf8');
  assert.match(source, /const canImport = role === 'ADMIN' \|\| settings\?\.queryPackage\.workerImportEnabled === true/u);
  assert.match(source, /if \(!canImport \|\| creating \|\| readingImportFile \|\| parsedImport\.error\) return/u);
  assert.doesNotMatch(source, /function screen[\s\S]{0,300}if \([^)]*!canImport/u);
  assert.doesNotMatch(source, /function createProductionBatch[\s\S]{0,300}if \([^)]*!canImport/u);
  assert.match(source, /作业人员始终可以筛选分配给自己的词包并将通过项投产/u);
});

test('production can use selected itemIds so one package can be split into multiple batches', async () => {
  const source = await readFile(queryWorkbenchUrl, 'utf8');
  assert.match(source, /itemIds\s*:/u,
    'production request must send the checked selected rows instead of always consuming the whole package');
  assert.match(source, /checkedItemIds/u);
  assert.match(source, /production-batches/u);
  assert.match(source, /const PRODUCIBLE_PACKAGE_STATUSES = \['READY', 'PARTIALLY_USED'\]/u);
  assert.match(source, /PRODUCIBLE_PACKAGE_STATUSES\.includes\(detail\.status\)/u,
    'after the first subset is produced, PARTIALLY_USED must remain eligible for another batch');
});
