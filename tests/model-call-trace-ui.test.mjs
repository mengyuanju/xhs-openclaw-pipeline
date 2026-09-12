import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('task dialogs expose lazy read-only model call history only to administrators', async () => {
  const dialog = await readFile(new URL('../app/workbench/task-review-dialog.tsx', import.meta.url), 'utf8');
  const trace = await readFile(new URL('../app/workbench/model-call-trace.tsx', import.meta.url), 'utf8');
  assert.match(dialog, /role === 'ADMIN' && <ModelCallTrace/u);
  assert.ok(dialog.indexOf('<ModelCallTrace key={detail.id}') > dialog.indexOf('联网资料来源'));
  assert.ok(dialog.indexOf('<ModelCallTrace key={detail.id}') < dialog.indexOf('<footer'));
  assert.match(trace, /useState\(false\)/);
  assert.match(trace, /if \(!open\) return/);
  assert.match(trace, /signal: abort\.signal/);
  assert.match(trace, /limit=\$\{PAGE_SIZE\}&offset=/);
  assert.match(trace, /<pre>\{detail\.prompt/);
  assert.match(trace, /<ModelResponseView text=\{detail\.response\}/);
  assert.doesNotMatch(trace, /dangerouslySetInnerHTML|type="submit"|setInterval/);
  assert.match(trace, /无法还原当时的提示词/);
  assert.match(trace, /COPY_LENGTH_REPAIR: '正文长度修复'/u);
  assert.match(trace, /COPY_CONTRACT_REPAIR: '文案格式修复'/u);
  assert.match(trace, /WEB_SEARCH_RETRY: '联网搜索重试'/u);
  assert.match(trace, /WEB_SEARCH_FINALIZE: '整理已有搜索结果'/u);
  assert.match(trace, /仅修复正文，沿用标题、来源和配图策划/u);
});
