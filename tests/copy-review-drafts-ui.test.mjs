import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const dialogUrl = new URL('../app/workbench/task-review-dialog.tsx', import.meta.url);

test('copy review UI restores server drafts and autosaves complete review state', async () => {
  const source = await readFile(dialogUrl, 'utf8');
  assert.match(source, /\/copy-review-drafts/u);
  assert.match(source, /expectedLatestDraftId: lastSavedDraftIdRef\.current/u);
  assert.match(source, /keepalive: true/u);
  assert.match(source, /setDraft\(restoredContent\?\.draft/u);
  assert.match(source, /copyOriginalScore: copyRatings\.current\?\.score/u);
  assert.match(source, /审核草稿/u);
  assert.match(source, /服务器草稿历史/u);
  assert.match(source, /恢复正式版本/u);
  assert.match(source, /hasUnpersistedDraftChanges[\s\S]*beforeunload/u);
});
