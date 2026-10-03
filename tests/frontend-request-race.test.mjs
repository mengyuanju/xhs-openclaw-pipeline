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
  assert.match(source, /query-packages\/\$\{id\}\?\$\{params\.toString\(\)\}`\),[\s\S]{0,100}\{ signal: controller\.signal \}/u);
  assert.match(source, /function closePackageDetail\(\)[\s\S]*packageDetailRequestId\.current \+= 1;[\s\S]*setDetailLoading\(false\)/u);
  assert.match(source, /onOpenChange=\{\(open\) => \{ if \(!open && !acting\) closePackageDetail\(\); \}\}/u);
  assert.ok((source.match(/canCommitLatestRequest\(/gu) ?? []).length >= 3);
});

test('Query package screening refreshes detail without resetting the active filter and assignment reads reject stale results', async () => {
  const source = await readFile(queryWorkbenchUrl, 'utf8');
  assert.match(source, /if \(!preserveFilters\) \{[\s\S]*setItemStatus\('PENDING'\)/u);
  assert.match(source, /setStagedScreening\(\{\}\);[\s\S]*openPackage\(detail\.id, \{[\s\S]*preserveFilters: true/u,
    'a confirmed mixed batch clears its staged decisions and refreshes the active filter');
  assert.match(source, /function openAssignment[\s\S]*assignmentRequestController\.current\?\.abort\(\)[\s\S]*canCommitLatestRequest\(assignmentRequestId\.current, currentRequestId, controller\.signal\.aborted\)/u);
  assert.match(source, /function closeAssignmentDialog\(\)[\s\S]*assignmentRequestId\.current \+= 1;[\s\S]*assignmentRequestController\.current\?\.abort\(\)/u);
});

test('Query package file reads commit filename and content together only for the latest selection', async () => {
  const source = await readFile(queryWorkbenchUrl, 'utf8');
  assert.match(source, /const currentRequestId = importFileRequestId\.current \+ 1;[\s\S]*const content = await file\.text\(\);[\s\S]*canCommitLatestRequest\(importFileRequestId\.current, currentRequestId\)[\s\S]*setSourceFileName\(file\.name\.slice\(0, 255\)\);[\s\S]*setQueryText\(content\)/u);
  assert.match(source, /function changeImportText\(value: string\) \{[\s\S]*importFileRequestId\.current \+= 1;[\s\S]*setSourceFileName\(''\)/u);
  assert.match(source, /function closeImportDialog\(\) \{[\s\S]*importFileRequestId\.current \+= 1;[\s\S]*setReadingImportFile\(false\)/u);
  assert.match(source, /if \(role !== 'ADMIN' \|\| creating \|\| readingImportFile \|\| parsedImport\.error\) return/u);
  assert.match(source, /<form className=\{styles\.importForm\} onSubmit=\{createPackage\}>[\s\S]*\{importError && <div className="notice error" role="alert">\{importError\}<\/div>\}/u,
    'file-read and import failures must remain visible inside the open import dialog');
  assert.match(source, /disabled=\{creating \|\| readingImportFile \|\| !packageName\.trim\(\)/u);
});

test('V2 copy QA list and batch detail independently abort and reject stale responses', async () => {
  const source = await readFile(copyQaWorkbenchUrl, 'utf8');
  // V2 removed the manual batch preview and has separate list/detail requests.
  assert.match(source, /listRequest\.current\?\.abort\(\)[\s\S]*listRequest\.current=controller/u);
  assert.match(source, /detailRequest\.current\?\.abort\(\)[\s\S]*detailRequest\.current=controller/u);
  assert.match(source, /\/v2\/copy-qa\/batches\?view=\$\{view\}[\s\S]*?signal:controller\.signal/u);
  assert.match(source, /\/v2\/copy-qa\/batches\/\$\{id\}\?limit=50&offset=\$\{offset\}[\s\S]*?signal:controller\.signal/u);
  assert.equal((source.match(/if\(controller\.signal\.aborted\)return;/gu) ?? []).length, 2);
  assert.match(source, /finally\{if\(listRequest\.current===controller\)/u);
  assert.match(source, /finally\{if\(detailRequest\.current===controller\)/u);
  assert.match(source, /function switchView\(next:View\)\{detailRequest\.current\?\.abort\(\)/u);
  assert.match(source, /返回批次列表[\s\S]*onPage=\{offset=>\{setSelectedItemId\(null\)/u);
});

test('V2 copy QA actions require a pending item in an inspecting batch and never expose retired freeze controls', async () => {
  const source = await readFile(copyQaWorkbenchUrl, 'utf8');
  assert.match(source, /selectedItem\.status==='PENDING'&&detail\?\.batch\.status==='INSPECTING'/u);
  assert.match(source, /disabled=\{busy\} onClick=\{\(\)=>openReturn\(selectedItem\)\}/u);
  assert.match(source, /disabled=\{busy\} onClick=\{\(\)=>void confirmPass\(selectedItem\)\}/u);
  assert.doesNotMatch(source, /release-rest|batch-return-preview|升级整批打回|放行同批其余/u);
});
