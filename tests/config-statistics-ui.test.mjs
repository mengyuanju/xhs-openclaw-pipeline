import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = (path) => readFile(join(root, path), 'utf8');

test('production settings route and page expose validated repair and disclosure controls', async () => {
  const [route, page, form, workspace, central, overview, humanPanel, styles, nav] = await Promise.all([
    source('app/api/production-settings/route.ts'),
    source('app/settings/page.tsx'),
    source('app/settings/production-settings-form.tsx'),
    source('app/settings/settings-workspace.tsx'),
    source('app/components/central-data-workbench.tsx'),
    source('app/settings/quality-settings-overview.tsx'),
    source('app/settings/human-quality-settings-panel.tsx'),
    source('app/globals.css'),
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
  for (const label of ['生成与模型', '质量与审核', '图片与输出', '兼容与高级']) {
    assert.match(form, new RegExp(label, 'u'));
  }
  assert.match(workspace, /role="tablist"/u);
  assert.match(workspace, /role="tab"/u);
  assert.match(workspace, /role="tabpanel"/u);
  assert.match(workspace, /ArrowRight[\s\S]*ArrowLeft[\s\S]*Home[\s\S]*End/u);
  assert.match(form, /onDirtyChange=\{reportSearchDirty\}/u);
  assert.match(form, /onDirtyChange=\{reportHumanQualityDirty\}/u);
  assert.match(form, /onDirtyChange=\{reportLayoutCatalogDirty\}/u);
  assert.match(central, /SettingsWorkspace/u);
  assert.match(central, /'layoutCatalog', 'layoutPresets', 'humanQualityReasons'/u);
  assert.match(central, /!production \?[^]*编辑器已停用/u);
  assert.match(central, /value\.modelApi\s*=\s*\{\s*\.\.\.value\.modelApi,\s*\.\.\.normalizeWebSearchSettings\(latestProduction\.modelApi \?\? \{\}\),?\s*\}/u);
  assert.doesNotMatch(central, /key=\{`(?:layout-presets|production-settings)-\$\{production/u);
  assert.match(overview, /production-v2/u);
  assert.match(overview, /人工审核评分/u);
  assert.match(humanPanel, /<fieldset key=\{definition\.score\}/u);
  assert.match(humanPanel, /onDirtyChange\?\.\(hasChanges\)/u);
  assert.match(styles, /@media \(max-width: 760px\)[^]*\.settings-workspace-tabs \{ top: 58px/u);
  assert.match(nav, /\/settings/);
});
