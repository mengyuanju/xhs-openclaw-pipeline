import { normalizePageLayout } from '../server/src/image-options.mjs';
import { visibleCharacterCount } from './visible-text.mjs';

const IMAGE_PLAN_KINDS = Object.freeze(['hero', 'steps', 'checklist', 'comparison', 'detail', 'summary']);
const IMAGE_PLAN_FIELDS = Object.freeze(['kind', 'headline', 'subtitle', 'bullets', 'prompt']);

function normalizedImagePlanText(value, location, { min = 1, max }) {
  if (typeof value !== 'string') throw new TypeError(`${location}必须是文本`);
  const text = value.replace(/\r\n?/gu, '\n').trim();
  const length = visibleCharacterCount(text);
  if (length < min) {
    throw new RangeError(length === 0
      ? `${location}为空，请填写内容`
      : `${location}至少需要 ${min} 字（当前 ${length} 字）`);
  }
  if (length > max) throw new RangeError(`${location}超过 ${max} 字（当前 ${length} 字）`);
  return text;
}

function normalizedImagePlanBullets(value, pageNumber, itemMax) {
  const location = `第 ${pageNumber} 页画面要点`;
  if (!Array.isArray(value)) throw new TypeError(`${location}必须是逐行填写的列表`);
  // Check existing lines first so an extra blank line points to the precise row.
  const bullets = value.map((item, index) => normalizedImagePlanText(
    item, `${location}第 ${index + 1} 行`, { max: itemMax },
  ));
  if (bullets.length < 2 || bullets.length > 5) {
    throw new RangeError(`${location}需要 2–5 行（当前 ${bullets.length} 行）`);
  }
  return bullets;
}

const IMAGE_PLAN_LAYOUT_LABELS = Object.freeze({
  mode: '排版方式', template: '排版模板', titlePosition: '标题位置',
  subjectPosition: '主体位置', textPosition: '文字区域', alignment: '文字对齐',
  imageShare: '主体占比', spacing: '留白', direction: '补充布局要求',
});

function normalizedImagePlanLayout(value, kind, pageNumber) {
  try {
    return normalizePageLayout(value, kind);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const field = /layout\.([a-zA-Z]+)/u.exec(error.message)?.[1];
    const location = `第 ${pageNumber} 页${IMAGE_PLAN_LAYOUT_LABELS[field] ?? '页面排版'}`;
    if (field === 'imageShare') throw new TypeError(`${location}须为 20–90%`, { cause: error });
    if (field === 'direction') throw new TypeError(`${location}不能超过 1000 字`, { cause: error });
    throw new TypeError(`${location}无效，请检查设置`, { cause: error });
  }
}

export function normalizeCopyReviewImagePlan(value, { allowBulletOverflow = false } = {}) {
  if (!Array.isArray(value) || value.length < 3 || value.length > 5) {
    throw new RangeError(`图片规划需要 3–5 页（当前 ${Array.isArray(value) ? `${value.length} 页` : '不是页面列表'}）`);
  }
  const imagePlan = value.map((rawItem, index) => {
    const pageNumber = index + 1;
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      throw new TypeError(`第 ${pageNumber} 页图片规划无效，请检查该页内容`);
    }
    const kind = String(rawItem.kind ?? '').trim();
    if (!IMAGE_PLAN_KINDS.includes(kind)) {
      throw new TypeError(`第 ${pageNumber} 页页面类型无效，请重新选择`);
    }
    return {
      kind,
      headline: normalizedImagePlanText(rawItem.headline, `第 ${pageNumber} 页页面标题`, { max: 18 }),
      subtitle: normalizedImagePlanText(rawItem.subtitle, `第 ${pageNumber} 页页面副标题`, { min: 0, max: 30 }),
      bullets: normalizedImagePlanBullets(rawItem.bullets, pageNumber,
        allowBulletOverflow ? 200 : kind === 'checklist' ? 40 : 30),
      prompt: normalizedImagePlanText(rawItem.prompt, `第 ${pageNumber} 页画面生成指令`, {
        min: 10,
        max: 1_000,
      }),
      ...(rawItem.layout === undefined ? {} : { layout: normalizedImagePlanLayout(rawItem.layout, kind, pageNumber) }),
    };
  });
  if (imagePlan[0].kind !== 'hero') throw new TypeError('第 1 页页面类型必须为封面');
  const repeatedCoverIndex = imagePlan.findIndex((item, index) => index > 0 && item.kind === 'hero');
  if (repeatedCoverIndex !== -1) throw new TypeError(`第 ${repeatedCoverIndex + 1} 页页面类型不能为封面，只有第 1 页可以为封面`);
  return imagePlan;
}

