import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectFile = (path) => new URL(`../${path}`, import.meta.url);

test('copy QA can recommend discard without directly terminating the task', async () => {
  const source = await readFile(projectFile('app/copy-qa/copy-qa-workbench.tsx'), 'utf8');

  assert.match(source, /returnRecommendation.*'REWORK' \| 'DISCARD'/u);
  assert.match(source, /<SelectItem value="REWORK">要求返工修改<\/SelectItem>/u);
  assert.match(source, /<SelectItem value="DISCARD">建议任务负责人废弃<\/SelectItem>/u);
  assert.match(source, /recommendedDisposition: returnRecommendation/u);
  assert.match(source, /质检建议不会直接终止任务/u);
  assert.match(source, /建议废弃时必须填写明确原因/u);
});

test('assigned worker gets a dedicated audited action for QA-returned copy', async () => {
  const source = await readFile(projectFile('app/workbench/task-review-dialog.tsx'), 'utf8');

  assert.match(source, /const canDiscardReturnedCopy = Boolean\(editable && hasOwnerControl/u);
  assert.match(source, /mandatoryCopyQcOrigin === 'QA_RETURN'/u);
  assert.match(source, /revision\?\.reworkOrigin === 'QA_RETURN'/u);
  assert.match(source, /isAdmin \|\| revision\.reworkRecommendation === 'DISCARD'/u);
  assert.match(source, /\/discard-returned-copy/u);
  assert.match(source, /expectedCopyRevisionId: revision\.id/u);
  assert.match(source, /sourceSamplingItemId: revision\.reworkSamplingItemId/u);
  assert.match(source, /确认质检建议并废弃/u);
  assert.match(source, /历史文案、质检记录和执行记录仍会保留/u);
});

test('server prevents generic cancel and score-discard from bypassing returned-copy disposition', async () => {
  const source = await readFile(projectFile('server/src/postgres-repository.mjs'), 'utf8');
  const http = await readFile(projectFile('server/src/http-server.mjs'), 'utf8');

  assert.ok((source.match(/RETURNED_COPY_DISCARD_REQUIRES_DISPOSITION/gu) ?? []).length >= 2);
  assert.match(source, /task\.state === 'COPY_REVIEW_PENDING'.*task\.mandatory_copy_qc === true/su);
  assert.match(http, /router\.post\('\/v1\/tasks\/:taskId\/discard-returned-copy'/u);
  assert.match(http, /ownerOnly: actor\.role !== 'ADMIN'/u);
});
