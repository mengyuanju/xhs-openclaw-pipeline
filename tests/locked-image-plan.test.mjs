import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMockPost } from '../src/pipeline.mjs';
import { createMockVisualPlan, parseVisualPlanOutput } from '../src/visual-plan.mjs';
import { generateVisualPlan } from '../src/visual-plan-generation.mjs';
import { createDirectVisualPlan, assertLockedImageText } from '../src/locked-image-plan.mjs';
import { createPromptRuntime, withPromptRuntime } from '../src/prompt-runtime.mjs';
import { visualPlanSchema } from '../src/visual-plan-schema.mjs';

const PUBLISHED_VISUAL_RULE = '管理员视觉规则版本七：使用柔和蓝绿色，只规划画面，不得改写配图文字。';

function visualRuntime(enabled) {
  return createPromptRuntime({
    prompts: {
      VISUAL_PLAN_SYSTEM: { content: PUBLISHED_VISUAL_RULE, versionId: 'visual-test-7', version: 7 },
    },
    settings: { visualPlanningEnabled: enabled },
  });
}

function visibleText(page) {
  return {
    headline: page.headline,
    subtitle: page.subtitle,
    bullets: [...page.bullets],
  };
}

function assertOriginalText(plan, post) {
  assert.equal(plan.pages.length, post.imagePlan.length);
  for (const [index, page] of plan.pages.entries()) {
    assert.equal(page.index, index + 1);
    assert.equal(page.kind, post.imagePlan[index].kind);
    assert.deepEqual(visibleText(page.allowedVisibleText), visibleText(post.imagePlan[index]));
    assert.deepEqual(page.allowedVisibleText.labels, [], 'a layout stage cannot add visible labels');
  }
}

