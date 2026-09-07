import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertImagePlanNumericEvidence, createDirectVisualPlan } from '../src/locked-image-plan.mjs';
import { parseVisualPlanOutput } from '../src/visual-plan.mjs';

// Offline reconstructions from the triage report, not complete remote task payloads.
function sparkPlugPost() {
  return {
    title: '驾驰火花塞 各型号 优缺点及真实评价',
    body: '选择火花塞时，先核对热值、螺纹尺寸、伸出长度、间隙、电阻，再确认是否适配车型。',
    imagePlan: [
      { kind: 'hero', headline: '火花塞怎么选', subtitle: '先看适配', bullets: ['核对车型'], prompt: '火花塞实物。' },
      { kind: 'comparison', headline: '对比型号', subtitle: '结合使用条件', bullets: ['关注适配信息'], prompt: '型号对照。' },
      { kind: 'steps', headline: '下单前先确认', subtitle: '查阅车型手册', bullets: ['核对参数'], prompt: '参数核对。' },
      {
        kind: 'checklist',
        headline: '下单前核对5项',
        subtitle: '按车型确认参数',
        bullets: ['热值', '螺纹尺寸', '伸出长度', '间隙', '电阻'],
        prompt: '参数核对清单。',
      },
    ],
  };
}

describe('remote numeric-evidence regressions', () => {
  it('#434 permits a headline count derived from the five visible checklist entries', () => {
    const post = sparkPlugPost();

    assert.doesNotThrow(() => assertImagePlanNumericEvidence(post));
  });

  it('permits the same structural checklist count in a subtitle', () => {
    const post = sparkPlugPost();
    post.imagePlan[3].headline = '下单前先核对';
    post.imagePlan[3].subtitle = '核对5项';

    assert.doesNotThrow(() => assertImagePlanNumericEvidence(post));
  });

  it('#467 rejects eight years of engineering experience absent from the finalized text', () => {
    const post = sparkPlugPost();
    post.title = '北京轨道交通运输管理有限公司招聘条件';
    post.body = '维修岗位按层级核查经验，具体条件应以招聘公告为准。';
    post.imagePlan[3] = {
      kind: 'checklist', headline: '核对岗位要求', subtitle: '以招聘公告为准',
      bullets: ['工程师：至少8年经验', '维修岗位按层级核查经验'], prompt: '岗位条件清单。',
    };

    assert.throws(() => assertImagePlanNumericEvidence(post), /第 4 页.*未支持的数字 8/u);
  });

  it('still rejects eight years in a subtitle when the headline has a valid checklist count', () => {
    const post = sparkPlugPost();
    post.imagePlan[3].subtitle = '工程师：至少8年经验';

    assert.throws(() => assertImagePlanNumericEvidence(post), /第 4 页.*未支持的数字 8/u);
  });

  it('does not let a checklist count authorize the same number as an experience claim in the headline', () => {
    const post = sparkPlugPost();
    post.imagePlan[3].headline = '下单前核对5项，要求5年经验';

    assert.throws(() => assertImagePlanNumericEvidence(post), /第 4 页.*未支持的数字 5/u);
  });

  it('does not let a checklist count authorize the same number as an experience claim in the subtitle', () => {
    const post = sparkPlugPost();
    post.imagePlan[3].subtitle = '工程师：至少5年经验';

    assert.throws(() => assertImagePlanNumericEvidence(post), /第 4 页.*未支持的数字 5/u);
  });

  it('does not let a checklist count authorize an unsupported factual number in a bullet', () => {
    const post = sparkPlugPost();
    post.imagePlan[3].bullets[0] = '工程师：至少5年经验';

    assert.throws(() => assertImagePlanNumericEvidence(post), /第 4 页.*未支持的数字 5/u);
  });

  it('does not let one page count authorize an unsupported factual number on another page', () => {
    const post = sparkPlugPost();
    post.imagePlan[2].subtitle = '工程师：至少5年经验';

    assert.throws(() => assertImagePlanNumericEvidence(post), /第 3 页.*未支持的数字 5/u);
  });

  it('rejects a count larger than the actual checklist', () => {
    const post = sparkPlugPost();
    post.imagePlan[3].headline = '下单前核对6项';

    assert.throws(() => assertImagePlanNumericEvidence(post), /第 4 页.*未支持的数字 6/u);
  });

  it('rejects a count smaller than the actual checklist', () => {
    const post = sparkPlugPost();
    post.imagePlan[3].headline = '下单前核对4项';

    assert.throws(() => assertImagePlanNumericEvidence(post), /第 4 页.*未支持的数字 4/u);
  });

  it('does not treat 8 years as supported by an unrelated 18 in the body', () => {
    const post = sparkPlugPost();
    post.body += '年龄要求为18周岁。';
    post.imagePlan[0].subtitle = '至少8年经验';
    assert.throws(() => assertImagePlanNumericEvidence(post), /未支持的数字 8/u);
  });

  it('does not exempt a factual claim of five patents merely because there are five bullets', () => {
    const post = sparkPlugPost();
    post.imagePlan[3].headline = '拥有5项专利';
    assert.throws(() => assertImagePlanNumericEvidence(post), /未支持的数字 5/u);
  });

  it('accepts the verified checklist count through the final visual-plan validator too', () => {
    const post = sparkPlugPost();
    for (const page of post.imagePlan.slice(0, 3)) page.bullets.push('查阅车型手册');
    assert.doesNotThrow(() => parseVisualPlanOutput(JSON.stringify(createDirectVisualPlan(post)), { post }));
    post.imagePlan[3].subtitle = '工程师：至少8年经验';
    assert.throws(() => parseVisualPlanOutput(JSON.stringify(createDirectVisualPlan(post)), { post }), /numeric claim 8/u);
  });
});
