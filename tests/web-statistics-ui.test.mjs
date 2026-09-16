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

test('historical account generations cannot navigate through the current-account assignee filter', async () => {
  const [people, types] = await Promise.all([
    source('app/workbench-statistics/people-table.tsx'),
    source('app/workbench-statistics/types.ts'),
  ]);
  assert.match(types, /accountId: number \| null/u);
  assert.match(people, /person\.accountId !== null && person\.username/u);
  assert.match(people, /assignedToAccountId=\$\{person\.accountId\}/u);
  assert.match(people, /已删除账号单列为历史账号/u);
  assert.match(people, /person\.accountId \?\? 'historical'/u);
});

test('people work table excludes unassigned work and shows first-review pass rate', async () => {
  const [people, page] = await Promise.all([
    source('app/workbench-statistics/people-table.tsx'),
    source('app/workbench-statistics/admin-statistics.tsx'),
  ]);
  assert.match(people, /people\.filter\(person => person\.username !== null\)/u);
  assert.match(people, /label: '首评通过率'/u);
  assert.match(people, /尚未分配的作业不计入人员表/u);
  assert.match(page, /<EfficiencyPanel data=\{data\?\.details \?\? null\} compact/u);
  assert.match(page, /不作为负责人或角色展示/u);
});

test('admin statistics combines the key work views into one compact dashboard', async () => {
  const [page, chart] = await Promise.all([
    source('app/workbench-statistics/admin-statistics.tsx'),
    source('app/workbench-statistics/statistics-chart.tsx'),
  ]);
  for (const heading of ['团队作业总览', '负责人作业', '当前作业状态']) {
    assert.match(page, new RegExp(heading, 'u'));
  }
  assert.doesNotMatch(page, /<Tabs|TabsContent|TabsTrigger/u);
  assert.match(page, /job-stats-summary-strip/u);
  assert.match(page, /job-stats-command-grid/u);
  assert.match(page, /workerAccountId/u);
  assert.match(page, /本期流转与当前待处理分轴显示/u);
  assert.match(page, /variant="team"/u);
  assert.match(page, /variant="donut"/u);
  assert.match(page, /size=\{20\} strokeWidth=\{2\.3\}/u);
  assert.doesNotMatch(page, /库存|产能|经营总览|人员绩效/u);
  assert.match(chart, /PieChart/u);
  assert.match(chart, /chartType === 'team'/u);
  assert.match(chart, /Number\(params\.value\) > 0 \? String\(params\.value\) : ''/u);
  assert.match(chart, /labelLayout: \{ hideOverlap: true, moveOverlap: 'shiftY' \}/u);
});