describe('locked image copy and the optional visual planning stage', () => {
  it('accepts grounded Chinese numbers and list markers throughout both planning modes', async () => {
    for (const enabled of [false, true]) {
      const post = createMockPost(3);
      post.body += '\n留出五分钟归位物品。';
      post.imagePlan[2].headline = '留出5分钟归位';
      post.imagePlan[2].bullets[1] = '5. 物品放回原位';
      let calls = 0;
      const result = await withPromptRuntime(visualRuntime(enabled), () => generateVisualPlan({
        post, client: { async runText() {
          calls += 1;
          return { rawText: JSON.stringify(createMockVisualPlan(post)), model: 'fake-number-planner' };
        } },
      }));
      assert.equal(calls, enabled ? 1 : 0);
      assert.equal(result.degraded, false);
      assertOriginalText(result.visualPlan, post);
      assert.doesNotThrow(() => parseVisualPlanOutput(JSON.stringify(result.visualPlan), { post }));
    }
  });

  it('preserves confirmed image-plan quantities without rechecking them in either planning mode', async () => {
    for (const enabled of [false, true]) {
      for (const body of ['留出50分钟', '留出十五分钟', '比例为5%', '5. 归位物品']) {
        const post = createMockPost(3);
        post.body = body;
        post.imagePlan[2].headline = '留出5分钟归位';
        let calls = 0;
        const result = await withPromptRuntime(visualRuntime(enabled), () => generateVisualPlan({
          post, client: { async runText() { calls += 1; return { rawText: JSON.stringify(createMockVisualPlan(post)), model: 'fake-number-planner' }; } },
        }));
        assert.equal(calls, enabled ? 1 : 0);
        assertOriginalText(result.visualPlan, post);
      }
    }
  });

  it('does not relitigate confirmed dates during visual planning', async () => {
    for (const enabled of [false, true]) {
      const post = createMockPost(3);
      post.body += '\n资料仅注明发布于2023年。';
      post.imagePlan[0].headline = '2023年10月30日开始';
      let calls = 0;
      const client = {
        async runText() {
          calls += 1;
          return { rawText: JSON.stringify(createMockVisualPlan(post)), model: 'fake-date-planner' };
        },
      };
      const result = await withPromptRuntime(visualRuntime(enabled), () => generateVisualPlan({ post, client }));
      assert.equal(calls, enabled ? 1 : 0);
      assert.equal(result.attempts, enabled ? 1 : 0);
      assertOriginalText(result.visualPlan, post);
    }
  });

  it('uses API-compatible bullet schemas while program validation still rejects reordered, duplicated or changed text', () => {
    const post = createMockPost(3);
    const schema = withPromptRuntime(visualRuntime(true), () => visualPlanSchema(post));
    function assertNoArrayConst(node) {
      if (!node || typeof node !== 'object') return;
      assert.ok(!Array.isArray(node.const), 'the actual schema API rejects array-valued const');
      for (const value of Object.values(node)) assertNoArrayConst(value);
    }
    assertNoArrayConst(schema);
    for (const [index, pageSchema] of schema.properties.pages.items.anyOf.entries()) {
      const bullets = pageSchema.properties.allowedVisibleText.properties.bullets;
      assert.equal(bullets.type, 'array');
      assert.equal(bullets.minItems, post.imagePlan[index].bullets.length);
      assert.equal(bullets.maxItems, post.imagePlan[index].bullets.length);
      assert.deepEqual(bullets.items.enum, [...new Set(post.imagePlan[index].bullets)]);
    }
    const reordered = createDirectVisualPlan(post);
    reordered.pages[0].allowedVisibleText.bullets.reverse();
    assert.throws(() => assertLockedImageText(reordered, post));
    const duplicated = createDirectVisualPlan(post);
    duplicated.pages[0].allowedVisibleText.bullets[1] = duplicated.pages[0].allowedVisibleText.bullets[0];
    assert.throws(() => assertLockedImageText(duplicated, post));
    const changed = createDirectVisualPlan(post);
    changed.pages[0].allowedVisibleText.bullets[0] = '未经确认的新文字';
    assert.throws(() => assertLockedImageText(changed, post));
  });

  it('uses direct mode when visual planning is explicitly disabled, without a model call or published visual prompt', async () => {
    const post = createMockPost(3);
    let calls = 0;
    const result = await withPromptRuntime(createPromptRuntime({ settings: { visualPlanningEnabled: false } }), () => generateVisualPlan({
      post,
      client: { async runText() { calls += 1; throw new Error('disabled visual planning called a model'); } },
    }));

    assert.equal(calls, 0);
    assert.equal(result.skipped, true);
    assert.equal(result.attempts, 0);
    assert.ok(result.model == null, 'a skipped stage must not claim a generated model result');
    assert.notEqual(result.degraded, true, 'direct mode is an explicit choice, not a failed model fallback');
    assert.equal(result.visualPlan.planningMode, 'DIRECT');
    assertOriginalText(result.visualPlan, post);
    assert.doesNotThrow(() => assertLockedImageText(result.visualPlan, post));
  });

  it('keeps direct planning deterministic and independent of mutable source text arrays', () => {
    const post = createMockPost(3);
    const original = structuredClone(post);
    const first = createDirectVisualPlan(post);
    const second = createDirectVisualPlan(post);

    assert.deepEqual(first, second);
    assert.deepEqual(post, original, 'building a layout must not rewrite the source copy');
    assertOriginalText(first, post);
    assert.equal(first.pages[0].visualSubject, post.imagePlan[0].prompt);
    first.pages[0].allowedVisibleText.bullets[0] = '修改计划副本';
    assert.deepEqual(post, original, 'returned bullets must not alias the source copy');
  });

  it('uses evidence belonging to each page instead of rotating unrelated body sentences', () => {
    const post = createMockPost(3);
    const pageText = [
      {
        headline: '把桌面彻底清空',
        subtitle: '垃圾、空包装直接处理',
        bullets: ['不要边整理边跑去其他房间', '看清真正可用的桌面面积'],
      },
      {
        headline: '按使用频率分三组',
        subtitle: '分组依据是动作',
        bullets: ['每周才用的工具进入抽屉', '低频物品离开桌面'],
      },
      {
        headline: '最后设置一分钟复位',
        subtitle: '把物品放回固定位置',
        bullets: ['睡前丢掉垃圾', '只留下第二天要用的东西'],
      },
    ];
    post.imagePlan = post.imagePlan.map((page, index) => ({ ...page, ...pageText[index] }));
    const plan = createDirectVisualPlan(post);
    const finalizedText = `${post.title}\n${post.body}`;

    assertOriginalText(plan, post);
    for (const [index, page] of plan.pages.entries()) {
      assert.ok(page.sourceEvidence.length > 0, 'direct evidence must remain traceable');
      assert.ok(page.sourceEvidence.every((fragment) => finalizedText.includes(fragment)),
        'each cited fragment must be verbatim source text');
      assert.ok(page.sourceEvidence.some((fragment) => fragment.includes(pageText[index].headline)),
        `page ${index + 1} must cite its own subject instead of an unrelated sentence`);
    }
    assert.notDeepEqual(plan.pages.map((page) => page.sourceEvidence),
      createMockVisualPlan(post).pages.map((page) => page.sourceEvidence),
      'real direct planning must not reuse the mock sentence-rotation evidence');
  });

  it('explicitly reports missing verbatim page evidence instead of inventing a source match', () => {
    const post = createMockPost(3);
    post.imagePlan[0] = {
      ...post.imagePlan[0],
      headline: '预先确认的精简标题',
      subtitle: '预先确认的精简说明',
      bullets: ['精简表达甲', '精简表达乙'],
    };
    const plan = createDirectVisualPlan(post);

    assert.equal(plan.planningMode, 'DIRECT');
    assert.deepEqual(plan.pages[0].sourceEvidence, []);
    assert.equal(plan.pages[0].evidenceStatus, 'POST_REFERENCE_ONLY');
    assertOriginalText(plan, post);
  });

  it('rejects changed words, added labels, missing pages and moved page ownership', async (t) => {
    const post = createMockPost(3);
    const mutations = {
      headline(plan) { plan.pages[0].allowedVisibleText.headline = '模型改写了封面'; },
      subtitle(plan) { plan.pages[1].allowedVisibleText.subtitle = '模型改写了副标题'; },
      bullet(plan) { plan.pages[2].allowedVisibleText.bullets[0] = '模型新增检查项'; },
      extraLabel(plan) { plan.pages[0].allowedVisibleText.labels.push('未经确认的标签'); },
      missingPage(plan) { plan.pages.pop(); },
      swappedPages(plan) { [plan.pages[0], plan.pages[1]] = [plan.pages[1], plan.pages[0]]; },
      movedText(plan) {
        [plan.pages[0].allowedVisibleText, plan.pages[1].allowedVisibleText]
          = [plan.pages[1].allowedVisibleText, plan.pages[0].allowedVisibleText];
      },
    };

    for (const [name, mutate] of Object.entries(mutations)) {
      await t.test(name, () => {
        const plan = createDirectVisualPlan(post);
        assert.doesNotThrow(() => assertLockedImageText(plan, post));
        mutate(plan);
        assert.throws(() => assertLockedImageText(plan, post), `${name} must fail the text lock`);
      });
    }
  });

  it('sends the published visual rules and every original page field when enabled', async () => {
    const post = createMockPost(3);
    const calls = [];
    const result = await withPromptRuntime(visualRuntime(true), () => generateVisualPlan({
      post,
      client: {
        async runText(input) {
          calls.push(input);
          return { rawText: JSON.stringify(createMockVisualPlan(post)), model: 'fake-visual-planner' };
        },
      },
    }));

    assert.equal(calls.length, 1);
    assert.ok(calls[0].prompt.includes(PUBLISHED_VISUAL_RULE));
    for (const page of post.imagePlan) {
      for (const value of [page.headline, page.subtitle, ...page.bullets, page.prompt]) {
        assert.ok(calls[0].prompt.includes(value), `the planner must receive original text: ${value}`);
      }
    }
    assert.notEqual(result.skipped, true);
    assert.equal(result.attempts, 1);
    assert.equal(result.model, 'fake-visual-planner');
    assertOriginalText(result.visualPlan, post);
  });

  it('rejects repeated model rewrites instead of returning a mock or degraded visual plan', async () => {
    const post = createMockPost(3);
    let calls = 0;
    const candidate = createMockVisualPlan(post);
    candidate.pages[0].allowedVisibleText.headline = '模型改写了封面';
    candidate.pages[0].mustShow = ['画面：原有桌面场景'];

    await assert.rejects(withPromptRuntime(visualRuntime(true), () => generateVisualPlan({
      post,
      client: {
        async runText() {
          calls += 1;
          return { rawText: JSON.stringify(candidate), model: 'fake-rewriting-planner' };
        },
      },
    })));
    assert.ok(calls >= 1 && calls <= 3, 'only bounded repair attempts are allowed');
  });
});
