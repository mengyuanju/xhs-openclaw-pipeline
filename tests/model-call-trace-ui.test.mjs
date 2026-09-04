import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('all task dialogs expose lazy read-only model call history at the bottom of details', async () => {
  const dialog = await readFile(new URL('../app/workbench/task-review-dialog.tsx', import.meta.url), 'utf8');
  const trace = await readFile(new URL('../app/workbench/model-call-trace.tsx', import.meta.url), 'utf8');
  assert.ok(dialog.indexOf('<ModelCallTrace key={detail.id}') > dialog.indexOf('联网资料来源'));
  assert.ok(dialog.indexOf('<ModelCallTrace key={detail.id}') < dialog.indexOf('<footer'));
  assert.match(trace, /useState\(false\)/);
  assert.match(trace, /if \(!open\) return/);
  assert.match(trace, /signal: abort\.signal/);
  assert.match(trace, /limit=\$\{PAGE_SIZE\}&offset=/);
  assert.match(trace, /<pre>\{detail\.prompt/);
  assert.match(trace, /<pre>\{detail\.response/);
  assert.doesNotMatch(trace, /dangerouslySetInnerHTML|type="submit"|setInterval/);
  assert.match(trace, /无法还原当时的提示词/);
});
