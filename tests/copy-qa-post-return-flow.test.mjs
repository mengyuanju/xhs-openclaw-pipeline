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

// The current page uses V2 batches. Legacy manual freeze controls are retired.
test('V2 single return submits the selected final revision and refreshes its current batch page', async () => {
  const source = await readFile(new URL('../app/copy-qa/copy-qa-workbench.tsx', import.meta.url), 'utf8');
  assert.match(source, /decision==='RETURN'&&!note\.trim\(\)&&!reasonCodes\.length/u);
  assert.match(source, /revisionToken:item\.revisionToken/u);
  assert.match(source, /\/v2\/copy-qa\/items\/\$\{item\.id\}\/decision/u);
  assert.match(source, /JSON\.stringify\(\{requestId,\.\.\.payload\}\)/u);
  assert.match(source, /setReturnItem\(null\)[\s\S]*if\(detail\)await open\(detail\.batch\.id,detail\.pagination\.offset\)/u);
  assert.doesNotMatch(source, /batch-return-preview|release-rest|\/v1\/copy-qa/u);
});

test('V2 batches always select mandatory rechecks and refuse their unreviewed release', async () => {
  const service = await readFile(new URL('../server/src/copy-qa-v2.mjs', import.meta.url), 'utf8');
  assert.match(service, /if \(row\.mandatory_copy_qc === true\) selected\.add\(Number\(row\.task_id\)\)/u);
  assert.match(service, /mandatoryReview=task\.mandatory_copy_qc===true\|\|task\.copy_qa_rework_pending===true/u);
  assert.match(service, /AND \(\$3::boolean OR NOT mandatory_copy_qc\)/u);
  assert.match(service, /await releaseMember\(client,member,\{reviewed:true\}\)/u);
});

test('V2 page shows pending and finished batches with the server-defined return policy', async () => {
  const source = await readFile(new URL('../app/copy-qa/copy-qa-workbench.tsx', import.meta.url), 'utf8');
  assert.match(source, /type View = 'PENDING'\|'FINISHED'/u);
  assert.match(source, /role="tablist" aria-label="质检批次状态"/u);
  assert.match(source, /待质检批次/u);
  assert.match(source, /已完成批次/u);
  assert.match(source, /detail\.batch\.fullInspection\?'本批所有质检项需逐条完成质检。'/u);
  assert.match(source, /质检项驳回达到 \$\{detail\.batch\.returnTriggerCount\} 条后，系统自动处理剩余成员/u);
});

test('V2 return threshold is enforced on the server and full inspection is never auto-returned', async () => {
  const service = await readFile(new URL('../server/src/copy-qa-v2.mjs', import.meta.url), 'utf8');
  assert.match(service, /if\(!batch\.full_inspection && batch\.return_trigger_count>0\s*&& Number\(stats\.returned\)>=Number\(batch\.return_trigger_count\)\)/u);
  assert.match(service, /WHERE batch_id=\$1 AND status IN \('PENDING','NOT_SELECTED'\)/u);
  assert.match(service, /else if\(Number\(stats\.pending\)===0\)\{\s*await completeBatch/u);
});

test('copy QA detail compares final copy and image planning in responsive columns', async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL('../app/copy-qa/copy-qa-revision-view.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/copy-qa/copy-qa.module.css', import.meta.url), 'utf8'),
  ]);

  assert.match(source, /className=\{styles\.comparison\} aria-label="最终文案与图片文案规划对照"/u);
  assert.match(styles, /\.comparison\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*\.95fr\)\s+minmax\(0,\s*1\.05fr\)/su);
  assert.match(styles, /@media \(max-width:\s*900px\)[\s\S]*?\.comparison\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/u);
});

test('the local E2E fixture preserves a returned trigger while upgrading its full frozen scope', async () => {
  const source = await readFile(new URL('./fixtures/modular-workflow-e2e.mjs', import.meta.url), 'utf8');
  assert.match(source, /canReturnBatch: \['PENDING', 'RETURNED'\]\.includes\(item\.status\)/u);
  assert.match(source, /\['PENDING', 'RETURNED', 'PASSED', 'NOT_SELECTED'\]\.includes\(item\.status\)/u);
  assert.match(source, /if \(item\.id !== input\.triggerSamplingItemId\) item\.status = 'BATCH_AFFECTED'/u);
  assert.match(source, /else if \(item\.status !== 'RETURNED'\) item\.status = 'RETURNED'/u);
});
