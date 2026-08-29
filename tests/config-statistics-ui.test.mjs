import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = (path) => readFile(join(root, path), 'utf8');

test('production settings route and page expose validated repair and disclosure controls', async () => {
  const [route, page, form, nav] = await Promise.all([
    source('app/api/production-settings/route.ts'),
    source('app/settings/page.tsx'),
    source('app/settings/production-settings-form.tsx'),
    source('app/components/side-nav.tsx'),
  ]);

  assert.match(route, /export function GET/);
  assert.match(route, /export async function PATCH/);
  assert.match(route, /\.strict\(\)/);
  assert.match(route, /qualityRepairMaxAttempts/);
  assert.match(route, /aiDisclosureEnabled/);
  assert.match(page, /<h1 className="sr-only">生产配置<\/h1>/);
  assert.match(form, /最多修复次数/);
  assert.match(form, /触发分数/);
  assert.match(form, /目标分数/);
  assert.match(form, /AI生成标识/);
  assert.match(form, /fetch|apiRequest/);
  assert.match(form, /aria-live="polite"/);
  assert.match(nav, /\/settings/);
});

test('analytics and review surfaces show explicit batch timing and repair evidence', async () => {
  const [analytics, statisticsRoute, imageBatch, imports, styles, nav] = await Promise.all([
    source('app/analytics/page.tsx'),
    source('app/api/statistics/route.ts'),
    source('app/tasks/[id]/image-generation-batch.tsx'),
    source('app/imports/page.tsx'),
    source('app/globals.css'),
    source('app/components/side-nav.tsx'),
  ]);

  assert.match(statisticsRoute, /pageSize/);
  assert.match(statisticsRoute, /listProductionStatistics/);
  assert.match(analytics, /<h1 className="sr-only">数据统计<\/h1>/);
  assert.match(analytics, /评分分布/);
  assert.match(analytics, /质量修复/);
  assert.match(analytics, /批次耗时/);
  assert.match(imageBatch, /qualityRepair/);
  assert.match(imageBatch, /修复原因/);
  assert.match(imageBatch, /修复方法/);
  assert.match(imageBatch, /durationMs/);
  assert.match(imports, /statistics/);
  assert.match(imports, /生成进度/);
  assert.match(styles, /\.quality-repair-history/);
  assert.match(styles, /\.analytics-score-grid/);
  assert.match(nav, /\/analytics/);
});
