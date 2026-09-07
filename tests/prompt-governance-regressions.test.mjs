import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildTextReviewPrompt,
  runTextReview,
} from '../src/content-stage-review.mjs';
import {
  appendQualityRepairPrompt,
  createQualityRepairPlan,
} from '../src/quality-repair.mjs';

const EDITORIAL_INSTRUCTION = '正文必须以第一人称为主要叙述视角，不得虚构亲测经历。';
const POST = {
  title: '桌面整理的三个步骤',
  body: '先分区，再清理无用物品，最后按使用频率归位。',
  tags: ['#整理'],
  imagePlan: [],
};

function textOnlyImageRepairPlan() {
  return createQualityRepairPlan({
    qc: {
      overallScore: 1,
      issues: [],
      rubric: {
        lowestObstacleDimensions: ['imageTextQuality'],
        dimensions: {
          imageTextQuality: {
            score: 1,
            evidence: ['第3页只有一个错字，主体、场景、并列比较布局及其他文字均正确。'],
            applicable: true,
          },
        },
        issueLabels: [],
      },
    },
    round: 1,
    imageCount: 3,
  });
}

describe('published business rules remain authoritative throughout review and repair', () => {
  it('does not append a fixed first-person exemption to an explicit editorial requirement', () => {
    const prompt = buildTextReviewPrompt({
      query: '桌面整理方法',
      post: POST,
      editorialInstruction: EDITORIAL_INSTRUCTION,
    });

    assert.ok(prompt.includes(EDITORIAL_INSTRUCTION), 'the reviewer must receive the published requirement');
    assert.doesNotMatch(prompt, /第一人称不是正文必须采用的主要叙述视角/u);
    assert.doesNotMatch(prompt, /客观说明或祈使式建议也不得成为阻断理由/u);
    assert.doesNotMatch(prompt, /这类人称与文风意见最多标记\s*WARNING/u);
  });

  it('preserves a valid blocking reviewer finding about the published first-person requirement', async () => {
    const modelReview = {
      schemaVersion: 1,
      decision: 'REJECT',
      summary: '正文未采用已发布编辑要求中必须使用的第一人称叙述视角。',
      issues: [{
        code: 'FIRST_PERSON_PERSPECTIVE',
        severity: 'BLOCKING',
        message: '编辑要求明确规定第一人称为主要叙述视角，但正文完全使用客观说明和祈使式建议。',
      }],
    };
    const calls = [];
    const review = await runTextReview({
      client: {
        async runReview(input) {
          calls.push(input);
          return { rawText: JSON.stringify(modelReview), model: 'fake-reviewer' };
        },
      },
      task: { query: '桌面整理方法', input: {} },
      post: POST,
      editorialInstruction: EDITORIAL_INSTRUCTION,
      now: () => '2026-09-07T08:00:00.000Z',
    });

    assert.equal(calls.length, 1, 'a valid rejection is a review outcome, not a malformed response');
    assert.ok(calls[0].prompt.includes(EDITORIAL_INSTRUCTION));
    assert.equal(review.decision, modelReview.decision);
    assert.deepEqual(review.issues, modelReview.issues);
    assert.equal(review.summary, modelReview.summary);
  });

  it('does not turn a third-page typo repair into a page-number-driven action scene reconstruction', () => {
    const basePrompt = '第三页是并列比较页。保留现有构图、场景、主体位置和正确文字，只修复指出的错字。';
    const prompt = appendQualityRepairPrompt(basePrompt, textOnlyImageRepairPlan(), { pageIndex: 3 });

    assert.ok(prompt.includes(basePrompt), 'the existing page instructions must remain intact');
    assert.match(prompt, /第3页只有一个错字/u);
    assert.doesNotMatch(prompt, /行动清单：改用真实操作或检查场景/u);
    assert.doesNotMatch(prompt, /不得只做局部改色、换字或延续原图/u);
    assert.doesNotMatch(prompt, /必须按本页差异化重构任务替换完整场景和信息组织/u);
  });

  it('rejects an oversized human prompt with RangeError instead of silently truncating its rules', () => {
    const basePrompt = `人工规则开始\n${'每条人工规则必须完整保留。\n'.repeat(100_000)}人工规则结束：保留原有并列比较布局。`;

    assert.throws(
      () => appendQualityRepairPrompt(basePrompt, textOnlyImageRepairPlan(), { pageIndex: 3 }),
      RangeError,
      'the caller must see an explicit size error before a partial human prompt can reach a model',
    );
  });
});
