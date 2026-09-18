import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createAdminStore } from '../src/admin/admin-store.mjs';
import { readPromptConfiguration, promptRuntimeFromSnapshot } from '../src/admin/prompt-runtime-service.mjs';
import {
  businessPrompt, createPromptRuntime, defaultBusinessPrompt, promptExecutionSnapshot,
  promptRuntimeSnapshot, promptPolicy, withPromptRuntime,
} from '../src/prompt-runtime.mjs';
import { buildPostPrompt } from '../src/post-contract.mjs';
import { buildTextReviewPrompt } from '../src/content-stage-review.mjs';
import { buildGovernedImageTaskPrompt, preserveImageSystemPrompt } from '../src/image-prompt.mjs';
import { executeCopyClaim, executeImagePlanRegenerationClaim } from '../src/executor/agent.mjs';
import { traceModelCall, withModelCallTracing } from '../src/model-call-trace.mjs';
import { createMockPost } from '../src/pipeline.mjs';
import { defaultLayoutTemplate } from '../src/layout-contract.mjs';

const TEXT_RULE = '已发布文案规则：围绕 {{query}} 完整回答。';
const PLAN_RULE = '已发布图文规划v3：内容页严格按正文观点顺序展开；沿用对应小标题。';
const version = (content, versionId, number = 3) => ({ content, versionId, version: number });
function snapshot() {
  return {
    capturedAt: '2026-09-15T06:15:46.035Z',
    productionSettings: { production: { value: {} } },
    task: { id: 219, query: '桌面整理策略', input: {}, requestedImageCount: 'auto' },
    knowledge: [],
    prompts: {
      TEXT_SYSTEM: version(TEXT_RULE, 12, 5),
      COPY_IMAGE_PLAN_SYSTEM: version(PLAN_RULE, 15),
      VISUAL_PLAN_SYSTEM: null,
    },
  };
}

test('center configuration loads published rules without a policy record and excludes drafts', async () => {
  const templates = Object.entries(snapshot().prompts).map(([kind, published]) => ({ kind, versions: [
    { id: 999, version: 99, status: 'DRAFT', content: '未发布草稿不可执行' },
    ...(published ? [{ ...published, id: published.versionId, status: 'PUBLISHED' }] : []),
  ] }));
  const config = await readPromptConfiguration({ controlPlane: {
    listPrompts: async () => templates, listSettings: async () => [], listKnowledge: async () => [],
  } });
  assert.equal(config.settings, null);
  assert.ok(config.promptRuntime);
  const prompt = withPromptRuntime(config.promptRuntime, () => buildPostPrompt(snapshot().task, { imageCount: 'auto' }));
  assert.ok(prompt.includes(PLAN_RULE));
  assert.match(prompt, /已发布文案规则：围绕 桌面整理策略 完整回答/u);
  assert.ok(!prompt.includes('未发布草稿不可执行'));
  assert.ok(!prompt.includes(defaultBusinessPrompt('COPY_IMAGE_PLAN_SYSTEM')));
});

test('published-only snapshots survive replay without enabling managed policy checks', () => {
  const input = snapshot();
  const runtime = promptRuntimeFromSnapshot(input);
  input.prompts.COPY_IMAGE_PLAN_SYSTEM.content = '后来发布的版本';
  const replay = JSON.parse(JSON.stringify(runtime));
  withPromptRuntime(replay, () => {
    assert.equal(promptRuntimeSnapshot(), null);
    assert.equal(promptPolicy().queryReviewEnabled, false);
    assert.equal(promptExecutionSnapshot().settings, null);
    assert.equal(promptExecutionSnapshot().capturedAt, input.capturedAt);
    assert.ok(businessPrompt('COPY_IMAGE_PLAN_SYSTEM').includes(PLAN_RULE));
    assert.ok(businessPrompt('RESEARCH_SYSTEM').includes(defaultBusinessPrompt('RESEARCH_SYSTEM')));
    assert.match(buildTextReviewPrompt({ query: '测试', post: createMockPost(3) }), /已发布文案规则/u);
  });
  assert.equal(promptExecutionSnapshot(), null);
  assert.equal(promptRuntimeFromSnapshot({ prompts: {} }), null);
  assert.equal(promptRuntimeFromSnapshot(null), null);
  replay.prompts.COPY_IMAGE_PLAN_SYSTEM.content = '篡改后的规则';
  assert.throws(() => withPromptRuntime(replay, () => assert.fail('must not execute')), /hash/u);
});

test('configured policies still require published stage rules', () => {
  const input = snapshot();
  input.productionSettings.prompt_runtime = { value: { copyKnowledgeThreshold: 81 } };
  withPromptRuntime(promptRuntimeFromSnapshot(input), () => {
    assert.equal(promptRuntimeSnapshot().settings.copyKnowledgeThreshold, 81);
    assert.throws(() => businessPrompt('RESEARCH_SYSTEM'), /缺少已发布提示词 RESEARCH_SYSTEM/u);
  });
});

