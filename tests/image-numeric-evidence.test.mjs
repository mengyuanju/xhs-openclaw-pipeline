import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertImagePlanNumericEvidence } from '../src/locked-image-plan.mjs';

function postWithNumber(body, text, field = 'headline') {
  const post = { title: '整理指南', body, imagePlan: Array.from({ length: 3 }, () => ({
    kind: 'CHECKLIST', headline: '整理桌面', subtitle: '按需安排', bullets: ['清空桌面', '归位物品'],
  })) };
  if (field === 'bullet') post.imagePlan[2].bullets[1] = text;
  else post.imagePlan[2][field] = text;
  return post;
}

describe('image numeric evidence', () => {
  it('accepts equivalent Chinese and full-width evidence without changing copy', () => {
    for (const [body, text] of [
      ['留出五分钟', '留出5分钟'], ['留出十五分钟', '留出15分钟'],
      ['留出两分钟', '留出2分钟'], ['共一百零五件', '共105件'],
      ['二〇二三年发布', '2023年发布'], ['留出５分钟', '留出5分钟'],
      ['留出5分钟', '留出５分钟'], ['留出五点五分钟', '留出5.5分钟'],
      ['比例为百分之五', '比例为5%'], ['比例为５％', '比例为5%'],
      ['共五万件', '共50000件'], ['共一万零五件', '共10005件'], ['共五万件', '共5万件'],
    ]) {
      const post = postWithNumber(body, text);
      const original = structuredClone(post);
      assert.doesNotThrow(() => assertImagePlanNumericEvidence(post), `${body} / ${text}`);
      assert.deepEqual(post, original);
    }
  });

  it('also accepts numeric evidence in the title', () => {
    const post = postWithNumber('归位物品', '留出5分钟');
    post.title = '五分钟整理指南';
    assert.doesNotThrow(() => assertImagePlanNumericEvidence(post));
  });

  it('ignores only explicit list markers at the start of bullet lines', () => {
    for (const text of ['5. 归位物品', '5、归位物品', '5) 归位物品', '（５）归位物品', '清空桌面\n5. 归位物品']) {
      assert.doesNotThrow(() => assertImagePlanNumericEvidence(postWithNumber('归位物品', text, 'bullet')), text);
    }
  });

  it('still checks quantities after a list marker and decimals at the start of a bullet', () => {
    for (const text of ['5. 留出8分钟', '5.5分钟后归位', '5分钟后归位']) {
      assert.throws(() => assertImagePlanNumericEvidence(postWithNumber('归位物品', text, 'bullet')), /未支持的数字/u, text);
    }
    assert.throws(() => assertImagePlanNumericEvidence(postWithNumber('归位物品', '5个整理步骤')), /未支持的数字 5/u);
  });

  it('requires whole numeric values and keeps percentages distinct', () => {
    for (const [body, text] of [
      ['共50件', '共5件'], ['共15件', '共5件'], ['共十五件', '共5件'],
      ['共一百五十件', '共5件'], ['留出5.5分钟', '留出5分钟'],
      ['共五万件', '共5件'], ['共5万件', '共5件'],
      ['共5件', '比例为5%'], ['比例为5%', '共5件'],
      ['比例为百分之五', '共5件'], ['归位物品', '留出５分钟'],
      ['5. 归位物品', '留出5分钟'],
    ]) assert.throws(() => assertImagePlanNumericEvidence(postWithNumber(body, text)), /未支持的数字/u, `${body} / ${text}`);
  });

  it('reports the page, field and exact copy that needs revision', () => {
    assert.throws(() => assertImagePlanNumericEvidence(postWithNumber('归位物品', '留出5分钟', 'bullet')), (error) => {
      assert.match(error.message, /第 3 页/u);
      assert.match(error.message, /未支持的数字 5/u);
      assert.match(error.message, /要点 2.*留出5分钟/u);
      assert.match(error.message, /未调用视觉规划或生图模型/u);
      return true;
    });
  });
});
