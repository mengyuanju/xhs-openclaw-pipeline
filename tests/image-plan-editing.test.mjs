import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_IMAGE_PLAN_PAGES,
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
