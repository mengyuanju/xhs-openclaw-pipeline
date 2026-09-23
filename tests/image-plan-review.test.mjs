import assert from 'node:assert/strict';
import test from 'node:test';
import { compareCopyReviewImagePlans, normalizeCopyReviewImagePlan } from '../src/image-plan-review.mjs';

function plan() {
  return [
    { kind: 'hero', headline: '封面标题', subtitle: '封面副标题', bullets: ['第一点', '第二点'], prompt: '清晰展示主要内容的封面场景描述' },
    { kind: 'steps', headline: '操作步骤', subtitle: '逐项查看', bullets: ['准备材料', '开始操作', '检查结果'], prompt: '完整展示每个操作步骤的具体场景' },
    { kind: 'summary', headline: '最后总结', subtitle: '', bullets: ['回顾要点', '立即行动'], prompt: '完整展示总结内容的具体场景描述' },
  ];
}

test('equivalent key order, surrounding spaces and line endings do not count as a plan edit', () => {
  const saved = plan();
  const draft = structuredClone(saved);
  draft[1] = {
    prompt: `  ${saved[1].prompt}  `,
    bullets: ['准备材料', '开始操作', '检查结果'],
    subtitle: '逐项查看',
    headline: ` ${saved[1].headline} `,
    kind: 'steps',
  };
  draft[2].prompt = `\r\n${saved[2].prompt}\r\n`;
  assert.deepEqual(compareCopyReviewImagePlans(saved, draft), {
    changed: false,
    rawChanged: true,
    differences: [],
    validationError: null,
  });
  assert.deepEqual(normalizeCopyReviewImagePlan(saved), normalizeCopyReviewImagePlan(draft));
});

test('a real difference identifies the third bullet on the second page', () => {
  const saved = plan();
  const draft = structuredClone(saved);
  draft[1].bullets[2] = '复查结果';
  assert.deepEqual(compareCopyReviewImagePlans(saved, draft), {
    changed: true,
    rawChanged: true,
    differences: [{ pageIndex: 1, field: 'bullets', bulletIndex: 2 }],
    validationError: null,
  });
});

test('an added page reports its page number', () => {
  const saved = plan();
  const draft = structuredClone(saved);
  draft.push({
    kind: 'detail', headline: '补充说明', subtitle: '', bullets: ['补充信息', '注意细节'],
    prompt: '具体呈现补充说明和相关细节的场景',
  });
  assert.deepEqual(compareCopyReviewImagePlans(saved, draft).differences, [{ pageIndex: 3, field: 'pages' }]);
});

test('layout comparison uses normalized defaults and points to a changed layout field', () => {
  const saved = plan();
  saved[1].layout = { mode: 'CUSTOM', imageShare: 60 };
  const equivalent = structuredClone(saved);
  equivalent[1].layout = {
    spacing: 'normal', imageShare: 60, alignment: 'left', textPosition: 'bottom',
    subjectPosition: 'center', titlePosition: 'top-center', direction: '  ', mode: 'CUSTOM',
  };
  assert.equal(compareCopyReviewImagePlans(saved, equivalent).changed, false);

  equivalent[1].layout.imageShare = 70;
  assert.deepEqual(compareCopyReviewImagePlans(saved, equivalent).differences, [
    { pageIndex: 1, field: 'layout', layoutField: 'imageShare' },
  ]);
});

test('invalid draft returns its page and bullet location without throwing', () => {
  const saved = plan();
  const draft = structuredClone(saved);
  draft[1].bullets[2] = '  ';
  const result = compareCopyReviewImagePlans(saved, draft);
  assert.equal(result.changed, true);
  assert.equal(result.rawChanged, true);
  assert.deepEqual(result.differences, []);
  assert.match(result.validationError.message, /第 2 页画面要点第 3 行为空/u);
  assert.deepEqual({ pageIndex: result.validationError.pageIndex, field: result.validationError.field, bulletIndex: result.validationError.bulletIndex }, {
    pageIndex: 1, field: 'bullets', bulletIndex: 2,
  });
});

test('invalid saved plan is reported instead of crashing comparison', () => {
  const result = compareCopyReviewImagePlans(null, plan());
  assert.equal(result.changed, true);
  assert.equal(result.validationError.field, 'pages');
  assert.match(result.validationError.message, /已保存的图片规划格式异常/u);
});

test('invalid layout identifies its page and setting', () => {
  const saved = plan();
  const draft = structuredClone(saved);
  draft[2].layout = { mode: 'CUSTOM', imageShare: 10 };
  const result = compareCopyReviewImagePlans(saved, draft);
  assert.equal(result.changed, true);
  assert.deepEqual({ pageIndex: result.validationError.pageIndex, field: result.validationError.field, layoutField: result.validationError.layoutField }, {
    pageIndex: 2, field: 'layout', layoutField: 'imageShare',
  });
  assert.match(result.validationError.message, /第 3 页主体占比须为 20–90%/u);
});

test('comparison accepts unchanged legacy long bullets while the strict normalizer rejects them', () => {
  const saved = plan();
  saved[1].bullets[0] = '很'.repeat(50);
  const result = compareCopyReviewImagePlans(saved, structuredClone(saved));
  assert.equal(result.changed, false);
  assert.equal(result.validationError, null);
  assert.throws(() => normalizeCopyReviewImagePlan(saved), /第 2 页画面要点第 1 行超过 30 字/u);
});
