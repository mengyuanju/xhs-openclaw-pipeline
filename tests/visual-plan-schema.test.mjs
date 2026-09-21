import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMockPost } from '../src/pipeline.mjs';
import { createMockVisualPlan, buildVisualPlanPrompt } from '../src/visual-plan.mjs';
import { visualPlanSchema, visualEvidenceOptions } from '../src/visual-plan-schema.mjs';
import { generateVisualPlan } from '../src/visual-plan-generation.mjs';
import { assertLockedImageText } from '../src/locked-image-plan.mjs';
import { createPromptRuntime, withPromptRuntime } from '../src/prompt-runtime.mjs';

const runtime = createPromptRuntime({
  prompts: { VISUAL_PLAN_SYSTEM: { content: '仅规划画面，保留全部已批准文字。' } },
  settings: { visualPlanningEnabled: true },
});

// Reproduce the strict-output API rejection without making a model call.
function assertSupportedLiterals(schema, path = '$') {
  if (!schema || typeof schema !== 'object') return;
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'enum' || key === 'const') {
      for (const literal of Array.isArray(value) ? value : [value]) {
        if (typeof literal === 'string') {
          assert.doesNotMatch(JSON.stringify(literal), /\\/u, `${path}.${key} contains a JSON escape`);
        }
      }
    } else assertSupportedLiterals(value, `${path}.${key}`);
  }
}

function quotedPost() {
  const post = createMockPost(3);
  post.title = '微信搜索推送信息';
  post.imagePlan[0].headline = '选择"查找聊天记录"';
  post.imagePlan[0].subtitle = '进入"聊天"分类';
  post.imagePlan[0].bullets = ['点右上角"···"', '按关键词筛选'];
  post.body = post.imagePlan.flatMap(page => [page.headline, page.subtitle, ...page.bullets]).join('。') + '。';
  return post;
}

test('escaped source and locked copy never become strict schema literals, including page repairs', () => {
  for (const escape of ['"', '\\', '\n', '\r', '\t', '\u0000', '\ud800']) {
    const post = createMockPost(3);
    post.body += `\n路径${escape}入口。`;
    post.imagePlan[1].headline = `查找${escape}记录`;
    post.imagePlan[1].subtitle = `按${escape}日期筛选`;
    post.imagePlan[1].bullets = [`选择${escape}聊天`, '按关键词筛选'];
    const original = structuredClone(post);
    for (const indices of [[1, 2, 3], [2]]) {
      const schema = withPromptRuntime(runtime, () => visualPlanSchema(post, indices));
      assertSupportedLiterals(schema);
      const pages = schema.properties.pages.items.anyOf ?? [schema.properties.pages.items];
      for (const page of pages) {
        const { enum: choices, ...bounds } = page.properties.sourceEvidence.items;
        assert.deepEqual(bounds, { type: 'string', minLength: 1, maxLength: 200 });
        // Newlines delimit candidates and disappear before schema construction.
        if (escape === '\n') assert.deepEqual(choices, visualEvidenceOptions(post));
        else assert.equal(choices, undefined);
        assert.equal(page.properties.sourceEvidence.minItems, 1);
        assert.equal(page.properties.sourceEvidence.maxItems, 3);
      }
      const changed = pages.find(page => page.properties.index.enum[0] === 2);
      const text = changed.properties.allowedVisibleText.properties;
      assert.deepEqual(text.headline, { type: 'string', minLength: 1, maxLength: 18 });
      assert.deepEqual(text.subtitle, { type: 'string', minLength: 0, maxLength: 30 });
      assert.deepEqual(text.bullets.items, { type: 'string', minLength: 1, maxLength: 30 });
      assert.equal(text.bullets.minItems, 2);
      assert.equal(text.bullets.maxItems, 2);
    }
    const prompt = withPromptRuntime(runtime, () => buildVisualPlanPrompt(post));
    const data = JSON.parse(prompt.match(/<untrusted_task_data>\s*([\s\S]+?)\s*<\/untrusted_task_data>/u)[1]);
    assert.deepEqual(data.imagePlan, original.imagePlan);
    assert.deepEqual(data.sourceEvidenceOptions, visualEvidenceOptions(original));
    assert.deepEqual(post, original, 'schema compatibility must not rewrite approved copy');
  }
});

test('quoted copy completes planning through a strict fake and retains server-owned evidence', async () => {
  const post = quotedPost();
  const original = structuredClone(post);
  let calls = 0;
  const result = await withPromptRuntime(runtime, () => generateVisualPlan({ post, client: {
    async runText({ outputSchema }) {
      calls += 1;
      assertSupportedLiterals(outputSchema);
      const candidate = createMockVisualPlan(post);
      candidate.pages[0].sourceEvidence = ['模型伪造的证据'];
      return { rawText: JSON.stringify(candidate), model: 'fake' };
    },
  } }));
  assert.equal(calls, 1);
  assert.equal(result.degraded, false);
  assertLockedImageText(result.visualPlan, post);
  assert.deepEqual(result.visualPlan.pages[0].sourceEvidence, [`${post.imagePlan[0].headline}。`]);
  assert.equal(result.visualPlan.pages[0].sourceEvidenceSanitization.reason, 'UNTRUSTED_SOURCE_EVIDENCE_REBUILT');
  assert.deepEqual(post, original);
});

test('relaxing escaped literals still rejects model changes to locked quotes', async () => {
  const post = quotedPost();
  let calls = 0;
  await assert.rejects(withPromptRuntime(runtime, () => generateVisualPlan({ post, client: {
    async runText({ outputSchema }) {
      calls += 1;
      assertSupportedLiterals(outputSchema);
      const candidate = createMockVisualPlan(post);
      candidate.pages[0].allowedVisibleText.bullets[0] = '点右上角···';
      return { rawText: JSON.stringify(candidate), model: 'fake' };
    },
  } })), { code: 'VISUAL_PLAN_CONTRACT_INVALID' });
  assert.equal(calls, 3);
});
