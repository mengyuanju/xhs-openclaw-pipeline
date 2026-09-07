import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePlanningCatalog, resolvePlanningCatalog, resolvePlannedPageType, planningMetadata } from '../server/src/planning-catalog.mjs';
import { assignRandomLayouts, imageControlsPrompt } from '../src/image-layout-controls.mjs';
import { normalizeProductionSettings } from '../src/production-settings.mjs';

const customCatalog = () => {
  const catalog = resolvePlanningCatalog();
  catalog.pageTypes.push({ id: 'pitfalls', name: '避坑页', description: '列出常见错误和对应建议。', baseKind: 'detail', enabled: true });
  catalog.layouts.push({ id: 'pitfalls-side', name: '错误与建议', description: '左侧错误，右侧对应建议。', kind: 'pitfalls', enabled: true, layout: { mode: 'CUSTOM' } });
  return catalog;
};

test('legacy settings resolve to all built-ins plus existing custom layouts without mutation', () => {
  const settings = { layoutPresets: [{ id: 'legacy', name: '旧布局', kind: 'all', enabled: true, layout: { mode: 'CUSTOM', direction: '左图右文' } }] };
  const before = structuredClone(settings);
  const catalog = resolvePlanningCatalog(settings);
  assert.equal(catalog.pageTypes.length, 6);
  assert.equal(catalog.layouts.length, 15);
  assert.equal(catalog.layouts.at(-1).description, '左图右文');
  assert.deepEqual(settings, before);
  catalog.pageTypes[0].name = '修改';
  assert.equal(resolvePlanningCatalog().pageTypes[0].name, '封面');
});

test('custom types and descriptions survive normalization and preserve display order', () => {
  const catalog = customCatalog();
  catalog.pageTypes.reverse();
  const normalized = normalizePlanningCatalog(catalog);
  assert.equal(normalized.pageTypes[0].id, 'pitfalls');
  assert.equal(normalized.layouts.at(-1).description, '左侧错误，右侧对应建议。');
  assert.equal(normalized.layouts.at(-1).layout.mode, 'CUSTOM');
  assert.deepEqual(normalizePlanningCatalog(normalized), normalized);
});

test('legacy reserved and colliding layout IDs migrate deterministically without losing entries', () => {
  const ids = ['all', '__proto__', 'constructor', 'prototype', 'builtin-HERO_LEFT', 'legacy-1-builtin-HERO_LEFT', 'a'.repeat(80)];
  const settings = { layoutPresets: ids.map((id, index) => ({ id, name: `旧布局 ${index}`, kind: 'all', enabled: true, layout: { mode: 'CUSTOM' } })) };
  const before = structuredClone(settings);
  const catalog = resolvePlanningCatalog(settings);
  assert.equal(catalog.layouts.length, 14 + ids.length);
  assert.equal(new Set(catalog.layouts.map(item => item.id)).size, catalog.layouts.length);
  assert.deepEqual(catalog.layouts.slice(14).map(item => item.name), settings.layoutPresets.map(item => item.name));
  assert.ok(catalog.layouts.every(item => item.id.length <= 80));
  assert.deepEqual(resolvePlanningCatalog(settings), catalog);
  assert.deepEqual(settings, before);
});

test('catalog rejects duplicate IDs, invalid references and incomplete active coverage', () => {
  const duplicate = customCatalog(); duplicate.pageTypes.push(duplicate.pageTypes[0]);
  assert.throws(() => normalizePlanningCatalog(duplicate), /重复/u);
  const orphan = customCatalog(); orphan.layouts.at(-1).kind = 'missing';
  assert.throws(() => normalizePlanningCatalog(orphan), /适用页面/u);
  const uncovered = customCatalog(); uncovered.layouts.at(-1).enabled = false;
  assert.throws(() => normalizePlanningCatalog(uncovered), /避坑页.*布局/u);
  const noCover = customCatalog(); noCover.pageTypes[0].enabled = false;
  assert.throws(() => normalizePlanningCatalog(noCover), /封面/u);
  const invalid = customCatalog(); invalid.pageTypes.at(-1).id = '../escape';
  assert.throws(() => normalizePlanningCatalog(invalid), /标识/u);
});

