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
    assert.match(plan.methods.join('\n'), /主体|构图/u);

    const prompt = appendQualityRepairPrompt('原始图片提示词', plan, { pageIndex: 2 });
    assert.match(prompt, /<untrusted_quality_repair>/u);
    assert.match(prompt, /修复轮次：1/u);
    assert.match(prompt, /当前页：2\/3/u);
    assert.match(prompt, /第2页主体太小/u);
    assert.ok(prompt.length <= 8_000);
  });

  it('assigns distinct full-page reconstruction strategies when repairing visual repetition', () => {
    const qc = onePointQc();
    qc.rubric.lowestObstacleDimensions = ['imageDiversity'];
    qc.rubric.dimensions.imageDiversity = {
      score: 1,
      evidence: ['四张图片重复使用同一主体、背景和卡片骨架。'],
      applicable: true,
    };
    const plan = createQualityRepairPlan({ qc, round: 2, imageCount: 4 });
    const prompts = Array.from({ length: 4 }, (_, index) =>
      appendQualityRepairPrompt('原始图片提示词', plan, { pageIndex: index + 1 }));

    assert.ok(prompts.every((prompt) => /本页差异化重构任务/u.test(prompt)));
    assert.equal(new Set(prompts.map((prompt) =>
      prompt.match(/本页差异化重构任务：([^\n]+)/u)?.[1])).size, 4);
    assert.ok(prompts.every((prompt) => /不得只做局部改色、换字或延续原图的主体角度、背景和卡片骨架/u.test(prompt)));
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
