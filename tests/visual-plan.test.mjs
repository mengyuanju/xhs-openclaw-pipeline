import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildVisualPlanPrompt,
  createMockVisualPlan,
  parseVisualPlanOutput,
} from '../src/visual-plan.mjs';

function postFixture() {
  return {
    title: '租房桌面整理，先别急着买收纳盒',
    body: '桌面反复变乱，问题通常不在收纳盒不够。第一步先清空桌面，再按每天、每周和低频使用分类。最后设置一分钟复位：清理垃圾、物品归位、预留明天用品。',
    imagePlan: [
      {
        kind: 'hero',
        headline: '桌面整理先做减法',
        subtitle: '别急着买收纳盒',
        bullets: ['先清空', '按频率分类'],
        prompt: '真实租房桌面整理场景。',
      },
      {
        kind: 'steps',
        headline: '整理分三步',
        subtitle: '按使用动作安排位置',
        bullets: ['清空桌面', '按频率分类', '设置复位'],
        prompt: '三步纵向流程。',
      },
      {
        kind: 'checklist',
        headline: '一分钟复位',
        subtitle: '睡前检查这三项',
        bullets: ['清理垃圾', '物品归位', '预留明天用品'],
        prompt: '清单卡片布局。',
      },
    ],
  };
}

function validVisualPlan(post = postFixture()) {
  return {
    schemaVersion: 1,
    contentProfile: {
      category: '收纳',
      tones: ['实用', '温和'],
      visualMedium: 'PHOTO_INFOGRAPHIC',
      informationDensity: 'MEDIUM',
    },
    pages: post.imagePlan.map((plan, index) => ({
      index: index + 1,
      kind: plan.kind,
      layoutSchemaVersion: 1,
      layoutTemplate: index === 0 ? 'HERO_LEFT' : index === 1 ? 'STEPS_RIGHT' : 'CHECKLIST_RIGHT',
      sourceEvidence: index === 0
        ? ['桌面反复变乱，问题通常不在收纳盒不够']
        : index === 1
          ? ['第一步先清空桌面，再按每天、每周和低频使用分类']
          : ['最后设置一分钟复位：清理垃圾、物品归位、预留明天用品'],
      visualSubject: index === 0 ? '整理后的真实租房桌面' : '与当前步骤对应的真实整理动作',
      layoutDirection: index === 0 ? '主体居中，标题左上' : '按信息顺序纵向排列',
      allowedVisibleText: {
        language: 'zh-CN',
        headline: plan.headline,
        subtitle: plan.subtitle,
        bullets: plan.bullets,
      },
      mustShow: [plan.headline],
      mustAvoid: ['正文没有的建议', '品牌和水印'],
    })),
  };
}

