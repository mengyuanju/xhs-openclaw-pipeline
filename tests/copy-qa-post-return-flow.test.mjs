import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildCopyQaBatchReturnPayload } from '../src/copy-qa-batch-return.mjs';

const returnedId = '71717171-7171-4717-8717-717171717171';
const freezeId = '81818181-8181-4818-8818-818181818181';

test('a returned public item remains the trigger for a freshly previewed batch upgrade', () => {
  const payload = buildCopyQaBatchReturnPayload({
    freezePublicId: freezeId,
    triggerSamplingItemId: returnedId,
    preview: {
      confirmedCount: 3,
      items: [
        { id: returnedId, status: 'RETURNED' },
        { id: '72727272-7272-4727-8727-727272727272', status: 'PENDING' },
        { id: '73737373-7373-4737-8737-737373737373', status: 'NOT_SELECTED' },
      ],
    },
    reasonCodes: ['FACT_ERROR'],
    note: '同批内容存在系统性事实问题',
    requestId: '91919191-9191-4919-8919-919191919191',
  });

  assert.equal(payload.freezePublicId, freezeId);
  assert.equal(payload.triggerSamplingItemId, returnedId);
  assert.deepEqual(payload.itemIds, [
    returnedId,
    '72727272-7272-4727-8727-727272727272',
    '73737373-7373-4737-8737-737373737373',
  ]);
  assert.equal(payload.confirmedCount, 3);
});

test('the single-return success state offers release-rest and batch-upgrade branches', async () => {
  const source = await readFile(new URL('../app/copy-qa/copy-qa-workbench.tsx', import.meta.url), 'utf8');
  assert.match(source, /setReturnItem\(\{ \.\.\.returned, status: 'RETURNED' \}\)[\s\S]*setReturnCompleted\(true\)/u);
  assert.match(source, /放行同批其余/u);
  assert.match(source, /升级整批打回/u);
  assert.match(source, /beginBatchReturn\(returnItem,[\s\S]*reasonCodes: returnReasons[\s\S]*note: returnNote/u);
  assert.match(source, /triggerSamplingItemId: batchTriggerItem\.id/u);
  assert.doesNotMatch(source, /triggerSamplingItemId: selectedItems\[0\]\.id/u);
});

test('copy QA filters keep their longest option on one line', async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL('../app/copy-qa/copy-qa-workbench.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/copy-qa/copy-qa.module.css', import.meta.url), 'utf8'),
  ]);

  assert.equal(source.match(/<SelectTrigger className=\{styles\.filterSelect\}>/gu)?.length, 2);
  assert.match(styles, /\.filterSelect\s*\{[^}]*min-width:\s*128px;/su);
});

test('the local E2E fixture preserves a returned trigger while upgrading its full frozen scope', async () => {
  const source = await readFile(new URL('./fixtures/modular-workflow-e2e.mjs', import.meta.url), 'utf8');
  assert.match(source, /canReturnBatch: \['PENDING', 'RETURNED'\]\.includes\(item\.status\)/u);
  assert.match(source, /\['PENDING', 'RETURNED', 'PASSED', 'NOT_SELECTED'\]\.includes\(item\.status\)/u);
  assert.match(source, /if \(item\.id !== input\.triggerSamplingItemId\) item\.status = 'BATCH_AFFECTED'/u);
  assert.match(source, /else if \(item\.status !== 'RETURNED'\) item\.status = 'RETURNED'/u);
});
