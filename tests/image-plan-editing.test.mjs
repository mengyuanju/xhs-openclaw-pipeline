import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IMAGE_PLAN_BULLET_HARD_MAX,
  MIN_IMAGE_PLAN_PAGES,
  imagePlanBlankBulletLines,
  imagePlanBulletLengthWarnings,
  imagePlanPageDeletionBlockReason,
  planDisclosureIndicesAfterDeletion,
  planIndexAfterDeletion,
  removeImagePlanPage,
} from '../src/image-plan-editing.mjs';

function plans(count) {
  return Array.from({ length: count }, (_, index) => ({
    kind: index === 0 ? 'hero' : 'detail',
    headline: `第 ${index + 1} 页`,
  }));
}

test('image plan page deletion removes a non-cover page without mutating the source', () => {
  const source = plans(5);
  const result = removeImagePlanPage(source, 2);

  assert.equal(MIN_IMAGE_PLAN_PAGES, 3);
  assert.deepEqual(result.map(page => page.headline), ['第 1 页', '第 2 页', '第 4 页', '第 5 页']);
  assert.equal(source.length, 5);
  assert.equal(result[0].kind, 'hero');
});

test('image plan page deletion protects the cover and the three-page minimum', () => {
  assert.equal(imagePlanPageDeletionBlockReason(plans(5), 0), '封面页必须保留，不能删除');
  assert.equal(imagePlanPageDeletionBlockReason(plans(3), 2), '图片文案规划至少保留 3 页');
  assert.throws(() => removeImagePlanPage(plans(5), 0), /封面页必须保留/u);
  assert.throws(() => removeImagePlanPage(plans(3), 2), /至少保留 3 页/u);
});

test('image plan deletion keeps active and expanded page indices aligned', () => {
  assert.equal(planIndexAfterDeletion(3, 1, 4), 2);
  assert.equal(planIndexAfterDeletion(4, 4, 4), 3);
  assert.equal(planIndexAfterDeletion(1, 1, 4), 1);
  assert.deepEqual(planDisclosureIndicesAfterDeletion([0, 1, 3, 4], 1), [0, 2, 3]);
});

test('image plan bullet warnings keep checklist and other page recommendations distinct', () => {
  const imagePlan = [
    { kind: 'hero', bullets: ['封'.repeat(30), '封'.repeat(31)] },
    { kind: 'steps', bullets: ['Windows PowerShell用powershell', '步'.repeat(31)] },
    { kind: 'checklist', bullets: ['清'.repeat(40), '清'.repeat(41)] },
  ];

  assert.equal(IMAGE_PLAN_BULLET_HARD_MAX, 200);
  assert.deepEqual(imagePlanBulletLengthWarnings(imagePlan), [
    { pageIndex: 0, bulletIndex: 1, length: 31, recommendedMax: 30 },
    { pageIndex: 1, bulletIndex: 1, length: 31, recommendedMax: 30 },
    { pageIndex: 2, bulletIndex: 1, length: 41, recommendedMax: 40 },
  ]);
});

test('image plan bullet warnings count user-visible graphemes instead of Unicode code points', () => {
  const heart = '\u2764\uFE0F';
  const imagePlan = [{
    kind: 'detail',
    bullets: [
      `${'字'.repeat(29)}${heart}`,
      `${'字'.repeat(30)}${heart}`,
      `${'字'.repeat(29)}e\u0301`,
    ],
  }];

  assert.deepEqual(imagePlanBulletLengthWarnings(imagePlan), [
    { pageIndex: 0, bulletIndex: 1, length: 31, recommendedMax: 30 },
  ]);
});

test('image plan reports empty and whitespace-only bullet lines with their page positions', () => {
  assert.deepEqual(imagePlanBlankBulletLines([
    { kind: 'hero', bullets: ['有效要点', '', '   '] },
    { kind: 'detail', bullets: ['另一个要点', '\t'] },
  ]), [
    { pageIndex: 0, bulletIndex: 1 },
    { pageIndex: 0, bulletIndex: 2 },
    { pageIndex: 1, bulletIndex: 1 },
  ]);
});
