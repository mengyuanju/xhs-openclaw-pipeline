import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('statistics charts show concrete values and efficiency compares distributions', async () => {
  const [chart, efficiency] = await Promise.all([
    source('app/workbench-statistics/statistics-chart.tsx'),
    source('app/workbench-statistics/efficiency-panel.tsx'),
  ]);
  assert.match(chart, /label:\s*\{\s*show:\s*true/);
  assert.match(chart, /valueFormatter/);
  assert.match(efficiency, /自动生成耗时对比/);
  assert.match(efficiency, /总交付耗时分布/);
  assert.match(efficiency, /labels=\{\['平均值', '中位数', 'P90'\]\}/);
  assert.match(efficiency, /一次完成率/);
  assert.match(efficiency, /人工首评质量/);
  assert.match(efficiency, /文案首评 3 分率/);
  assert.match(efficiency, /文案首评达标率/);
  assert.match(efficiency, /图片首轮 3 分率/);
  assert.match(efficiency, /图片首轮达标率/);
  assert.match(efficiency, /高于 2 分/);
  assert.match(efficiency, /无评分作业不进入样本/);
  assert.match(efficiency, /job-stats-efficiency-progress/);
});

test('personal statistics labels assignment ownership without claiming the worker created the task', async () => {
  const overview = await source('app/workbench-statistics/personal-overview.tsx');
  assert.match(overview, /label="提交或负责"/u);
  assert.doesNotMatch(overview, /label="累计创建"/u);
});

test('personal status categories sit beside saved views without starting a second statistics poll', async () => {
  const [overview, workbench, statisticsHook, styles] = await Promise.all([
    source('app/workbench-statistics/personal-overview.tsx'),
    source('app/workbench/creation-workbench.tsx'),
    source('app/workbench-statistics/use-statistics.ts'),
    source('app/globals.css'),
  ]);
  const overviewStart = overview.indexOf('export function PersonalOverview');
  const filtersStart = overview.indexOf('export function PersonalStatusFilters');
  const controlsStart = workbench.indexOf("{(role === 'ADMIN' || activeView === 'PERSONAL') && <div className=\"workbench-admin-list-controls\">");
  const listToolsStart = workbench.indexOf('<div className="workbench-list-tools">', controlsStart);
  assert.ok(overviewStart >= 0 && filtersStart > overviewStart);
  assert.doesNotMatch(overview.slice(overviewStart, filtersStart), /job-stats-chips/u);
  assert.match(overview.slice(filtersStart), /job-stats-chips workbench-personal-state-filters/u);
  assert.ok(controlsStart >= 0 && listToolsStart > controlsStart);
  const controls = workbench.slice(controlsStart, listToolsStart);
  assert.match(controls, /role === 'ADMIN' && <div className="workbench-saved-views"/u);
  assert.match(controls, /activeView === 'PERSONAL' && <PersonalStatusFilters/u);
  assert.match(controls, /onFilter=\{\(value\) => \{ setStateFilter\(value\); setPage\(1\); \}\}/u);
  assert.match(workbench, /useStatistics\([\s\S]*?activeView === 'PERSONAL',[\s\S]*?\)/u);
  assert.match(statisticsHook, /export function useStatistics\(filters: Filters, enabled = true\)/u);
  assert.match(styles, /\.workbench-personal-state-filters \{[^}]*justify-content: flex-end;[^}]*margin: 0 0 0 auto;[^}]*border: 0;/u);
});

test('historical account generations cannot navigate through the current-account creator filter', async () => {
  const [people, types] = await Promise.all([
    source('app/workbench-statistics/people-table.tsx'),
    source('app/workbench-statistics/types.ts'),
  ]);
  assert.match(types, /accountId: number \| null/u);
  assert.match(people, /person\.accountId !== null && person\.username/u);
  assert.match(people, /createdByAccountId=\$\{person\.accountId\}/u);
  assert.match(people, /已删除账号单列为历史账号/u);
  assert.match(people, /person\.accountId \?\? 'historical'/u);
});
