import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  DEFAULT_COPY_REVIEW_DISPLAY,
  DEFAULT_HUMAN_QUALITY_NOTE_GUIDANCE,
  DEFAULT_HUMAN_QUALITY_SETTINGS,
  DEFAULT_HUMAN_SCORE_DEFINITIONS,
  normalizeHumanQualitySettings,
  normalizeHumanQualitySettingsUpdate,
} from '../src/human-quality-settings.mjs';
import { createSessionToken } from '../src/admin/auth.mjs';
import { evaluateAdminProxyRequest } from '../src/admin/proxy-policy.mjs';
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
  assert.deepEqual(defaults.copyReviewDisplay, DEFAULT_COPY_REVIEW_DISPLAY);

  const custom = normalizeHumanQualitySettings({
    copyReasons: [{ code: ' 信息不完整 ', label: ' 信息不完整 ' }],
    imageReasons: [],
  });
  assert.deepEqual(custom, {
    scoreDefinitions: DEFAULT_HUMAN_SCORE_DEFINITIONS,
    copyReasons: [{ code: '信息不完整', label: '信息不完整' }],
    imageReasons: [],
    noteGuidance: DEFAULT_HUMAN_QUALITY_NOTE_GUIDANCE,
    copyReviewDisplay: DEFAULT_COPY_REVIEW_DISPLAY,
  });
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
    scoreDefinitions: DEFAULT_HUMAN_SCORE_DEFINITIONS.slice(0, 3),
  }), /exactly four/iu);
  assert.throws(() => normalizeHumanQualitySettings({
    scoreDefinitions: DEFAULT_HUMAN_SCORE_DEFINITIONS.map((definition, index) => (
      index === 1 ? { ...definition, score: 1 } : definition
    )),
  }), /each fixed score exactly once/iu);
  assert.throws(() => normalizeHumanQualitySettings({
    noteGuidance: { copyPlaceholder: '有效提示', imagePlaceholder: '含\n控制字符' },
  }), /control/iu);
  assert.throws(() => normalizeHumanQualitySettings({
    copyReasons: [{ code: 'OK', label: '原因', html: '<script>' }], imageReasons: [],
  }), /only code and label/iu);
  assert.throws(() => normalizeHumanQualitySettings({
    copyReviewDisplay: { showScoreDescriptions: 'yes', showDeductionReasons: true },
  }), /showScoreDescriptions must be a boolean/iu);
  assert.throws(() => normalizeHumanQualitySettings({
    copyReviewDisplay: { showScoreDescriptions: true },
  }), /must contain only showScoreDescriptions and showDeductionReasons/iu);
  assert.throws(() => normalizeHumanQualitySettings({
    copyReviewDisplay: { showScoreDescriptions: true, showDeductionReasons: true, extra: false },
  }), /must contain only showScoreDescriptions and showDeductionReasons/iu);
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
    const saved = store.getProductionSettings().settings.humanQualityReasons;
    assert.deepEqual(saved.copyReasons, reasons.copyReasons);
    assert.deepEqual(saved.imageReasons, reasons.imageReasons);
    assert.deepEqual(saved.scoreDefinitions, DEFAULT_HUMAN_SCORE_DEFINITIONS);
    assert.deepEqual(saved.noteGuidance, DEFAULT_HUMAN_QUALITY_NOTE_GUIDANCE);
    assert.deepEqual(saved.copyReviewDisplay, DEFAULT_COPY_REVIEW_DISPLAY);
  } finally {
    db.close();
  }
});

test('legacy reason-only updates preserve customized score copy and note guidance', () => {
  const current = normalizeHumanQualitySettings({
    scoreDefinitions: DEFAULT_HUMAN_SCORE_DEFINITIONS.map((definition) => ({
      ...definition,
      title: `${definition.score} 分自定义`,
      description: `${definition.score} 分的团队说明`,
    })),
    copyReasons: [{ code: 'OLD_COPY', label: '原文案原因' }],
    imageReasons: [{ code: 'OLD_IMAGE', label: '原图片原因' }],
    noteGuidance: { copyPlaceholder: '自定义文案提示', imagePlaceholder: '自定义图片提示' },
    copyReviewDisplay: { showScoreDescriptions: false, showDeductionReasons: false },
  });
  const updated = normalizeHumanQualitySettingsUpdate({
    copyReasons: [{ code: 'NEW_COPY', label: '新文案原因' }],
    imageReasons: [],
  }, current);
  assert.deepEqual(updated.scoreDefinitions, current.scoreDefinitions);
  assert.deepEqual(updated.noteGuidance, current.noteGuidance);
  assert.deepEqual(updated.copyReviewDisplay, current.copyReviewDisplay);
  assert.deepEqual(updated.copyReasons, [{ code: 'NEW_COPY', label: '新文案原因' }]);
  assert.deepEqual(updated.imageReasons, []);
});

