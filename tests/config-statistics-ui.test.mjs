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
