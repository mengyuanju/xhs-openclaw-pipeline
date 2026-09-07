import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_PRODUCTION_SETTINGS } from '../src/production-settings.mjs';
import {
  appendQualityRepairPrompt,
  createQualityRepairPlan,
  shouldRegenerateContentAfterQualityFailure,
  shouldRegenerateWholeImageSetAfterQualityFailure,
  shouldRefreshResearchAfterQualityFailure,
  shouldRunQualityRepair,
} from '../src/quality-repair.mjs';

function onePointQc() {
  return {
    overallScore: 1,
    issues: [],
    rubric: {
      lowestObstacleDimensions: ['imageAesthetics', 'issue:图片-模板化'],
      dimensions: {
        imageAesthetics: {
          score: 1,
          evidence: ['第2页主体太小，留白和文字卡片挤压了核心画面。'],
          applicable: true,
        },
      },
      issueLabels: [{
        severity: 'major',
        label: '图片-模板化',
        evidence: '三张图片使用了相同构图。',
      }],
    },
  };
}

function repairDataFromPrompt(prompt) {
  const match = prompt.match(/<untrusted_task_data>\s*([\s\S]*?)\s*<\/untrusted_task_data>/u);
  assert.ok(match, 'QC evidence must be carried as data, outside the trusted repair rules');
  return JSON.parse(match[1]);
}