test('production settings and review clients expose the dedicated editable scoring contract', async () => {
  const [page, form, panel, route, hook, reviewDialog, centerWorkbench, center, proxy] = await Promise.all([
    readFile(projectFile('app/settings/page.tsx'), 'utf8'),
    readFile(projectFile('app/settings/production-settings-form.tsx'), 'utf8'),
    readFile(projectFile('app/settings/human-quality-settings-panel.tsx'), 'utf8'),
    readFile(projectFile('app/api/human-quality-settings/route.ts'), 'utf8'),
    readFile(projectFile('app/workbench/human-quality-settings.ts'), 'utf8'),
    readFile(projectFile('app/workbench/task-review-dialog.tsx'), 'utf8'),
    readFile(projectFile('app/components/central-data-workbench.tsx'), 'utf8'),
    readFile(projectFile('server/src/http-server.mjs'), 'utf8'),
    readFile(projectFile('src/control-plane/proxy-access.mjs'), 'utf8'),
  ]);
  assert.match(page, /ProductionSettingsForm/u);
  assert.match(form, /HumanQualitySettingsPanel/u);
  assert.match(centerWorkbench, /HumanQualitySettingsPanel/u);
  assert.match(panel, /评分档位说明/u);
  assert.match(panel, /scoreDefinitions: current\.scoreDefinitions/u);
  assert.match(panel, /评分说明提示/u);
  assert.match(panel, /文案扣分原因/u);
  assert.match(panel, /图片扣分原因/u);
  assert.match(panel, /文案审核中显示评分档位说明/u);
  assert.match(panel, /文案审核中显示扣分原因/u);
  assert.match(panel, /copyReviewDisplay: current\.copyReviewDisplay/u);
  assert.match(panel, /<Switch/u);
  assert.match(panel, /method: 'PUT'/u);
  assert.match(route, /copyReviewDisplay: z\.object/u);
  assert.match(route, /showScoreDescriptions: z\.boolean\(\)/u);
  assert.match(route, /showDeductionReasons: z\.boolean\(\)/u);
  assert.match(route, /roles: \['ADMIN', 'REVIEWER', 'USER'\]/u);
  assert.match(route, /roles: \['ADMIN'\]/u);
  assert.match(route, /forwardControlPlaneRequest/u);
  assert.match(route, /normalizeHumanQualitySettings\([\s\S]*?await forwardControlPlaneRequest/u);
  assert.match(route, /sessionActorHeaders/u);
  assert.match(hook, /loadHumanQualitySettings/u);
  assert.match(hook, /settings, loading, error, refresh/u);
  assert.match(reviewDialog, /useHumanQualitySettings\(taskId\)/u);
  assert.match(reviewDialog, /reasonOptions=\{copyReasonOptions\}/u);
  assert.match(reviewDialog, /reasonOptions=\{imageReasonOptions\}/u);
  assert.match(reviewDialog, /scoreDefinitions=\{scoreDefinitions\}/u);
  assert.match(reviewDialog, /notePlaceholder=\{humanRatingSettings\.noteGuidance\.copyPlaceholder\}/u);
  assert.match(center, /get\('\/v1\/human-quality-settings'/u);
  assert.match(center, /put\('\/v1\/human-quality-settings'/u);
  assert.match(proxy, /human-quality-settings/u);
});

test('signed-in workers and reviewers can read shared human quality reasons through the web proxy', () => {
  const environment = { XHS_SESSION_SECRET: 'human-quality-proxy-test-secret-32-characters' };
  for (const role of ['USER', 'REVIEWER']) {
    const token = createSessionToken(environment.XHS_SESSION_SECRET, {
      actor: { subject: 'user', userId: role === 'USER' ? 2 : 3, username: role.toLowerCase(), roles: [role], credentialVersion: 1 },
    });
    const request = new Request('http://127.0.0.1:3001/api/human-quality-settings', {
      headers: { cookie: `xhs_admin_session=${token}` },
    });
    assert.deepEqual(evaluateAdminProxyRequest(request, environment), { type: 'next' });
  }
});
