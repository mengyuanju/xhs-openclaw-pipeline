import { readTaskReviewSource } from './helpers/task-review-source.mjs';
import { readRepositorySource } from '../server/tests/helpers/repository-source.mjs';
import { readControlPlaneHttpSource } from './control-plane-http-source.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectFile = (path) => new URL(`../${path}`, import.meta.url);

test('V2 copy QA discard requires an explicit reason, note, confirmation and replayable request', async () => {
  const source = await readFile(projectFile('app/copy-qa/copy-qa-workbench.tsx'), 'utf8');
  // V2 replaced a recommendation with an audited task disposition.
  assert.match(source, /!discardReasonCode\|\|!discardNote\.trim\(\)/u);
  assert.match(source, /COPY_QA_DISCARD_REASONS\.map/u);
  assert.match(source, /废弃说明（必填）/u);
  assert.match(source, /confirm\(\{title:'确认废弃这条任务？'/u);
  assert.match(source, /历史记录保留/u);
  assert.match(source, /discardMutation\.current\?\.fingerprint!==fingerprint/u);
  assert.match(source, /requestId=discardMutation\.current\.requestId/u);
  assert.match(source, /discardReasonCode:decision==='DISCARD'\?discardReasonCode:undefined/u);
});

test('assigned worker gets a dedicated audited action for QA-returned copy', async () => {
  const source = await readTaskReviewSource();

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
  const source = await readRepositorySource();
  const http = await readControlPlaneHttpSource();

  assert.ok((source.match(/RETURNED_COPY_DISCARD_REQUIRES_DISPOSITION/gu) ?? []).length >= 2);
  assert.match(source, /task\.state === 'COPY_REVIEW_PENDING'.*task\.mandatory_copy_qc === true/su);
  assert.match(http, /router\.post\('\/v1\/tasks\/:taskId\/discard-returned-copy'/u);
  assert.match(http, /ownerOnly: actor\.role !== 'ADMIN'/u);
});
