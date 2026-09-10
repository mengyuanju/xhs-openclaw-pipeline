import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const projectFile = (path) => new URL(`../${path}`, import.meta.url);

test('duplicate Query cleanup is an explicit admin action on the deduplicated all-jobs view', async () => {
  const source = await readFile(projectFile('app/workbench/creation-workbench.tsx'), 'utf8');
  const toggleStart = source.indexOf('id="workbench-query-deduplicate"');
  const toggleEnd = source.indexOf('</label>', toggleStart);
  const toggle = source.slice(toggleStart, toggleEnd);

  assert.match(source, /role === 'ADMIN' && activeView === 'ALL_JOBS' && deduplicateQuery && selectedTasks\.length > 0 && <Button/u);
  assert.match(source, />预览重复项<\/Button>/u);
  assert.match(toggle, /setDeduplicateQuery\(event\.target\.checked\)/u);
  assert.doesNotMatch(toggle, /duplicate-query-discard|previewDuplicateQueries|fetch\(/u,
    'turning on deduplication must not mutate tasks');
});

test('duplicate Query preview explains every protected and discardable task before confirmation', async () => {
  const [source, styles] = await Promise.all([
    readFile(projectFile('app/workbench/creation-workbench.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
  ]);

  assert.match(source, /type DuplicateQueryDiscardPreview = \{[\s\S]*version: 1;[\s\S]*representativeTaskIds: number\[\];[\s\S]*previewFingerprint: string;[\s\S]*groups: Array<[\s\S]*keeper: DuplicateQueryTaskSummary \| null;[\s\S]*discardable: DuplicateQueryTaskSummary\[\];[\s\S]*skipped: DuplicateQuerySkippedTask\[\];[\s\S]*queryGroupCount: number;[\s\S]*discardableCount: number;[\s\S]*skippedCount: number;/u);
  assert.match(source, /'\/v1\/tasks\/duplicate-query-discard-preview',[\s\S]{0,120}\{ representativeTaskIds \}/u);
  assert.match(source, /if \(!isDuplicateQueryDiscardPreview\(nextPreview\)[\s\S]{0,160}throw new Error\('预览内容不完整/u,
    'the client must validate the untrusted preview response');
  assert.match(source, /保留[\s\S]*#\{group\.keeper\.id\}[\s\S]*group\.discardable\.map[\s\S]*#\{task\.id\}[\s\S]*group\.skipped\.map[\s\S]*duplicateQuerySkipLabel\(task\.reasonCode\)/u);
  assert.match(source, /没有可安全废弃的重复任务/u);
  assert.match(source, /disabled=\{busy \|\| !requestReady \|\| preview\.summary\.discardableCount === 0\}/u);
  assert.match(styles, /\.duplicate-query-dialog \{/u);
  assert.match(styles, /\.duplicate-query-groups \{/u);
});

test('duplicate Query confirmation is locked, idempotent, and preserves a stale preview on failure', async () => {
  const source = await readFile(projectFile('app/workbench/creation-workbench.tsx'), 'utf8');
  const previewStart = source.indexOf('async function previewDuplicateQueries(');
  const confirmStart = source.indexOf('async function discardDuplicateQueries()', previewStart);
  const nextFunction = source.indexOf('async function runBatchAction(', confirmStart);
  const preview = source.slice(previewStart, confirmStart);
  const confirmation = source.slice(confirmStart, nextFunction);

  assert.ok(previewStart >= 0 && confirmStart > previewStart && nextFunction > confirmStart);
  assert.match(preview, /setDuplicateQueryRequestId\(null\)/u);
  assert.match(preview, /setDuplicateQueryRequestId\(globalThis\.crypto\.randomUUID\(\)\)/u,
    'one request ID is stored only after a new preview is accepted');
  assert.match(confirmation, /!duplicateQueryCleanupLock\.acquire\(\)/u);
  assert.match(confirmation, /'\/v1\/tasks\/duplicate-query-discard'/u);
  assert.match(confirmation, /requestId,[\s\S]*representativeTaskIds: preview\.representativeTaskIds,[\s\S]*previewFingerprint: preview\.previewFingerprint,[\s\S]*confirmedDiscardCount: preview\.summary\.discardableCount/u);
  assert.doesNotMatch(confirmation, /randomUUID/u,
    'confirmation retries must reuse the request ID stored with the preview');
  assert.match(confirmation, /handledRepresentativeIds = new Set\(preview\.representativeTaskIds\)[\s\S]*current\.filter\(\(id\) => !handledRepresentativeIds\.has\(id\)\)/u);
  assert.match(confirmation, /caught instanceof DuplicateQueryCleanupRequestError && caught\.status === 409/u);
  assert.match(confirmation, /预览已保留，请重新预览后再确认/u);
  assert.match(confirmation, /await refresh\(\{ silent: true \}\)/u,
    'a successful cleanup refreshes the same filtered view');
});