describe('visual plan contract', () => {
  it('builds a bounded prompt from the finalized title, body and delivery page roles', () => {
    const prompt = buildVisualPlanPrompt(postFixture(), { imageCount: 3 });

    assert.match(prompt, /租房桌面整理，先别急着买收纳盒/);
    assert.match(prompt, /最后设置一分钟复位/);
    assert.match(prompt, /sourceEvidence/);
    assert.match(prompt, /sourceEvidence 必须是包含 1–3 项的 JSON 字符串数组/);
    assert.match(prompt, /中国大陆规范简体中文/);
    assert.match(prompt, /至少 3 种不同的.*layoutTemplate/u);
    assert.match(prompt, /不得连续复用相同的标题位置、主体位置和阅读动线/);
    assert.match(prompt, /封面标题最多 2 行/);
    assert.match(prompt, /layoutDirection.*项目数量.*bullets/u);
    assert.match(prompt, /mustShow.*具体可见文字.*allowedVisibleText/u);
    assert.match(prompt, /不得要求或暗示 AI 生成的具体校貌、门店、人物或产品是可核验实景/u);
    assert.match(prompt, /中性信息图或明确的示意场景/u);
    assert.match(prompt, /严格按照正文行文顺序/u);
    assert.match(prompt, /同一信息焦点.*同一页/u);
    assert.match(prompt, /第一页.*标题.*核心结论/u);
    assert.match(prompt, /不得完全照搬正文长句/u);
    assert.match(prompt, /关键核心信息.*完整覆盖/u);
    assert.match(prompt, /3:4.*1086×1448/u);
    assert.match(prompt, /涉及人像.*右下角.*AI生成/u);
    assert.match(prompt, /layoutSchemaVersion.*1/u);
    assert.match(prompt, /layoutTemplate/u);
    assert.match(prompt, /恰好包含 3 项/);
    assert.ok(prompt.length < 30_000);

    const promptWithoutDisclosure = buildVisualPlanPrompt(postFixture(), {
      imageCount: 3,
      complianceDisclosure: '',
    });
    assert.doesNotMatch(promptWithoutDisclosure, /右下角.*AI生成/u);
    assert.match(promptWithoutDisclosure, /不得添加任何额外合规标识/u);
  });

  it('accepts a traceable visual plan with one page for every delivery image', () => {
    const post = postFixture();
    const plan = parseVisualPlanOutput(JSON.stringify(validVisualPlan(post)), { post, imageCount: 3 });

    assert.equal(plan.schemaVersion, 1);
    assert.equal(plan.pages.length, 3);
    assert.equal(plan.pages[1].kind, 'steps');
    assert.equal(plan.pages[1].layoutTemplate, 'STEPS_RIGHT');
    assert.equal(plan.pages[2].allowedVisibleText.language, 'zh-CN');
  });

  it('allows dense checklist text up to 40 characters while keeping steps at 30', () => {
    const checklistText = '清'.repeat(40);
    const post = postFixture();
    post.body += checklistText;
    post.imagePlan[2].bullets[0] = checklistText;
    const output = validVisualPlan(post);
    assert.equal(
      parseVisualPlanOutput(JSON.stringify(output), { post, imageCount: 3 })
        .pages[2].allowedVisibleText.bullets[0],
      checklistText,
    );

    post.imagePlan[1].bullets[0] = checklistText;
    const invalidSteps = validVisualPlan(post);
    assert.throws(
      () => parseVisualPlanOutput(JSON.stringify(invalidSteps), { post, imageCount: 3 }),
      /pages\[1\].allowedVisibleText.bullets\[0\].*30 characters/i,
    );
  });

  it('allows explicit object labels only when they occur in the finalized text', () => {
    const post = postFixture();
    const output = validVisualPlan(post);
    output.pages[0].allowedVisibleText.labels = ['清空桌面'];

    const plan = parseVisualPlanOutput(JSON.stringify(output), { post, imageCount: 3 });
    assert.deepEqual(plan.pages[0].allowedVisibleText.labels, ['清空桌面']);

    output.pages[0].allowedVisibleText.labels = ['扫码关注'];
    assert.throws(
      () => parseVisualPlanOutput(JSON.stringify(output), { post, imageCount: 3 }),
      /labels\[0\].*finalized text/i,
    );

    post.body += ' Northern Tale';
    const officialName = validVisualPlan(post);
    officialName.pages[0].allowedVisibleText.labels = ['Northern Tale'];
    assert.deepEqual(
      parseVisualPlanOutput(JSON.stringify(officialName), { post, imageCount: 3 })
        .pages[0].allowedVisibleText.labels,
      ['Northern Tale'],
    );

    const duplicated = validVisualPlan(post);
    duplicated.pages[1].allowedVisibleText.labels = ['清空桌面'];
    assert.throws(
      () => parseVisualPlanOutput(JSON.stringify(duplicated), { post, imageCount: 3 }),
      /labels\[0\].*duplicates existing visible text/i,
    );
  });

  it('rejects plans whose evidence cannot be found in the finalized text', () => {
    const post = postFixture();
    const output = validVisualPlan(post);
    output.pages[1].sourceEvidence = ['正文从未说过要购买五个收纳盒'];

    assert.throws(
      () => parseVisualPlanOutput(JSON.stringify(output), { post, imageCount: 3 }),
      /sourceEvidence.*finalized text/i,
    );
  });

  it('rejects missing pages, page-role drift and non-zh-CN visible text declarations', () => {
    const post = postFixture();
    const missing = validVisualPlan(post);
    missing.pages.pop();
    assert.throws(
      () => parseVisualPlanOutput(JSON.stringify(missing), { post, imageCount: 3 }),
      /pages.*3/i,
    );

    const drifted = validVisualPlan(post);
    drifted.pages[1].kind = 'comparison';
    assert.throws(
      () => parseVisualPlanOutput(JSON.stringify(drifted), { post, imageCount: 3 }),
      /kind.*steps/i,
    );

    const wrongLanguage = validVisualPlan(post);
    wrongLanguage.pages[0].allowedVisibleText.language = 'zh-TW';
    assert.throws(
      () => parseVisualPlanOutput(JSON.stringify(wrongLanguage), { post, imageCount: 3 }),
      /language.*zh-CN/i,
    );
  });

  it('rejects visible numeric claims that do not occur in the finalized text', () => {
    const post = postFixture();
    const output = validVisualPlan(post);
    output.pages[0].allowedVisibleText.subtitle = '坚持 30 天就能稳定整洁';

    assert.throws(
      () => parseVisualPlanOutput(JSON.stringify(output), { post, imageCount: 3 }),
      /numeric claim.*30/i,
    );
  });

  it('rejects a layout item count that conflicts with the visible bullet count', () => {
    const post = postFixture();
    const output = validVisualPlan(post);
    output.pages[2].layoutDirection = '标题顶部居中，中上部为两列三行的六项勾选卡。';

    assert.throws(
      () => parseVisualPlanOutput(JSON.stringify(output), { post, imageCount: 3 }),
      /layoutDirection.*6.*bullets.*3/iu,
    );
  });

  it('rejects a must-show text instruction absent from the visible-text allowlist', () => {
    const post = postFixture();
    const output = validVisualPlan(post);
    output.pages[2].mustShow = ['不得申请转入其他招生类型专业的限制提示'];

    assert.throws(
      () => parseVisualPlanOutput(JSON.stringify(output), { post, imageCount: 3 }),
      /mustShow.*allowedVisibleText/iu,
    );
  });

  it('rejects missing, unknown, and kind-incompatible structured layout templates', () => {
    const post = postFixture();
    const missing = validVisualPlan(post);
    delete missing.pages[0].layoutTemplate;
    assert.throws(
      () => parseVisualPlanOutput(JSON.stringify(missing), { post, imageCount: 3 }),
      /layoutTemplate/iu,
    );

    const unknown = validVisualPlan(post);
    unknown.pages[0].layoutTemplate = 'FREEFORM_MAGIC';
    assert.throws(
      () => parseVisualPlanOutput(JSON.stringify(unknown), { post, imageCount: 3 }),
      /layoutTemplate/iu,
    );

    const incompatible = validVisualPlan(post);
    incompatible.pages[0].layoutTemplate = 'CHECKLIST_RIGHT';
    assert.throws(
      () => parseVisualPlanOutput(JSON.stringify(incompatible), { post, imageCount: 3 }),
      /layoutTemplate.*hero/iu,
    );
  });

  it('creates a deterministic mock plan without a model call', () => {
    const post = postFixture();
    const plan = createMockVisualPlan(post, { imageCount: 3 });

    assert.deepEqual(plan.pages.map(({ kind }) => kind), ['hero', 'steps', 'checklist']);
    assert.ok(plan.pages.every((page) => page.allowedVisibleText.language === 'zh-CN'));
  });
});
