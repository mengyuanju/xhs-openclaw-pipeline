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

test('personal workbench uses grouped shadcn navigation without starting a second statistics poll', async () => {
  const [overview, filters, workbench, statisticsHook, styles] = await Promise.all([
    source('app/workbench-statistics/personal-overview.tsx'),
    source('app/workbench/personal-state-filters.ts'),
    source('app/workbench/creation-workbench.tsx'),
    source('app/workbench-statistics/use-statistics.ts'),
    source('app/globals.css'),
  ]);
  assert.match(overview, /export function PersonalWorkbenchNavigation/u);
  assert.match(overview, /<Tabs[\s\S]*PERSONAL_PRIMARY_FILTERS\.map/u);
  assert.match(overview, /<Collapsible[\s\S]*高级状态/u);
  assert.match(overview, /PERSONAL_DETAIL_FILTERS\.map/u);
  assert.match(overview, /summary = statistics\.data\?\.summary/u,
    'navigation counts must reuse the existing personal statistics response');
  assert.match(filters, /personalReview[\s\S]*STATE_GROUPS\.copyReview[\s\S]*STATE_GROUPS\.imageReview/u);
  assert.match(filters, /personalProduction[\s\S]*STATE_GROUPS\.queued[\s\S]*STATE_GROUPS\.running/u);
  assert.match(filters, /IMAGE_REWORK_PENDING', label: '图片质检打回'/u);
  assert.match(workbench, /IMAGE_REWORK_PENDING: '图片质检打回'/u);
  assert.match(workbench, /activeView === 'PERSONAL' && <PersonalWorkbenchNavigation/u);
  assert.match(workbench, /onFilter=\{\(value\) => \{ setStateFilter\(value\); setPage\(1\); \}\}/u);
  assert.match(workbench, /onScope=\{\(value\) => \{ setPersonalScope\(value\); setPage\(1\); \}\}/u);
  assert.match(workbench, /useStatistics\([\s\S]*?activeView === 'PERSONAL',[\s\S]*?\)/u);
  assert.match(workbench, /personalStateFilterStates\(stateFilter\)/u);
  assert.match(workbench, /search\.set\('mine', 'true'\)[\s\S]*search\.set\('personalScope', personalScope\)[\s\S]*search\.set\('copyQaReturned', 'true'\)/u);
  assert.match(workbench, /!matchesPersonalScope\(task, personalScope, creatorUserId, creatorAccountId\)/u);
  assert.match(workbench, /!personalStates\.includes\(task\.state\)/u,
    'personal results must fail closed when the center ignores the selected lifecycle states');
  assert.match(statisticsHook, /export function useStatistics\(filters: Filters, enabled = true\)/u);
  assert.match(styles, /\.personal-workbench-status-tabs \[data-slot="tabs-list"\][^{]*\{[^}]*grid-template-columns: repeat\(5/u);
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
