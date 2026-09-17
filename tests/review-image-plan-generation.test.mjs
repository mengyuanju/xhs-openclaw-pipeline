import assert from 'node:assert/strict';
import test from 'node:test';

import {
  generateReviewImagePlan,
  ReviewImagePlanGenerationError,
} from '../src/review-image-plan-generation.mjs';

function validImagePlan() {
  return [
    { kind: 'hero', headline: '改稿后的封面', subtitle: '重新规划重点', bullets: ['重点一', '重点二'], prompt: '根据当前改稿制作封面画面，突出核心结论。' },
    { kind: 'steps', headline: '执行步骤', subtitle: '', bullets: ['先准备', '再执行'], prompt: '展示与当前改稿一致的两步执行过程。' },
    { kind: 'summary', headline: '最后核对', subtitle: '', bullets: ['核对事实', '核对顺序'], prompt: '总结当前改稿中的事实和先后顺序。' },
  ];
}

test('review image-plan generation retries invalid model output and returns only a validated plan', async () => {
  const prompts = [];
  const schemas = [];
  const plan = validImagePlan();
  const client = {
    async runText({ prompt, outputSchema }) {
      prompts.push(prompt);
      schemas.push(outputSchema);
      if (prompts.length === 1) {
        return { rawText: JSON.stringify({ imagePlan: [{ kind: 'hero' }] }), model: 'fake-planner' };
      }
      return { rawText: JSON.stringify({ imagePlan: plan }), model: 'fake-planner' };
    },
  };

  const result = await generateReviewImagePlan({
    client,
    copy: { title: '人工改稿标题', body: '人工改稿正文', tags: ['#改稿', '#规划', '#测试'] },
  });

  assert.deepEqual(result.imagePlan, plan);
  assert.equal(result.model, 'fake-planner');
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /界面中的当前文案/u);
  assert.match(prompts[1], /上一次图片文案规划输出未通过结构校验/u);
  assert.equal(schemas[0].properties.imagePlan.minItems, 3);
  assert.equal(schemas[0].properties.imagePlan.maxItems, 5);
});

test('review image-plan generation fails instead of presenting the previous plan as generated', async () => {
  let calls = 0;
  await assert.rejects(
    generateReviewImagePlan({
      client: {
        async runText() {
          calls += 1;
          return { rawText: '{"imagePlan":[]}', model: 'fake-planner' };
        },
      },
      copy: { title: '人工改稿标题', body: '人工改稿正文', tags: ['#改稿', '#规划', '#测试'] },
    }),
    error => error instanceof ReviewImagePlanGenerationError
      && error.code === 'IMAGE_PLAN_GENERATION_FAILED',
  );
  assert.equal(calls, 2);
});
