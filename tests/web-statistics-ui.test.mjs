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
