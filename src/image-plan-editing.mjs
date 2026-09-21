import { visibleCharacterCount } from './visible-text.mjs';

export const MIN_IMAGE_PLAN_PAGES = 3;
export const IMAGE_PLAN_BULLET_HARD_MAX = 200;

export function recommendedImagePlanBulletMax(kind) {
  return kind === 'checklist' ? 40 : 30;
}

export function imagePlanBulletLengthWarnings(imagePlan) {
  if (!Array.isArray(imagePlan)) throw new TypeError('imagePlan must be an array');
  return imagePlan.flatMap((page, pageIndex) => {
    const recommendedMax = recommendedImagePlanBulletMax(page?.kind);
    return (Array.isArray(page?.bullets) ? page.bullets : []).flatMap((bullet, bulletIndex) => {
      if (typeof bullet !== 'string') return [];
      const length = visibleCharacterCount(bullet.replace(/\r\n?/gu, '\n').trim());
      return length > recommendedMax
        ? [{ pageIndex, bulletIndex, length, recommendedMax }]
        : [];
    });
  });
}

export function imagePlanBlankBulletLines(imagePlan) {
  if (!Array.isArray(imagePlan)) throw new TypeError('imagePlan must be an array');
  return imagePlan.flatMap((page, pageIndex) =>
    (Array.isArray(page?.bullets) ? page.bullets : []).flatMap((bullet, bulletIndex) =>
      typeof bullet === 'string' && bullet.trim() === '' ? [{ pageIndex, bulletIndex }] : [],
    ),
  );
}

export function imagePlanPageDeletionBlockReason(imagePlan, pageIndex) {
  if (!Array.isArray(imagePlan)) throw new TypeError('imagePlan must be an array');
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= imagePlan.length) {
    return '当前规划页不存在';
  }
  if (pageIndex === 0) return '封面页必须保留，不能删除';
  if (imagePlan.length <= MIN_IMAGE_PLAN_PAGES) {
    return `图片文案规划至少保留 ${MIN_IMAGE_PLAN_PAGES} 页`;
  }
  return null;
}

export function removeImagePlanPage(imagePlan, pageIndex) {
  const reason = imagePlanPageDeletionBlockReason(imagePlan, pageIndex);
  if (reason) throw new RangeError(reason);
  return imagePlan.filter((_, index) => index !== pageIndex);
}

export function planIndexAfterDeletion(activeIndex, deletedIndex, nextLength) {
  if (!Number.isInteger(nextLength) || nextLength < 1) throw new RangeError('nextLength must be positive');
  if (activeIndex > deletedIndex) return activeIndex - 1;
  return Math.min(activeIndex, nextLength - 1);
}

export function planDisclosureIndicesAfterDeletion(indices, deletedIndex) {
  if (!Array.isArray(indices)) throw new TypeError('indices must be an array');
  return indices.flatMap(index => index === deletedIndex ? [] : [index > deletedIndex ? index - 1 : index]);
}
