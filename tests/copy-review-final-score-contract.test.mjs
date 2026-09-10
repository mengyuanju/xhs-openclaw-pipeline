import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildCopyReviewSubmission } from '../src/copy-review-submission.mjs';

const base = Object.freeze({
  revisionId: 12,
  nodeId: 'review-node',
  decision: 'APPROVE',
  draft: { copy: { title: '人工修改后的标题', body: '正文', tags: [] }, imagePlan: [] },
  draftChanged: true,
  copyContentChanged: true,
  copyContentChangedFromMachine: false,
  originalScore: 2,
  originalReasons: ['STRUCTURE'],
  originalNote: '机器原稿结构需要整理',
  aiDisclosureEnabled: true,
});

test('approving an edited copy records final 3 while preserving the original draft assessment', () => {
  const request = buildCopyReviewSubmission(base);
  assert.deepEqual({
    score: request.score,
    reasons: request.reasons,
    note: request.note,
    originalScore: request.originalScore,
    originalReasons: request.originalReasons,
    originalNote: request.originalNote,
  }, {
    score: 3,
    reasons: [],
    note: '',
    originalScore: 2,
    originalReasons: ['STRUCTURE'],
    originalNote: '机器原稿结构需要整理',
  });
  assert.deepEqual(request.edits, base.draft);
  assert.notStrictEqual(request.originalReasons, base.originalReasons,
    'request construction must not mutate the UI rating state');
});

test('approving a previously saved edited revision also forces the final approved version to 3', () => {
  const request = buildCopyReviewSubmission({
    ...base,
    revisionId: 13,
    draftChanged: false,
    copyContentChanged: false,
    copyContentChangedFromMachine: true,
    originalScore: 2.5,
    originalReasons: ['EXPRESSION'],
  });
  assert.equal(request.score, 3);
  assert.deepEqual(request.reasons, []);
  assert.equal(request.note, '');
  assert.equal(request.originalScore, 2.5);
  assert.equal(Object.hasOwn(request, 'edits'), false);
});

test('an untouched machine draft scored 2.5 cannot be approved', () => {
  assert.throws(() => buildCopyReviewSubmission({
    ...base,
    draftChanged: false,
    copyContentChanged: false,
    copyContentChangedFromMachine: false,
    originalScore: 2.5,
    originalReasons: ['EXPRESSION'],
  }), /must be genuinely edited before approval/u);
});

test('a plan-only manual revision cannot satisfy the copy-edit approval gate', () => {
  assert.throws(() => buildCopyReviewSubmission({
    ...base,
    draftChanged: true,
    copyContentChanged: false,
    copyContentChangedFromMachine: false,
    originalScore: 2.5,
    originalReasons: ['IMAGE_PLAN'],
  }), /must be genuinely edited before approval/u);
});

test('a machine draft scored 1 cannot be approved', () => {
  assert.throws(() => buildCopyReviewSubmission({
    ...base,
    draftChanged: false,
    copyContentChanged: false,
    copyContentChangedFromMachine: false,
    originalScore: 1,
  }), /must be discarded/u);
});

test('the review dialog uses the shared version-aware submission builder', async () => {
  const source = await readFile(new URL('../app/workbench/task-review-dialog.tsx', import.meta.url), 'utf8');
  assert.match(source, /buildCopyReviewSubmission/u);
  assert.match(source, /copyContentChangedFromMachine/u);
});
