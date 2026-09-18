import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('personal completion history migration indexes both operator event timelines', async () => {
  const sql = await readFile(new URL('../migrations/0069_personal_completion_history.sql', import.meta.url), 'utf8');
  assert.match(sql, /copy_approval_events\(approved_by_account_id, approved_at DESC, task_id\)/u);
  assert.match(sql, /image_approval_events\(submitted_by_account_id, submitted_at DESC, task_id\)/u);
  assert.doesNotMatch(sql, /UPDATE|DELETE|TRUNCATE/iu);
});
