import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const dialogUrl = new URL('../app/workbench/task-review-dialog.tsx', import.meta.url);
const storeUrl = new URL('../app/workbench/copy-review-draft-store.ts', import.meta.url);

test('copy review UI autosaves locally and imports previous server drafts once', async () => {
  const [source, store] = await Promise.all([readFile(dialogUrl, 'utf8'), readFile(storeUrl, 'utf8')]);
  assert.match(source, /needsLegacyCopyReviewDraftImport/u);
  assert.match(source, /importLegacyCopyReviewDrafts/u);
  assert.match(source, /listLocalCopyReviewDrafts/u);
  assert.match(source, /saveLocalCopyReviewDraft/u);
  assert.match(source, /expectedLatestDraftId: lastSavedDraftIdRef\.current/u);
  assert.match(source, /setDraft\(restoredContent\?\.draft/u);
  assert.match(source, /copyOriginalScore: copyRatings\.current\?\.score/u);
  assert.match(source, /审核草稿/u);
  assert.match(source, /本机草稿历史/u);
  assert.match(source, /恢复正式版本/u);
  assert.match(source, /hasUnpersistedDraftChanges[\s\S]*beforeunload/u);
  assert.match(store, /indexedDB\.open/u);
  assert.match(store, /accountId.*taskId.*baseCopyRevisionId/u);
});
