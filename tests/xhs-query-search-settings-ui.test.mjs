import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const panelUrl = new URL('../app/settings/xhs-query-search-settings-panel.tsx', import.meta.url);
const workbenchUrl = new URL('../app/components/central-data-workbench.tsx', import.meta.url);

test('administrator production settings expose a bounded Xiaohongshu result-count control', async () => {
  const [panel, workbench] = await Promise.all([
    readFile(panelUrl, 'utf8'),
    readFile(workbenchUrl, 'utf8'),
  ]);

  assert.match(workbench, /import \{ XhsQuerySearchSettingsPanel \}/u);
  assert.match(workbench, /<WebSearchSettingsPanel[^>]*>[\s\S]*<XhsQuerySearchSettingsPanel onSaved=\{refresh\}/u);
  assert.match(panel, /const DEFAULT_RESULT_LIMIT = 3/u);
  assert.match(panel, /const MIN_RESULT_LIMIT = 1/u);
  assert.match(panel, /const MAX_RESULT_LIMIT = 10/u);
  assert.match(panel, /每个 Query 保留链接数/u);
  assert.match(panel, /按点赞量从高到低/u);
  assert.match(panel, /有效链接不足，实际保存数量可能少于设置值/u);
  assert.match(panel, /之后领取或重新领取的搜索使用新值，运行中和已完成的结果不变/u);
});

test('Xiaohongshu result-count control reads and writes only its independent center setting', async () => {
  const panel = await readFile(panelUrl, 'utf8');

  assert.match(panel, /SETTINGS_ENDPOINT = '\/api\/control-plane\/v1\/settings'/u);
  assert.match(panel, /UPDATE_ENDPOINT = '\/api\/control-plane\/v1\/settings\/xhs_query_search'/u);
  assert.match(panel, /candidate[\s\S]*\.key === 'xhs_query_search'/u);
  assert.match(panel, /method: 'PUT'/u);
  assert.match(panel, /body: JSON\.stringify\(\{ value: \{ resultLimit: parsedResultLimit \} \}\)/u);
  assert.doesNotMatch(panel, /settings\/production/u);
  assert.match(panel, /!Number\.isInteger\(parsedResultLimit\)/u);
  assert.match(panel, /parsedResultLimit < MIN_RESULT_LIMIT/u);
  assert.match(panel, /parsedResultLimit > MAX_RESULT_LIMIT/u);
  assert.match(panel, /disabled=\{disabled \|\| invalid \|\| !changed\}/u);
});