for (const repairKind of ['imagePlan', 'body']) {
  test(`copy execution sends frozen published rules during generation and ${repairKind} repair without prompt_runtime`, async () => {
    const input = snapshot();
    const valid = createMockPost(3);
    const invalid = structuredClone(valid);
    if (repairKind === 'imagePlan') invalid.imagePlan[1].headline = '长'.repeat(19);
    else invalid.body = `${'文'.repeat(649)}。`;
    const execution = { id: randomUUID(), snapshot: input };
    const prompts = [];
    const records = [];
    const progress = [];
    const client = {
      async runText({ prompt }) {
        prompts.push(prompt);
        return traceModelCall({ provider: 'fake', operation: 'TEXT', model: 'fake', prompt, request: {} }, async () => ({
          rawText: JSON.stringify(prompts.length === 1 ? invalid : repairKind === 'body' ? { body: valid.body } : valid),
          model: 'fake',
        }));
      },
      runReview() { assert.fail('loading published templates must not enable automatic review'); },
    };
    const result = await withModelCallTracing({ executionId: execution.id, snapshot: input, controlPlane: {
      updateProgress: async (_id, value) => { progress.push(value.stage); },
      completeCopy: async (_id, value) => value,
      recordModelCall: async (_id, _callId, value) => { records.push(structuredClone(value)); },
    } }, controlPlane => executeCopyClaim({ claim: { execution }, controlPlane, client }));
    assert.equal(prompts.length, 2);
    assert.equal(result.copy.body, valid.body);
    for (const prompt of prompts) {
      assert.ok(prompt.includes(PLAN_RULE));
      assert.match(prompt, /已发布文案规则/u);
      assert.ok(!prompt.includes(defaultBusinessPrompt('COPY_IMAGE_PLAN_SYSTEM')));
    }
    assert.ok(progress.includes(repairKind === 'body' ? 'COPY_LENGTH_REPAIR' : 'COPY_CONTRACT_REPAIR'));
    for (const record of records.filter(record => record.status === 'SUCCEEDED')) {
      const provenance = JSON.parse(record.request).provenance;
      assert.equal(provenance.runtime.settings, null);
      const plan = provenance.versions.find(item => item.kind === 'COPY_IMAGE_PLAN_SYSTEM');
      assert.equal(plan.versionId, 15);
      assert.equal(plan.version, 3);
      assert.equal(plan.source, 'EXECUTION_SNAPSHOT');
    }
    const fallback = JSON.parse(records.at(-1).request).provenance.versions
      .find(item => item.kind === (repairKind === 'body' ? 'COPY_LENGTH_REPAIR_SYSTEM' : 'COPY_REPAIR_SYSTEM'));
    assert.equal(fallback.source, 'BUNDLED_DEFAULT');
    assert.equal(fallback.versionId, null);
  });
}

test('image-plan regeneration receives the frozen published template without a policy record', async () => {
  const executionId = randomUUID();
  const regenerationId = randomUUID();
  const input = snapshot();
  const post = createMockPost(3);
  input.imagePlanRegeneration = { id: regenerationId, copy: { title: post.title, body: post.body, tags: post.tags } };
  let sent;
  const result = await executeImagePlanRegenerationClaim({
    claim: { execution: { id: executionId, snapshot: input }, imagePlanRegeneration: {
      id: regenerationId, executionId, status: 'RUNNING',
    } },
    client: { async runText({ prompt }) { sent = prompt; return { rawText: JSON.stringify({ imagePlan: post.imagePlan }) }; } },
    controlPlane: { completeImagePlanRegeneration: async (_id, value) => value },
  });
  assert.ok(sent.includes(PLAN_RULE));
  assert.ok(!sent.includes(defaultBusinessPrompt('COPY_IMAGE_PLAN_SYSTEM')));
  assert.deepEqual(result.imagePlan, post.imagePlan);
});

test('image requests compose a published template once without activating managed OCR', () => {
  const runtime = createPromptRuntime({ settings: null, prompts: { IMAGE_SYSTEM: version('后台图片规则：{{query}}', 20, 8) } });
  withPromptRuntime(runtime, () => {
    const post = createMockPost(3);
    const prompt = buildGovernedImageTaskPrompt({ post, plan: post.imagePlan[0],
      visualPage: { layoutTemplate: defaultLayoutTemplate('hero'), allowedVisibleText: {} }, imageIndex: 1, imageCount: 3,
      variables: { query: '当前选题' },
    });
    assert.match(prompt, /后台图片规则：当前选题/u);
    assert.equal(preserveImageSystemPrompt('重复的外层图片规则'), '');
    assert.equal(promptRuntimeSnapshot(), null);
  });
});

test('local tasks freeze published templates even before policy activation', async () => {
  const store = createAdminStore(':memory:');
  try {
    const template = store.listPromptTemplates().find(item => item.kind === 'COPY_IMAGE_PLAN_SYSTEM');
    const published = store.createPromptVersion({ templateId: template.id, content: PLAN_RULE });
    store.publishPromptVersion(published.id);
    const config = await readPromptConfiguration({ store });
    assert.equal(config.settings, null);
    assert.ok(config.promptRuntime);
    const first = store.pinTaskPromptRuntime(219);
    const next = store.createPromptVersion({ templateId: template.id, content: '后来发布的新规则' });
    store.publishPromptVersion(next.id);
    assert.deepEqual(store.pinTaskPromptRuntime(219), first);
    assert.equal(first.settings, null);
    assert.equal(first.prompts.COPY_IMAGE_PLAN_SYSTEM.content, PLAN_RULE);
    assert.equal(store.pinTaskPromptRuntime(220).prompts.COPY_IMAGE_PLAN_SYSTEM.content, '后来发布的新规则');
    assert.equal(store.getPromptRuntimeSettings(), null);
  } finally { store.close(); }
});
