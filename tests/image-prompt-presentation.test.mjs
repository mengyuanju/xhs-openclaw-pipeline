import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { summarizeImagePrompt } from '../app/tasks/[id]/image-prompt-presentation.mjs';

function imagePrompt(plan) {
  return `审核约束说明。\n\n<current_image_plan>\n${JSON.stringify(plan, null, 2)}\n</current_image_plan>\n\n生成最终页面。`;
}

describe('image prompt presentation', () => {
  it('turns the structured image plan into a reviewer-facing Chinese summary', () => {
    const summary = summarizeImagePrompt(imagePrompt({
      position: '2/4',
      kind: 'steps',
      layoutTemplate: 'STEPS_RIGHT',
      sourceEvidence: ['先清空桌面', '再按使用频率分类'],
      visualSubject: '暖色出租屋书桌和三个独立步骤节点',
      layoutDirection: '标题在左上，人物动作在左侧，步骤从右上向下阅读。',
      allowedVisibleText: {
        headline: '三步整理桌面',
        subtitle: '先清空，再分类',
        bullets: ['清空桌面', '按频率分类', '固定位置'],
        labels: ['高频区'],
      },
      mustShow: ['三个步骤节点', '清晰的先后关系'],
      mustAvoid: ['额外数字', '英文标签'],
      originalVisualDirection: '生活化步骤信息图，画面整洁。',
    }));

    assert.equal(summary.available, true);
    assert.equal(summary.page, '第 2 / 4 页');
    assert.equal(summary.kind, '步骤页');
    assert.equal(summary.layout, '右侧纵向步骤');
    assert.equal(summary.visualSubject, '暖色出租屋书桌和三个独立步骤节点');
    assert.deepEqual(summary.visibleText.bullets, ['清空桌面', '按频率分类', '固定位置']);
    assert.deepEqual(summary.mustShow, ['三个步骤节点', '清晰的先后关系']);
    assert.doesNotMatch(JSON.stringify(summary), /current_image_plan|layoutTemplate|allowedVisibleText/u);
  });

  it('does not expose malformed or legacy raw prompt JSON to reviewers', () => {
    const summary = summarizeImagePrompt('历史提示词 {"layoutTemplate":"HERO_LEFT"}');

    assert.equal(summary.available, false);
    assert.match(summary.message, /无法整理为审核摘要/u);
    assert.doesNotMatch(summary.message, /\{|layoutTemplate|HERO_LEFT/u);
  });
});
