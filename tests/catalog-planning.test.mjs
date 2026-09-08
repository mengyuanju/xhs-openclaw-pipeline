import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_LAYOUT_CATALOG } from '../server/src/layout-catalog.mjs';
import { createMockPost, buildDeliveryImageTaskPrompt } from '../src/pipeline.mjs';
import { createMockVisualPlan, parseVisualPlanOutput } from '../src/visual-plan.mjs';
import { catalogDirectPlan, catalogDiversityIssues } from '../src/catalog-planning.mjs';
import { generateVisualPlan } from '../src/visual-plan-generation.mjs';
import { createPromptRuntime, withPromptRuntime } from '../src/prompt-runtime.mjs';
import { preparePageLayouts } from '../src/image-layout-controls.mjs';

const post = createMockPost(3);
const response = () => catalogDirectPlan(createMockVisualPlan(post), post, BUILTIN_LAYOUT_CATALOG);

test('automatic catalog planning selects in the existing single model call and renders trusted geometry', async () => {
  const inputPost = preparePageLayouts(post, [], BUILTIN_LAYOUT_CATALOG);
  assert.equal(inputPost.imagePlan[0].layout, undefined);
  let calls = 0;
  const result = await generateVisualPlan({ post: inputPost, layoutCatalog: BUILTIN_LAYOUT_CATALOG, client: { runText: async input => {
    calls += 1;
    assert.match(input.prompt, /layoutCandidates/);
    assert.ok(input.outputSchema.properties.pages.items.anyOf[0].properties.layoutTemplate.enum.includes('HERO_CENTER'));
    const value = response();
    value.pages[0].layoutTemplate = 'HERO_LEFT';
    value.pages[0].catalogTemplate = { subjectRegion: '恶意替换定义' };
    return { model: 'fake', rawText: JSON.stringify(value) };
  } } });
  assert.equal(calls, 1);
  assert.equal(result.visualPlan.pages[0].catalogTemplate.subjectRegion, '左侧');
  const prompt = buildDeliveryImageTaskPrompt({ post, plan: post.imagePlan[0], visualPage: result.visualPlan.pages[0], imageIndex: 1, imageCount: 3 });
  assert.match(prompt, /左侧/);
  assert.match(prompt, /FFF8EF/);
  assert.deepEqual(result.visualPlan.pages[0].allowedVisibleText.bullets, post.imagePlan[0].bullets);
  assert.deepEqual(parseVisualPlanOutput(JSON.stringify(result.visualPlan), { post, allowStoredCatalog: true }), result.visualPlan);
});

test('a model cannot introduce its own catalog, disabled template, or changed copy', async () => {
  for (const mutate of [value => { value.pages[0].layoutTemplate = 'FREEFORM_MAGIC'; }, value => { value.pages[0].allowedVisibleText.headline = '替换标题'; }]) {
    await assert.rejects(generateVisualPlan({ post, layoutCatalog: BUILTIN_LAYOUT_CATALOG, client: { runText: async () => {
      const value = response(); mutate(value); return { rawText: JSON.stringify(value) };
    } } }), { code: 'VISUAL_PLAN_CONTRACT_INVALID' });
  }
  assert.throws(() => parseVisualPlanOutput(JSON.stringify(response()), { post }), /layoutSchemaVersion/);
  const catalog = structuredClone(BUILTIN_LAYOUT_CATALOG);
  catalog.templates.find(item => item.layoutTemplate === response().pages[0].layoutTemplate).enabled = false;
  assert.throws(() => parseVisualPlanOutput(JSON.stringify(response()), { post, layoutCatalog: catalog }), /layoutTemplate/);
});

test('planning off keeps text and selects matching catalog layouts without calling the model', async () => {
  const runtime = createPromptRuntime({ settings: { visualPlanningEnabled: false } });
  const result = await withPromptRuntime(runtime, () => generateVisualPlan({ post, layoutCatalog: BUILTIN_LAYOUT_CATALOG, client: { runText() { assert.fail('no model call'); } } }));
  assert.equal(result.skipped, true);
  assert.equal(result.visualPlan.pages[0].layoutTemplate, 'HERO_CENTER');
  assert.equal(result.visualPlan.planningMode, 'DIRECT');
  assert.deepEqual(result.visualPlan.pages[0].allowedVisibleText.bullets, post.imagePlan[0].bullets);
});

test('catalog planning prefers unused templates and only permits repetition when every candidate is already used', () => {
  const repeatedPost = structuredClone(post);
  repeatedPost.imagePlan = [
    { ...post.imagePlan[0], kind: 'hero' },
    { ...post.imagePlan[0], kind: 'hero' },
    { ...post.imagePlan[0], kind: 'hero' },
  ];
  const plan = catalogDirectPlan(createMockVisualPlan(repeatedPost), repeatedPost, BUILTIN_LAYOUT_CATALOG);
  assert.notEqual(plan.pages[0].layoutTemplate, plan.pages[1].layoutTemplate);

  const onlyOne = structuredClone(BUILTIN_LAYOUT_CATALOG);
  onlyOne.templates = onlyOne.templates.map(item => ({ ...item, enabled: item.layoutTemplate === 'HERO_CENTER' }));
  const constrained = catalogDirectPlan(createMockVisualPlan(repeatedPost), repeatedPost, onlyOne);
  assert.equal(constrained.pages[0].layoutTemplate, constrained.pages[1].layoutTemplate);
  assert.match(constrained.pages[1].selectionReason, /候选范围不足/u);
  assert.deepEqual(catalogDiversityIssues(constrained.pages, repeatedPost, onlyOne), []);
});

test('avoidable model layout repetition is a review warning and never a generation failure', async () => {
  const repeatedPost = structuredClone(post);
  repeatedPost.imagePlan = repeatedPost.imagePlan.map(page => ({ ...page, kind: 'hero' }));
  let calls = 0;
  const result = await generateVisualPlan({ post: repeatedPost, layoutCatalog: BUILTIN_LAYOUT_CATALOG, client: { runText: async () => {
    calls += 1;
    const value = catalogDirectPlan(createMockVisualPlan(repeatedPost), repeatedPost, BUILTIN_LAYOUT_CATALOG);
    value.pages = value.pages.map(page => ({ ...page, layoutTemplate: 'HERO_CENTER', layoutKind: 'hero', templateVersion: 2 }));
    return { model: 'fake', rawText: JSON.stringify(value) };
  } } });
  assert.equal(calls, 1);
  assert.equal(result.degraded, false);
  assert.equal(result.warning.code, 'VISUAL_PLAN_LAYOUT_DIVERSITY');
  assert.equal(result.visualPlan.pages.every(page => page.layoutTemplate === 'HERO_CENTER'), true);
});