/**
 * @typedef {{
 *   pageIndex: number,
 *   field: 'pages' | 'kind' | 'headline' | 'subtitle' | 'bullets' | 'prompt' | 'layout',
 *   bulletIndex?: number,
 *   layoutField?: string,
 * }} ImagePlanDifference
 */

/**
 * @typedef {{
 *   message: string,
 *   pageIndex?: number,
 *   field?: ImagePlanDifference['field'],
 *   bulletIndex?: number,
 *   layoutField?: string,
 * }} ImagePlanValidationError
 */

/**
 * @typedef {{
 *   changed: boolean,
 *   rawChanged: boolean,
 *   differences: ImagePlanDifference[],
 *   validationError: ImagePlanValidationError | null,
 * }} ImagePlanComparison
 */

function rawPlanChanged(saved, draft) {
  try {
    return JSON.stringify(saved) !== JSON.stringify(draft);
  } catch {
    return true;
  }
}

function validationLocation(message) {
  if (message.startsWith('图片规划需要')) return { field: 'pages' };
  const pageNumber = /^第 (\d+) 页/u.exec(message)?.[1];
  if (!pageNumber) return {};
  const pageIndex = Number(pageNumber) - 1;
  if (message.includes('页面类型')) return { pageIndex, field: 'kind' };
  if (message.includes('页面副标题')) return { pageIndex, field: 'subtitle' };
  if (message.includes('页面标题')) return { pageIndex, field: 'headline' };
  if (message.includes('画面要点')) {
    const bulletNumber = /画面要点第 (\d+) 行/u.exec(message)?.[1];
    return { pageIndex, field: 'bullets', ...(bulletNumber ? { bulletIndex: Number(bulletNumber) - 1 } : {}) };
  }
  if (message.includes('画面生成指令')) return { pageIndex, field: 'prompt' };
  for (const [layoutField, label] of Object.entries(IMAGE_PLAN_LAYOUT_LABELS)) {
    if (message.includes(label)) return { pageIndex, field: 'layout', layoutField };
  }
  if (message.includes('页面排版')) return { pageIndex, field: 'layout' };
  if (message.includes('图片规划无效')) return { pageIndex, field: 'pages' };
  return { pageIndex };
}

function validationError(error, source) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    message: source === 'saved' ? `已保存的图片规划格式异常：${message}` : message,
    ...validationLocation(message),
  };
}

/** @returns {ImagePlanDifference[]} */
function planDifferences(saved, draft) {
  /** @type {ImagePlanDifference[]} */
  const differences = [];
  for (let pageIndex = 0; pageIndex < Math.max(saved.length, draft.length); pageIndex += 1) {
    const original = saved[pageIndex];
    const edited = draft[pageIndex];
    if (!original || !edited) {
      differences.push({ pageIndex, field: 'pages' });
      continue;
    }
    for (const field of IMAGE_PLAN_FIELDS) {
      if (field === 'bullets') {
        for (let bulletIndex = 0; bulletIndex < Math.max(original.bullets.length, edited.bullets.length); bulletIndex += 1) {
          if (original.bullets[bulletIndex] !== edited.bullets[bulletIndex]) {
            differences.push({ pageIndex, field: 'bullets', bulletIndex });
          }
        }
      } else if (original[field] !== edited[field]) {
        differences.push({ pageIndex, field });
      }
    }
    const layoutFields = new Set([...Object.keys(original.layout ?? {}), ...Object.keys(edited.layout ?? {})]);
    for (const layoutField of layoutFields) {
      if (original.layout?.[layoutField] !== edited.layout?.[layoutField]) {
        differences.push({ pageIndex, field: 'layout', layoutField });
      }
    }
  }
  return differences;
}

/**
 * Compare the submitted plan using the same normalization as server review.
 * Locations are zero-based and contain no plan content.
 *
 * @param {unknown} saved
 * @param {unknown} draft
 * @param {{allowBulletOverflow?: boolean}} [options]
 * @returns {ImagePlanComparison}
 */
export function compareCopyReviewImagePlans(saved, draft, { allowBulletOverflow = true } = {}) {
  const rawChanged = rawPlanChanged(saved, draft);
  let normalizedDraft;
  try {
    normalizedDraft = normalizeCopyReviewImagePlan(draft, { allowBulletOverflow });
  } catch (error) {
    return { changed: true, rawChanged, differences: [], validationError: validationError(error, 'draft') };
  }
  let normalizedSaved;
  try {
    normalizedSaved = normalizeCopyReviewImagePlan(saved, { allowBulletOverflow: true });
  } catch (error) {
    return { changed: true, rawChanged, differences: [], validationError: validationError(error, 'saved') };
  }
  const changed = JSON.stringify(normalizedSaved) !== JSON.stringify(normalizedDraft);
  return {
    changed,
    rawChanged,
    differences: changed ? planDifferences(normalizedSaved, normalizedDraft) : [],
    validationError: null,
  };
}
