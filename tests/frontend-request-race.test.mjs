import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { canCommitLatestRequest } from '../app/components/latest-request.ts';

const queryWorkbenchUrl = new URL('../app/query-packages/query-package-workbench.tsx', import.meta.url);
const copyQaWorkbenchUrl = new URL('../app/copy-qa/copy-qa-workbench.tsx', import.meta.url);

test('only the latest open request may commit after a target switch or close', () => {
  let activeRequestId = 1;
  assert.equal(canCommitLatestRequest(activeRequestId, 1), true);

  activeRequestId = 2;
  assert.equal(canCommitLatestRequest(activeRequestId, 1), false, 'the old target cannot replace the new target');
  assert.equal(canCommitLatestRequest(activeRequestId, 2), true);

  activeRequestId = 3;
  assert.equal(canCommitLatestRequest(activeRequestId, 2), false, 'closing invalidates the open request');
  assert.equal(canCommitLatestRequest(activeRequestId, 3, true), false, 'an aborted request never commits');
});

test('Query package detail aborts and invalidates superseded or closed requests', async () => {
  const source = await readFile(queryWorkbenchUrl, 'utf8');
  assert.match(source, /packageDetailRequestController\.current\?\.abort\(\)/u);
  assert.match(source, /query-packages\/\$\{id\}`\), \{ signal: controller\.signal \}/u);
  assert.match(source, /function closePackageDetail\(\)[\s\S]*packageDetailRequestId\.current \+= 1;[\s\S]*setDetailLoading\(false\)/u);
  assert.match(source, /onOpenChange=\{\(open\) => \{ if \(!open && !acting\) closePackageDetail\(\); \}\}/u);
  assert.ok((source.match(/canCommitLatestRequest\(/gu) ?? []).length >= 3);
});

test('Query package assignment aborts and invalidates superseded or closed user-list requests', async () => {
  const source = await readFile(queryWorkbenchUrl, 'utf8');
  assert.match(source, /assignmentRequestController\.current\?\.abort\(\)/u);
  assert.match(source, /apiPath\('\/v1\/users'\), \{ signal: controller\.signal \}/u);
  assert.match(source, /function closeAssignmentDialog\(\)[\s\S]*assignmentRequestId\.current \+= 1;[\s\S]*setAssignLoading\(false\)/u);
  assert.match(source, /onOpenChange=\{\(open\) => \{ if \(!open && acting !== 'assign'\) closeAssignmentDialog\(\); \}\}/u);
  assert.match(source, /canCommitLatestRequest\(assignmentRequestId\.current, currentRequestId, controller\.signal\.aborted\)/u);
});

test('Query package file reads commit filename and content together only for the latest selection', async () => {
  const source = await readFile(queryWorkbenchUrl, 'utf8');
  assert.match(source, /const currentRequestId = importFileRequestId\.current \+ 1;[\s\S]*const content = await file\.text\(\);[\s\S]*canCommitLatestRequest\(importFileRequestId\.current, currentRequestId\)[\s\S]*setSourceFileName\(file\.name\.slice\(0, 255\)\);[\s\S]*setQueryText\(content\)/u);
  assert.match(source, /function changeImportText\(value: string\) \{[\s\S]*importFileRequestId\.current \+= 1;[\s\S]*setSourceFileName\(''\)/u);
  assert.match(source, /function closeImportDialog\(\) \{[\s\S]*importFileRequestId\.current \+= 1;[\s\S]*setReadingImportFile\(false\)/u);
  assert.match(source, /if \(!canImport \|\| creating \|\| readingImportFile \|\| parsedImport\.error\) return/u);
  assert.match(source, /<form className=\{styles\.importForm\} onSubmit=\{createPackage\}>[\s\S]*\{importError && <div className="notice error" role="alert">\{importError\}<\/div>\}/u,
    'file-read and import failures must remain visible inside the open import dialog');
  assert.match(source, /disabled=\{creating \|\| readingImportFile \|\| !packageName\.trim\(\)/u);
});

test('copy QA detail and batch preview independently reject stale responses', async () => {
  const source = await readFile(copyQaWorkbenchUrl, 'utf8');
  assert.match(source, /copy-qa\/items\/\$\{encodeURIComponent\(id\)\}`\), \{ signal: controller\.signal \}/u);
  assert.match(source, /batch-return-preview`\),[\s\S]{0,120}\{ signal: controller\.signal \}/u);
  assert.match(source, /function closeItemDetail\(\)[\s\S]*detailRequestId\.current \+= 1;[\s\S]*setDetailLoading\(false\)/u);
  assert.match(source, /function closeBatchReturn\(\)[\s\S]*batchPreviewRequestId\.current \+= 1;[\s\S]*setBatchPreviewLoading\(false\)/u);
  assert.match(source, /onOpenChange=\{\(open\) => \{ if \(!open && !action\) closeItemDetail\(\); \}\}/u);
  assert.match(source, /onOpenChange=\{\(open\) => \{ if \(!open && action !== 'return-batch'\) closeBatchReturn\(\); \}\}/u);
  assert.ok((source.match(/canCommitLatestRequest\(/gu) ?? []).length >= 6);
});

test('copy QA UI withholds freeze-level actions from mandatory rechecks', async () => {
  const source = await readFile(copyQaWorkbenchUrl, 'utf8');
  assert.match(source, /const batchEligible = \(item: CopyQaItem\) => item\.status === 'PENDING' && canStartCopyQaBatchReturn\(item\)/u);
  assert.match(source, /if \(!releaseItem \|\| !canReleaseCopyQaFreezeRest\(releaseItem\) \|\| action\) return/u);
  assert.match(source, /if \(!batchTriggerItem \|\| !canStartCopyQaBatchReturn\(batchTriggerItem\)/u);
  assert.match(source, /returnItem\.sampleKind === 'MANDATORY_RECHECK'[\s\S]*此处不会提供整批打回或放行同批其余操作/u);
  assert.match(source, /canReleaseCopyQaFreezeRest\(detail\)/u);
  assert.match(source, /canStartCopyQaBatchReturn\(detail\)/u);
});