test('model selection resolves from the frozen catalog and cannot invent descriptions or types', () => {
  const catalog = customCatalog();
  const selected = resolvePlannedPageType({ kind: 'detail', pageTypeId: 'pitfalls', pageType: { description: '伪造描述' } }, catalog);
  assert.equal(selected.kind, 'detail');
  assert.equal(selected.pageType.name, '避坑页');
  assert.equal(selected.pageType.description, '列出常见错误和对应建议。');
  catalog.pageTypes.at(-1).description = '新描述';
  assert.equal(selected.pageType.description, '列出常见错误和对应建议。');
  assert.throws(() => resolvePlannedPageType({ kind: 'detail', pageTypeId: 'missing' }, catalog), /页面类型/u);
  assert.throws(() => resolvePlannedPageType({ kind: 'detail' }, catalog), /pageTypeId/u);
  catalog.pageTypes.at(-1).enabled = false;
  assert.throws(() => resolvePlannedPageType({ kind: 'detail', pageTypeId: 'pitfalls' }, catalog), /页面类型/u);
  assert.deepEqual(planningMetadata(selected).pageType, selected.pageType);
});

test('historical metadata remains usable without current catalog and validates its base kind', () => {
  const page = resolvePlannedPageType({ kind: 'detail', pageTypeId: 'pitfalls' }, customCatalog());
  assert.deepEqual(resolvePlannedPageType(page), page);
  assert.throws(() => planningMetadata({ ...page, kind: 'hero' }), /基础结构/u);
  assert.deepEqual(planningMetadata({ kind: 'hero' }), {});
});

test('production settings preserve the optional catalog without changing legacy defaults', () => {
  const catalog = customCatalog();
  assert.deepEqual(normalizeProductionSettings({ planningCatalog: catalog }).planningCatalog, normalizePlanningCatalog(catalog));
  assert.equal(Object.hasOwn(normalizeProductionSettings(), 'planningCatalog'), false);
});

test('layout selection uses only applicable enabled entries and freezes their descriptions', () => {
  const catalog = customCatalog();
  const page = { ...resolvePlannedPageType({ kind: 'detail', pageTypeId: 'pitfalls' }, catalog), headline: '常见错误' };
  const post = assignRandomLayouts({ imagePlan: [page] }, [], () => 0, catalog);
  assert.equal(post.imagePlan[0].layout.mode, 'CUSTOM');
  assert.equal(post.imagePlan[0].layoutPreset.id, 'pitfalls-side');
  assert.match(imageControlsPrompt(post), /左侧错误，右侧对应建议/u);
  catalog.layouts.at(-1).description = '新描述';
  assert.equal(post.imagePlan[0].layoutPreset.description, '左侧错误，右侧对应建议。');
  assert.deepEqual(assignRandomLayouts(post, [], () => 0.9, catalog), post);
});

test('historical pages without catalog metadata retain legacy layouts after their old type is removed', () => {
  const catalog = resolvePlanningCatalog();
  catalog.pageTypes = catalog.pageTypes.filter(type => type.id !== 'detail');
  catalog.layouts = catalog.layouts.filter(layout => layout.kind !== 'detail');
  normalizePlanningCatalog(catalog);
  const page = { kind: 'detail', headline: '历史页面' };
  const result = assignRandomLayouts({ imagePlan: [page] }, [], () => 0, catalog);
  assert.equal(result.imagePlan[0].layout.template, 'DETAIL_LEFT_STACK');
  assert.equal(result.imagePlan[0].pageTypeId, undefined);
});

