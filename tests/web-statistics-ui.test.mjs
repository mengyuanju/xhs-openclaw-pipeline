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
  assert.match(efficiency, /流程完成耗时分布/);
  assert.match(efficiency, /labels=\{\['平均值', '中位数', 'P90'\]\}/);
  assert.match(efficiency, /未发生同阶段重做占比/);
  assert.match(efficiency, /人工首评质量/);
  assert.match(efficiency, /文案首评 3 分率/);
  assert.match(efficiency, /文案首评高于 2 分占比/);
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

test('personal workbench exposes completion dates, stage totals, current states and task lookup', async () => {
  const [overview, types, styles] = await Promise.all([
    source('app/workbench-statistics/personal-overview.tsx'),
    source('app/workbench-statistics/types.ts'),
    source('app/globals.css'),
  ]);
  for (const label of ['完成数据', '今天', '昨天', '近 7 天', '文案完成', '图片完成', '完成任务当前在哪', '对应任务']) {
    assert.match(overview, new RegExp(label, 'u'));
  }
  assert.match(overview, /type="date"/u);
  assert.match(overview, /任务 ID \/ Query/u);
  assert.match(overview, /onTaskSelect\?\.\(task\.id\)/u);
  assert.match(types, /completedWork\?: CompletedWork/u);
  assert.match(styles, /\.personal-completion-states/u);
  assert.match(styles, /\.personal-completion-task-list/u);
});

test('personal statistics and paged task lookup are split and share server filters', async () => {
  const [workbench, controls, dashboard, page] = await Promise.all([
    source('app/workbench/creation-workbench.tsx'), source('app/workbench/personal-controls.tsx'),
    source('app/workbench/personal-statistics/personal-statistics-dashboard.tsx'), source('app/workbench/personal-statistics/page.tsx'),
  ]);
  assert.match(page, /readServerSession/u);
  assert.match(workbench, /personal-workspace\/tasks/u);
  assert.doesNotMatch(workbench, /PersonalWorkbenchNavigation|useStatistics/u);
  assert.match(workbench, /taskPage\.counts/u);
  assert.match(workbench, /deliveryHistoryOpen && <OperatorDeliveryHistory/u);
  assert.match(controls, /PERSONAL_WORK_FILTERS\.map/u);
  assert.match(controls, /onCategory\(value\)/u);
  assert.match(dashboard, /personal-workspace\/statistics/u);
  assert.match(dashboard, /historyHref\('REWORK'\)/u);
  assert.match(dashboard, /reworkType:'BOTH'/u);
  assert.match(workbench, /task\.canOpen === false/u);
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
