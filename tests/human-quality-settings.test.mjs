import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  DEFAULT_HUMAN_QUALITY_SETTINGS,
  normalizeHumanQualitySettings,
  normalizeHumanQualitySettingsUpdate,
} from '../src/human-quality-settings.mjs';
import {
  createProductionSettingsStore,
  initializeProductionSettingsSchema,
} from '../src/admin/production-settings-store.mjs';

const projectFile = path => new URL(`../${path}`, import.meta.url);

test('human quality settings keep both current eight-item defaults and normalize safe custom text', () => {
  const defaults = normalizeHumanQualitySettings();
  assert.deepEqual(defaults, DEFAULT_HUMAN_QUALITY_SETTINGS);
  assert.equal(defaults.copyReasons.length, 8);
  assert.equal(defaults.imageReasons.length, 8);

  const custom = normalizeHumanQualitySettings({
    copyReasons: [{ code: ' 信息不完整 ', label: ' 信息不完整 ' }],
    imageReasons: [],
  });
  assert.deepEqual(custom, { copyReasons: [{ code: '信息不完整', label: '信息不完整' }], imageReasons: [] });
});

test('human quality settings reject oversized, duplicated and structurally untrusted input', () => {
  assert.throws(() => normalizeHumanQualitySettings({
    copyReasons: Array.from({ length: 11 }, (_, index) => ({ code: `R${index}`, label: `原因${index}` })),
    imageReasons: [],
  }), /at most 10/iu);
  assert.throws(() => normalizeHumanQualitySettings({
    copyReasons: [{ code: 'SAME', label: '原因一' }, { code: 'same', label: '原因二' }], imageReasons: [],
  }), /duplicate code/iu);
  assert.throws(() => normalizeHumanQualitySettings({
    copyReasons: [{ code: 'ONE', label: '相同' }, { code: 'TWO', label: '相同' }], imageReasons: [],
  }), /duplicate label/iu);
  assert.throws(() => normalizeHumanQualitySettings({
    copyReasons: [{ code: 'BAD\nCODE', label: '原因' }], imageReasons: [],
  }), /control/iu);
  assert.throws(() => normalizeHumanQualitySettings({
    copyReasons: [{ code: 'OK', label: '原因', html: '<script>' }], imageReasons: [],
  }), /only code and label/iu);
  assert.throws(() => normalizeHumanQualitySettings({ copyReasons: [], imageReasons: [], unexpected: true }), /unsupported/iu);
  assert.throws(() => normalizeHumanQualitySettingsUpdate({ copyReasons: [] }), /copyReasons and imageReasons/iu);
});

test('local production settings persist reason options without losing them on unrelated updates', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeProductionSettingsSchema(db);
    const store = createProductionSettingsStore(db);
    const reasons = { copyReasons: [{ code: '内容太泛', label: '内容太泛' }], imageReasons: [] };
    store.updateProductionSettings({ humanQualityReasons: reasons });
    store.updateProductionSettings({ aiDisclosureEnabled: false });
    assert.deepEqual(store.getProductionSettings().settings.humanQualityReasons, reasons);
  } finally {
    db.close();
  }
});

test('production settings and review clients expose the dedicated editable reason contract', async () => {
  const [page, panel, route, hook, reviewDialog, center, proxy] = await Promise.all([
    readFile(projectFile('app/settings/page.tsx'), 'utf8'),
    readFile(projectFile('app/settings/human-quality-settings-panel.tsx'), 'utf8'),
    readFile(projectFile('app/api/human-quality-settings/route.ts'), 'utf8'),
    readFile(projectFile('app/workbench/human-quality-settings.ts'), 'utf8'),
    readFile(projectFile('app/workbench/task-review-dialog.tsx'), 'utf8'),
    readFile(projectFile('server/src/http-server.mjs'), 'utf8'),
    readFile(projectFile('src/control-plane/proxy-access.mjs'), 'utf8'),
  ]);
  assert.match(page, /HumanQualitySettingsPanel/u);
  assert.match(panel, /文案扣分原因/u);
  assert.match(panel, /图片扣分原因/u);
  assert.match(panel, /method: 'PUT'/u);
  assert.match(route, /roles: \['ADMIN', 'REVIEWER', 'USER'\]/u);
  assert.match(route, /roles: \['ADMIN'\]/u);
  assert.match(route, /ControlPlaneApiError/u);
  assert.match(route, /new ApiError\(error\.status, error\.code, error\.message\)/u);
  assert.match(hook, /loadHumanQualitySettings/u);
  assert.match(hook, /settings, loading, error, refresh/u);
  assert.match(reviewDialog, /useHumanQualitySettings\(taskId\)/u);
  assert.match(reviewDialog, /reasonOptions=\{copyReasonOptions\}/u);
  assert.match(reviewDialog, /reasonOptions=\{imageReasonOptions\}/u);
  assert.match(center, /get\('\/v1\/human-quality-settings'/u);
  assert.match(center, /put\('\/v1\/human-quality-settings'/u);
  assert.match(proxy, /human-quality-settings/u);
});