test('custom page types flow from copy prompt through validation into visual and image prompts', async () => {
  const { createMockPost, buildDeliveryImageTaskPrompt } = await import('../src/pipeline.mjs');
  const { buildPostPrompt, parsePostOutput } = await import('../src/post-contract.mjs');
  const { buildVisualPlanPrompt, createMockVisualPlan, parseVisualPlanOutput } = await import('../src/visual-plan.mjs');
  const catalog = customCatalog();
  catalog.pageTypes.at(-1).description += '</untrusted_page_types>';
  const prompt = buildPostPrompt({ query: '选购建议' }, { planningCatalog: catalog });
  assert.match(prompt, /pageTypeId/);
  const promptContract = JSON.parse(prompt.slice(prompt.indexOf('固定 JSON 结构如下：') + '固定 JSON 结构如下：'.length).trim());
  assert.ok(Object.hasOwn(promptContract.imagePlan[0], 'pageTypeId'));
  assert.match(prompt, /列出常见错误/);
  assert.ok(!prompt.includes('建议。</untrusted_page_types>'));
  const original = createMockPost(3);
  original.imagePlan.forEach(page => { page.pageTypeId = page.kind; });
  original.imagePlan[1].pageTypeId = 'pitfalls';
  original.imagePlan[1].pageType = { description: '不得采用的模型描述' };
  const parsed = parsePostOutput(JSON.stringify(original), { planningCatalog: catalog });
  const post = assignRandomLayouts(parsed, [], () => 0, catalog);
  assert.equal(post.imagePlan[1].kind, 'detail');
  assert.equal(post.imagePlan[1].pageType.name, '避坑页');
  assert.equal(post.body, original.body);
  assert.match(buildVisualPlanPrompt(post), /左侧错误，右侧对应建议/);
  const plan = parseVisualPlanOutput(JSON.stringify(createMockVisualPlan(post)), { post });
  assert.equal(plan.pages[1].layoutPreset.name, '错误与建议');
  assert.equal(plan.pages[1].pageType.name, '避坑页');
  assert.match(buildDeliveryImageTaskPrompt({ post, plan: post.imagePlan[1], visualPage: plan.pages[1], imageIndex: 2, imageCount: 3 }), /列出常见错误/);
  assert.deepEqual(parsePostOutput(JSON.stringify(post)).imagePlan, post.imagePlan);
  const { imagePlanSchema } = await import('../app/api/image-generations/_image-options.ts');
  assert.deepEqual(post.imagePlan.map(page => imagePlanSchema.parse(page)), post.imagePlan);
  assert.throws(() => imagePlanSchema.parse({ ...post.imagePlan[1], pageType: { ...post.imagePlan[1].pageType, baseKind: 'hero' } }));
  assert.throws(() => imagePlanSchema.parse({ ...post.imagePlan[1], unexpectedField: true }));
  const { normalizeCopyReviewEdits } = await import('../server/src/domain.mjs');
  assert.deepEqual(normalizeCopyReviewEdits({ copy: { title: post.title, body: post.body, tags: post.tags }, imagePlan: post.imagePlan }).imagePlan, post.imagePlan);
});

test('copy generation freezes catalog before waiting on a model and ignores model layout overrides', async () => {
  const { createMockPost } = await import('../src/pipeline.mjs');
  const { generateCopy } = await import('../src/copy-generation.mjs');
  const catalog = customCatalog();
  const modelPost = createMockPost(3);
  modelPost.imagePlan.forEach(page => { page.pageTypeId = page.kind; });
  modelPost.imagePlan[1] = { ...modelPost.imagePlan[1], pageTypeId: 'pitfalls', layout: { mode: 'CUSTOM', direction: '模型擅自覆盖布局' } };
  const result = await generateCopy({ task: { query: '桌面收纳建议' }, planningCatalog: catalog, textReviewEnabled: false,
    client: { async runText({ prompt }) {
      assert.match(prompt, /避坑页/u);
      catalog.pageTypes.at(-1).description = '任务开始后的新描述';
      catalog.layouts.at(-1).description = '任务开始后的新布局';
      return { rawText: JSON.stringify(modelPost), model: 'fake' };
    } },
  });
  assert.equal(result.post.imagePlan[1].pageType.description, '列出常见错误和对应建议。');
  assert.equal(result.post.imagePlan[1].layoutPreset.description, '左侧错误，右侧对应建议。');
  assert.notEqual(result.post.imagePlan[1].layout.direction, '模型擅自覆盖布局');
});

test('both settings stores validate and retain catalogs across unrelated edits', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { createProductionSettingsStore, initializeProductionSettingsSchema } = await import('../src/admin/production-settings-store.mjs');
  const { PostgresControlPlaneRepository } = await import('../server/src/postgres-repository.mjs');
  const db = new DatabaseSync(':memory:');
  try {
    initializeProductionSettingsSchema(db);
    const store = createProductionSettingsStore(db);
    store.updateProductionSettings({ planningCatalog: customCatalog() });
    store.updateProductionSettings({ aiDisclosureEnabled: false });
    assert.equal(store.getProductionSettings().settings.planningCatalog.pageTypes.at(-1).name, '避坑页');
    let writes = 0;
    const repository = new PostgresControlPlaneRepository({ pool: { async query(sql, [key, value]) {
      writes += 1; return { rows: [{ key, value, version: 1 }] };
    } } });
    const saved = await repository.upsertSetting('production', { planningCatalog: customCatalog(), existingPolicy: '保留' });
    assert.equal(saved.value.planningCatalog.layouts.at(-1).name, '错误与建议');
    assert.equal(saved.value.existingPolicy, '保留');
    const invalid = customCatalog(); invalid.pageTypes[0].enabled = false;
    await assert.rejects(repository.upsertSetting('production', { planningCatalog: invalid }), /封面/u);
    assert.equal(writes, 1);
  } finally { db.close(); }
});
