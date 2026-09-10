import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCopyReviewSubmission } from '../src/copy-review-submission.mjs';

const base = {
  revisionId: 12,
  nodeId: 'node-a',
  decision: 'APPROVE',
  draft: { copy: { title: '修改稿' } },
  draftChanged: true,
  originalScore: 2,
  originalReasons: ['STRUCTURE'],
  originalNote: '保留原始说明 ',
  aiDisclosureEnabled: false,
};

test('an edited copy is approved as final score 3 without overwriting the original assessment', () => {
  const payload = buildCopyReviewSubmission({
    ...base,
    copyContentChanged: true,
    copyContentChangedFromMachine: false,
  });
  assert.equal(payload.score, 3);
  assert.deepEqual(payload.reasons, []);
  assert.equal(payload.note, '');
  assert.equal(payload.originalScore, 2);
  assert.deepEqual(payload.originalReasons, ['STRUCTURE']);
  assert.equal(payload.originalNote, '保留原始说明 ');
  assert.deepEqual(payload.edits, base.draft);
});

test('a saved edited revision can be approved as 3 using explicit copy provenance', () => {
  const payload = buildCopyReviewSubmission({
    ...base,
    draftChanged: false,
    copyContentChanged: false,
    copyContentChangedFromMachine: true,
  });
  assert.equal(payload.score, 3);
  assert.equal(payload.originalScore, 2);
  assert.equal('edits' in payload, false);
});

test('a plan-only manual revision cannot approve a 2.5 machine draft', () => {
  assert.throws(() => buildCopyReviewSubmission({
    ...base,
    originalScore: 2.5,
    copyContentChanged: false,
    copyContentChangedFromMachine: false,
  }), /must be genuinely edited before approval/u);
});

test('a returned copy uses system-owned score 3 without inventing an original assessment', () => {
  const payload = buildCopyReviewSubmission({
    ...base,
    originalScore: null,
    originalReasons: [],
    originalNote: '',
    copyContentChanged: true,
    copyContentChangedFromMachine: false,
    copyRework: true,
  });
  assert.equal(payload.score, 3);
  assert.equal('originalScore' in payload, false);
});

test('saving or discarding rework does not submit a premature final score', () => {
  for (const decision of ['SAVE', 'DISCARD']) {
    const payload = buildCopyReviewSubmission({
      ...base,
      decision,
      originalScore: null,
      originalReasons: [],
      originalNote: '',
      copyContentChanged: true,
      copyContentChangedFromMachine: false,
      copyRework: true,
    });
    assert.equal('score' in payload, false, decision);
    assert.equal('reasons' in payload, false, decision);
    assert.equal('note' in payload, false, decision);
  }
});
