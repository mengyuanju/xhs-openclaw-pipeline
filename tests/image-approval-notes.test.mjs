import assert from 'node:assert/strict';
import test from 'node:test';
import { imageApprovalNoteForVersion } from '../app/components/image-approval-note.mjs';

test('image handoff notes match both image and copy versions without a historical fallback', () => {
  const events = [
    { imageRunId: 'old-image', copyRevisionId: 2, manualModificationNote: '旧图片改动' },
    { imageRunId: 'current-image', copyRevisionId: 1, manualModificationNote: '旧文案改动' },
    { imageRunId: 'current-image', copyRevisionId: 2, manualModificationNote: '  第 2 页右下角换图\n保持文字不变  ' },
  ];
  assert.equal(imageApprovalNoteForVersion(events, 'current-image', 2), '第 2 页右下角换图\n保持文字不变');
  assert.equal(imageApprovalNoteForVersion(events, 'new-image', 2), null);
  assert.equal(imageApprovalNoteForVersion(events, 'current-image', 3), null);
  assert.equal(imageApprovalNoteForVersion(events.slice(0, 2), 'current-image', 2), null);
});

test('legacy and malformed image handoff notes are treated as absent', () => {
  for (const events of [undefined, null, {}, [], [null], [123],
    [{ imageRunId: 'image', copyRevisionId: 2, manualModificationNote: { text: 'bad' } }],
    [{ imageRunId: 'image', copyRevisionId: 2, manualModificationNote: ' \r\n ' }],
    [{ imageRunId: 'image', copyRevisionId: '2', manualModificationNote: 'bad revision' }]]) {
    assert.equal(imageApprovalNoteForVersion(events, 'image', 2), null);
  }
  assert.equal(imageApprovalNoteForVersion([], null, 2), null);
  assert.equal(imageApprovalNoteForVersion([], 'image', null), null);
});

test('same-image rechecks show the latest submission note and preserve an explicitly empty note', () => {
  const events = [
    { id: 10, imageRunId: 'image', copyRevisionId: 2, submittedAt: '2026-09-28T03:00:00Z', manualModificationNote: '旧初审备注' },
    { id: 12, imageRunId: 'image', copyRevisionId: 2, submittedAt: '2026-09-28T08:00:00Z', manualModificationNote: '本轮手工修改点位' },
    { id: 11, imageRunId: 'image', copyRevisionId: 2, submittedAt: '2026-09-28T08:00:00Z', manualModificationNote: '前一轮复检备注' },
  ];
  const original = structuredClone(events);
  assert.equal(imageApprovalNoteForVersion(events, 'image', 2), '本轮手工修改点位');
  assert.deepEqual(events, original, 'reading a note must not reorder approval history');
  events.push({ id: 13, imageRunId: 'image', copyRevisionId: 2, submittedAt: '2026-09-28T09:00:00Z', manualModificationNote: null });
  assert.equal(imageApprovalNoteForVersion(events, 'image', 2), null, 'the latest empty note must not inherit an older round');
});
