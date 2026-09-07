import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { normalizeProductionSettings } from '../src/production-settings.mjs';
import { createProductionSettingsStore, initializeProductionSettingsSchema } from '../src/admin/production-settings-store.mjs';

const preset = (fields = {}) => ({ id: 'right-subject', name: '右图左文', kind: 'hero', enabled: true,
  layout: { mode: 'CUSTOM', subjectPosition: 'right', textPosition: 'left', direction: '标题靠左，主体靠右' }, ...fields });

test('global layout types persist and survive unrelated settings updates', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeProductionSettingsSchema(db);
    const store = createProductionSettingsStore(db);
    store.updateProductionSettings({ layoutPresets: [preset()] });
    store.updateProductionSettings({ aiDisclosureEnabled: false });
    assert.equal(store.getProductionSettings().settings.layoutPresets?.[0]?.name, '右图左文');
    assert.equal(store.getProductionSettings().settings.layoutPresets[0].layout.subjectPosition, 'right');
  } finally { db.close(); }
});

test('layout library rejects duplicate ids, unsupported kinds and invalid layouts before saving', () => {
  for (const layoutPresets of [[preset(), preset()], [preset({ kind: 'unknown' })], [preset({ name: '' })],
    [preset({ layout: { mode: 'CUSTOM', imageShare: 101 } })], [preset({ layout: { mode: 'AUTO' } })]]) {
    assert.throws(() => normalizeProductionSettings({ layoutPresets }), /布局|layout/i);
  }
});

test('automatic layouts randomly include enabled matching types and built-ins, then stay fixed for resume', async () => {
  const { assignRandomLayouts } = await import('../src/image-layout-controls.mjs');
  const post = { imagePlan: [{ kind: 'hero' }, { kind: 'steps', layout: { mode: 'AUTO' } }] };
  const presets = [preset(), preset({ id: 'disabled', enabled: false }), preset({ id: 'wrong-kind', kind: 'summary' })];
  const first = assignRandomLayouts(post, presets, () => 0);
  const last = assignRandomLayouts(post, presets, () => 0.999);
  assert.equal(first.imagePlan[0].layout.template, 'HERO_LEFT');
  assert.equal(last.imagePlan[0].layout.mode, 'CUSTOM');
  assert.equal(last.imagePlan[0].layout.direction, '标题靠左，主体靠右');
  assert.equal(last.imagePlan[1].layout.template, 'STEPS_DIAGONAL');
  assert.deepEqual(assignRandomLayouts(last, presets, () => assert.fail('resume must not redraw layouts')), last);
  assert.equal(post.imagePlan[0].layout, undefined);
});

test('all-page layout types reach the visual plan and image prompt without changing approved text', async () => {
  const { assignRandomLayouts } = await import('../src/image-layout-controls.mjs');
  const { createMockPost, buildDeliveryImageTaskPrompt } = await import('../src/pipeline.mjs');
  const { generateVisualPlan } = await import('../src/visual-plan-generation.mjs');
  const original = createMockPost(3);
  const post = assignRandomLayouts(original, [preset({ kind: 'all' })], () => 0.999);
  const result = await generateVisualPlan({ post, client: { runText() { throw new Error('offline'); } }, allowTransportFallback: () => true });
  assert.ok(result.visualPlan.pages.every(page => page.layoutTemplate === 'CUSTOM' && page.manualLayout.subjectPosition === 'right'));
  assert.deepEqual(post.imagePlan.map(page => page.bullets), original.imagePlan.map(page => page.bullets));
  assert.match(buildDeliveryImageTaskPrompt({ post, plan: post.imagePlan[0], visualPage: result.visualPlan.pages[0], imageIndex: 1, imageCount: 3 }), /标题靠左，主体靠右/);
});

test('central settings validate layout kinds and keep them in the persisted production snapshot', async () => {
  const { PostgresControlPlaneRepository } = await import('../server/src/postgres-repository.mjs');
  let saved;
  const repository = new PostgresControlPlaneRepository({ pool: { async query(sql, [key, value]) {
    saved = value;
    return { rows: [{ key, value, version: 1 }] };
  } } });
  const result = await repository.upsertSetting('production', { layoutPresets: [preset()], existingPolicy: 'preserved' });
  assert.equal(result.value.layoutPresets[0].layout.textPosition, 'left');
  assert.equal(result.value.existingPolicy, 'preserved');
  await assert.rejects(repository.upsertSetting('production', { layoutPresets: [preset({ kind: 'invalid' })] }), /布局/);
  assert.deepEqual(saved, result.value);
});