describe('whole-delivery quality repair', () => {
  it('only repairs an initial score of 1 until the target or attempt limit is reached', () => {
    assert.equal(shouldRunQualityRepair({
      initialScore: 1,
      currentScore: 1,
      attempts: 0,
      settings: DEFAULT_PRODUCTION_SETTINGS,
    }), true);
    assert.equal(shouldRunQualityRepair({
      initialScore: 0,
      currentScore: 0,
      attempts: 0,
      settings: DEFAULT_PRODUCTION_SETTINGS,
    }), false);
    assert.equal(shouldRunQualityRepair({
      initialScore: 1,
      currentScore: 2,
      attempts: 1,
      settings: DEFAULT_PRODUCTION_SETTINGS,
    }), false);
    assert.equal(shouldRunQualityRepair({
      initialScore: 1,
      currentScore: 1,
      previousScore: 1,
      attempts: 1,
      settings: DEFAULT_PRODUCTION_SETTINGS,
    }), false);
    assert.equal(shouldRunQualityRepair({
      initialScore: 1,
      currentScore: 1,
      attempts: 2,
      settings: DEFAULT_PRODUCTION_SETTINGS,
    }), false);
  });

  it('turns limiting QC evidence into bounded, readable reasons and repair methods', () => {
    const plan = createQualityRepairPlan({ qc: onePointQc(), round: 1, imageCount: 3 });
    assert.equal(plan.round, 1);
    assert.equal(plan.scoreBefore, 1);
    assert.deepEqual(plan.affectedPages, [1, 2, 3]);
    assert.match(plan.reasons.join('\n'), /第2页主体太小/u);
    assert.match(plan.reasons.join('\n'), /三张图片使用了相同构图/u);
    assert.match(plan.methods.join('\n'), /imageAesthetics/u);

    const prompt = appendQualityRepairPrompt('原始图片提示词', plan, { pageIndex: 2 });
    assert.ok(prompt.startsWith('原始图片提示词\n\n'));
    assert.match(prompt, /<trusted_business_rules kind="IMAGE_REPAIR_SYSTEM">/u);
    assert.deepEqual(repairDataFromPrompt(prompt), {
      pageIndex: 2,
      imageCount: 3,
      round: 1,
      scoreBefore: 1,
      reasons: plan.reasons,
      methods: plan.methods,
    });
  });

  it('passes repetition evidence without assigning page-number-based reconstruction roles', () => {
    const qc = onePointQc();
    qc.rubric.lowestObstacleDimensions = ['imageDiversity'];
    qc.rubric.dimensions.imageDiversity = {
      score: 1,
      evidence: ['四张图片重复使用同一主体、背景和卡片骨架。'],
      applicable: true,
    };
    const plan = createQualityRepairPlan({ qc, round: 2, imageCount: 4 });
    const originalInstructions = [
      '封面保留原先的核心主体和标题。',
      '步骤页保持原文步骤与场景。',
      '第三页是并列对比，不得改成行动清单。',
      '总结页沿用已确认的信息层级。',
    ];
    const prompts = originalInstructions.map((prompt, index) =>
      appendQualityRepairPrompt(prompt, plan, { pageIndex: index + 1 }));

    for (const [index, prompt] of prompts.entries()) {
      assert.ok(prompt.startsWith(originalInstructions[index]));
      assert.equal(repairDataFromPrompt(prompt).pageIndex, index + 1);
      assert.deepEqual(repairDataFromPrompt(prompt).reasons, plan.reasons);
      assert.match(prompt, /四张图片重复使用同一主体、背景和卡片骨架/u);
      assert.doesNotMatch(prompt, /本页差异化重构任务：/u);
      assert.doesNotMatch(prompt, /不得只做局部改色、换字或延续原图的主体角度、背景和卡片骨架/u);
      assert.doesNotMatch(prompt, /必须按本页差异化重构任务替换完整场景和信息组织/u);
    }
  });

  it('preserves complete human rules within the prompt budget and explicitly rejects oversized input', () => {
    const plan = createQualityRepairPlan({ qc: onePointQc(), round: 1, imageCount: 3 });
    const original = `${'完整人工规则。'.repeat(1_500)}最后一条：只修复发现的问题。`;
    const prompt = appendQualityRepairPrompt(original, plan, { pageIndex: 3 });
    assert.ok(prompt.startsWith(`${original}\n\n`), 'human rules must not be shortened to make room for a suffix');
    assert.throws(
      () => appendQualityRepairPrompt('人工规则'.repeat(100_000), plan, { pageIndex: 3 }),
      RangeError,
    );
  });

  it('regenerates text checkpoints for content blockers but preserves them for image-only blockers', () => {
    const contentBlocked = onePointQc();
    contentBlocked.disposition = 'blocked';
    contentBlocked.checks = [{ id: 'image_text_alignment', passed: false }];
    contentBlocked.rubric.dimensions.informationValue = {
      score: 1,
      evidence: ['标题承诺逐日行程，但正文只有抽象天数框架。'],
      applicable: true,
    };
    assert.equal(shouldRegenerateContentAfterQualityFailure(contentBlocked), true);

    const imageBlocked = onePointQc();
    imageBlocked.disposition = 'blocked';
    imageBlocked.checks = [{ id: 'image_text_alignment', passed: true }];
    imageBlocked.rubric.dimensions.queryRelevance = { score: 3, applicable: true };
    imageBlocked.rubric.dimensions.informationValue = { score: 3, applicable: true };
    assert.equal(shouldRegenerateContentAfterQualityFailure(imageBlocked), false);
    assert.equal(shouldRegenerateWholeImageSetAfterQualityFailure(imageBlocked), true);

    const isolatedAlignmentFailure = onePointQc();
    isolatedAlignmentFailure.disposition = 'blocked';
    isolatedAlignmentFailure.checks = [{ id: 'image_text_alignment', passed: false }];
    isolatedAlignmentFailure.rubric.dimensions = Object.fromEntries(
      Object.keys(isolatedAlignmentFailure.rubric.dimensions).map((key) => [key, {
        score: 3,
        evidence: ['整套质量正常，仅单页对齐失败。'],
        applicable: true,
      }]),
    );
    isolatedAlignmentFailure.rubric.issueLabels = [];
    assert.equal(shouldRegenerateWholeImageSetAfterQualityFailure(isolatedAlignmentFailure), false);
  });

  it('refreshes an empty-summary research snapshot after an information-value blocker', () => {
    const contentBlocked = onePointQc();
    contentBlocked.disposition = 'blocked';
    contentBlocked.rubric.dimensions.informationValue = {
      score: 1,
      evidence: ['缺少逐日路线证据。'],
      applicable: true,
    };
    const weakResearch = {
      status: 'COMPLETED',
      summary: null,
      sources: [{ url: 'https://example.com/overview', snippet: '只有总距离概览' }],
    };
    const groundedResearch = {
      ...weakResearch,
      summary: '包含逐日起终点、路线节点和规则证据。',
    };

    assert.equal(shouldRefreshResearchAfterQualityFailure(contentBlocked, weakResearch), true);
    assert.equal(shouldRefreshResearchAfterQualityFailure(contentBlocked, groundedResearch), false);
  });
});
