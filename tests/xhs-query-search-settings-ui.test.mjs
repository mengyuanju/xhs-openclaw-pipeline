import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const panelUrl = new URL('../app/settings/xhs-query-search-settings-panel.tsx', import.meta.url);
const workbenchUrl = new URL('../app/components/central-data-workbench.tsx', import.meta.url);

test('administrator production settings expose fastest and thorough Xiaohongshu search controls', async () => {
  const [panel, workbench] = await Promise.all([
    readFile(panelUrl, 'utf8'),
    readFile(workbenchUrl, 'utf8'),
  ]);

  assert.match(workbench, /import \{ XhsQuerySearchSettingsPanel \}/u);
  assert.match(workbench, /<WebSearchSettingsPanel[^>]*>[\s\S]*<XhsQuerySearchSettingsPanel onSaved=\{refresh\}/u);
  assert.match(panel, /const DEFAULT_RESULT_LIMIT = 3/u);
  assert.match(panel, /const MIN_RESULT_LIMIT = 1/u);
  assert.match(panel, /const MAX_RESULT_LIMIT = 10/u);
  assert.match(panel, /const DEFAULT_SEARCH_MODE = 'FASTEST'/u);
  assert.match(panel, /极速模式（默认）/u);
  assert.match(panel, /深度排序模式/u);
  assert.match(panel, /只读取首屏/u);
  assert.match(panel, /不向下滚动/u);
  assert.match(panel, /每个 Query 保留链接数/u);
  assert.match(panel, /按可确认的点赞量排序/u);
  assert.match(panel, /有效链接不足，实际保存数量可能少于设置值/u);
  assert.match(panel, /两次搜索最短间隔（秒）/u);
  assert.match(panel, /滚动 60 分钟最多搜索（次）/u);
  assert.match(panel, /滚动 24 小时最多搜索（次）/u);
  assert.match(panel, /按中心每次发放的搜索任务计数/u);
  assert.match(panel, /搜索模式、链接条数和账号保护节奏已保存/u);
  assert.match(panel, /保存小红书搜索配置/u);
});

test('Xiaohongshu result-count control reads and writes only its independent center setting', async () => {
  const panel = await readFile(panelUrl, 'utf8');

  assert.match(panel, /SETTINGS_ENDPOINT = '\/api\/control-plane\/v1\/settings'/u);
  assert.match(panel, /UPDATE_ENDPOINT = '\/api\/control-plane\/v1\/settings\/xhs_query_search'/u);
  assert.match(panel, /candidate[\s\S]*\.key === 'xhs_query_search'/u);
  assert.match(panel, /method: 'PUT'/u);
  assert.match(panel, /body: JSON\.stringify\(\{ value: \{[\s\S]*resultLimit: parsedResultLimit,[\s\S]*searchMode: draftSearchMode[\s\S]*minimumIntervalSeconds: parsedMinimumIntervalSeconds[\s\S]*hourlyLimit: parsedHourlyLimit[\s\S]*dailyLimit: parsedDailyLimit/u);
  assert.doesNotMatch(panel, /settings\/production/u);
  assert.match(panel, /!Number\.isInteger\(parsedResultLimit\)/u);
  assert.match(panel, /parsedResultLimit < MIN_RESULT_LIMIT/u);
  assert.match(panel, /parsedResultLimit > MAX_RESULT_LIMIT/u);
  assert.match(panel, /parsedHourlyLimit > maximumPerHour/u);
  assert.match(panel, /Math\.min\(Math\.floor\(86400 \/ parsedMinimumIntervalSeconds\), parsedHourlyLimit \* 24\)/u);
  assert.match(panel, /disabled=\{disabled \|\| invalid \|\| !changed\}/u);
});
