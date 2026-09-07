import { businessPrompt, promptRuntimeSnapshot } from './prompt-runtime.mjs';
import { visualEvidenceOptions } from './visual-plan-schema.mjs';
import { imageControlsPrompt, requestedLayoutTemplate } from './image-layout-controls.mjs';
import {
  defaultLayoutTemplate,
  layoutTemplatePromptRules,
  validateLayoutTemplate,
} from './layout-contract.mjs';

const VISUAL_MEDIA = new Set(['PHOTO', 'ILLUSTRATION', 'INFOGRAPHIC', 'PHOTO_INFOGRAPHIC']);
const INFORMATION_DENSITIES = new Set(['LOW', 'MEDIUM', 'HIGH']);
const CHINESE_COUNTS = new Map([
  ['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5],
  ['六', 6], ['七', 7], ['八', 8], ['九', 9], ['十', 10],
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value, name, { min = 1, max } = {}) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  const text = value.trim();
  const length = [...text].length;
  if (length < min) throw new RangeError(`${name} cannot be empty`);
  if (max && length > max) throw new RangeError(`${name} cannot exceed ${max} characters`);
  return text;
}

function textList(value, name, { min = 0, max = 10, itemMax = 200 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new TypeError(`${name} must contain between ${min} and ${max} items`);
  }
  return value.map((item, index) => requiredText(item, `${name}[${index}]`, { max: itemMax }));
}

function enumValue(value, name, allowed) {
  const text = requiredText(value, name, { max: 100 });
  if (!allowed.has(text)) throw new TypeError(`${name} is invalid`);
  return text;
}

function parseFirstObject(raw) {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 50_000) {
    throw new TypeError('visual plan output must be non-empty text no longer than 50000 characters');
  }
  const text = raw.trim();
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)```/iu);
  if (fenced) candidates.push(fenced[1].trim());
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Continue to the next bounded candidate.
    }
  }
  throw new SyntaxError('visual plan output does not contain a valid JSON object');
}

function validatePost(post, imageCount) {
  if (!isRecord(post)) throw new TypeError('finalized post is required');
  const title = requiredText(post.title, 'post.title', { max: 100 });
  const body = requiredText(post.body, 'post.body', { max: 10_000 });
  if (!Number.isInteger(imageCount) || imageCount < 3 || imageCount > 5) {
    throw new RangeError('imageCount must be an integer between 3 and 5');
  }
  if (!Array.isArray(post.imagePlan) || post.imagePlan.length !== imageCount) {
    throw new RangeError(`post.imagePlan must contain exactly ${imageCount} items`);
  }
  return { title, body, imagePlan: post.imagePlan };
}

function numericClaims(values) {
  return [...new Set(values.flatMap((value) => String(value).match(/\d+(?:\.\d+)?%?/gu) ?? []))];
}

function explicitLayoutItemCount(layoutDirection) {
  const match = layoutDirection.match(
    /([一二三四五六七八九十\d]+)(?:项|张|个|格)(?:[^。；]{0,6})(?:卡片|卡|节点|要点|检查|提示)/u,
  );
  if (!match) return null;
  if (/^\d+$/u.test(match[1])) return Number(match[1]);
  return CHINESE_COUNTS.get(match[1]) ?? null;
}

function validateVisibleText(value, name, finalizedText, bulletMax = 30) {
  if (!isRecord(value)) throw new TypeError(`${name} must be an object`);
  if (value.language !== 'zh-CN') throw new TypeError(`${name}.language must be zh-CN`);
  const visible = {
    language: 'zh-CN',
    headline: requiredText(value.headline, `${name}.headline`, { max: 18 }),
    subtitle: requiredText(value.subtitle, `${name}.subtitle`, { max: 30 }),
    bullets: textList(value.bullets, `${name}.bullets`, { min: 2, max: 5, itemMax: bulletMax }),
    labels: textList(value.labels ?? [], `${name}.labels`, { max: 3, itemMax: 20 }),
  };
  for (const [index, label] of visible.labels.entries()) {
    if (!finalizedText.includes(label)) {
      throw new TypeError(`${name}.labels[${index}] must occur in the finalized text`);
    }
    const normalizedLabel = String(label).normalize('NFKC').replace(/\s+/gu, '');
    const duplicatesVisibleText = [visible.headline, visible.subtitle, ...visible.bullets]
      .some((text) => String(text).normalize('NFKC').replace(/\s+/gu, '').includes(normalizedLabel));
    if (duplicatesVisibleText) {
      throw new TypeError(`${name}.labels[${index}] duplicates existing visible text`);
    }
  }
  for (const claim of numericClaims([visible.headline, visible.subtitle, ...visible.bullets])) {
    if (!finalizedText.includes(claim)) {
      throw new TypeError(`${name} contains numeric claim ${claim} that is absent from the finalized text`);
    }
  }
  return visible;
}

function validateContentProfile(value) {
  if (!isRecord(value)) throw new TypeError('contentProfile must be an object');
  return {
    category: requiredText(value.category, 'contentProfile.category', { max: 100 }),
    tones: textList(value.tones, 'contentProfile.tones', { min: 1, max: 5, itemMax: 30 }),
    visualMedium: enumValue(value.visualMedium, 'contentProfile.visualMedium', VISUAL_MEDIA),
    informationDensity: enumValue(
      value.informationDensity,
      'contentProfile.informationDensity',
      INFORMATION_DENSITIES,
    ),
  };
}

function requiredVisibleMustShowText(item) {
  if (item.startsWith('画面：')) return null;
  if (item.startsWith('文字：')) return item.slice(3).trim();
  const match = item.match(/^(.{2,60}?)(?:的)?(?:限制)?(?:提示|说明|标签|文字)$/u);
  return match?.[1]?.trim() || null;
}

export function buildVisualPlanPrompt(post, {
  imageCount = post?.imagePlan?.length,
  complianceDisclosure = 'AI生成',
} = {}) {
  const finalized = validatePost(post, imageCount);
  const layoutRules = layoutTemplatePromptRules();
  return businessPrompt('VISUAL_PLAN_SYSTEM', {
    contract: `只返回 schemaVersion=1 的 JSON，contentProfile 和 pages 遵循提供的输出 schema。每页 index/kind 必须与原 imagePlan 一致，保留原 headline/subtitle/bullets，labels=[]。可选版式：${layoutRules}。sourceEvidence 必须为标题或正文中的逐字片段。mustShow 用“画面：”或“文字：”前缀，文字仅可引用已锁定字段。输出 ${imageCount} 页；最终图为1086×1448。合规标识：${complianceDisclosure || '关闭'}。`,
    data: { title: finalized.title, body: finalized.body, imagePlan: finalized.imagePlan,
      ...(promptRuntimeSnapshot() ? { sourceEvidenceOptions: visualEvidenceOptions(finalized) } : {}) },
  }) + imageControlsPrompt(post);
}

export function parseVisualPlanOutput(raw, { post, imageCount = post?.imagePlan?.length } = {}) {
  const finalized = validatePost(post, imageCount);
  const root = parseFirstObject(raw);
  if (root.schemaVersion !== 1) throw new TypeError('visual plan schemaVersion must be 1');
  if (!Array.isArray(root.pages) || root.pages.length !== imageCount) {
    throw new RangeError(`visual plan pages must contain exactly ${imageCount} items`);
  }
  const finalizedText = `${finalized.title}\n${finalized.body}`;
  const pages = root.pages.map((rawPage, arrayIndex) => validatePage(rawPage, arrayIndex, finalized, finalizedText, root.planningMode === 'DIRECT'));
  return { schemaVersion: 1, contentProfile: validateContentProfile(root.contentProfile), pages,
    ...(root.planningMode ? { planningMode: root.planningMode, textContractSha256: root.textContractSha256 } : {}) };
}

export { parseFirstObject as parseVisualPlanCandidate };

function validatePage(rawPage, arrayIndex, finalized, finalizedText, direct = false) {
    if (!isRecord(rawPage)) throw new TypeError(`pages[${arrayIndex}] must be an object`);
    const expectedIndex = arrayIndex + 1;
    if (rawPage.index !== expectedIndex) throw new TypeError(`pages[${arrayIndex}].index must be ${expectedIndex}`);
    const expectedKind = finalized.imagePlan[arrayIndex].kind;
    if (rawPage.kind !== expectedKind) {
      throw new TypeError(`pages[${arrayIndex}].kind must match ${expectedKind}`);
    }
    const requestedTemplate = requestedLayoutTemplate(finalized.imagePlan[arrayIndex]);
    if (rawPage.layoutSchemaVersion !== 1) throw new TypeError('layoutSchemaVersion must be 1');
    const layoutTemplate = requestedTemplate ?? validateLayoutTemplate(
      expectedKind,
      rawPage.layoutSchemaVersion,
      rawPage.layoutTemplate,
      `pages[${arrayIndex}]`,
    );
    const sourceEvidence = textList(rawPage.sourceEvidence, `pages[${arrayIndex}].sourceEvidence`, {
      min: direct ? 0 : 1,
      max: 3,
      itemMax: 200,
    });
    for (const evidence of sourceEvidence) {
      if (!finalizedText.includes(evidence)) {
        throw new TypeError(`pages[${arrayIndex}].sourceEvidence must occur in the finalized text`);
      }
    }
    const layoutDirection = requiredText(
      rawPage.layoutDirection,
      `pages[${arrayIndex}].layoutDirection`,
      { max: 300 },
    );
    const allowedVisibleText = validateVisibleText(
      rawPage.allowedVisibleText,
      `pages[${arrayIndex}].allowedVisibleText`,
      finalizedText,
      expectedKind === 'checklist' ? 40 : 30,
    );
    const explicitItemCount = explicitLayoutItemCount(layoutDirection);
    if (explicitItemCount !== null && explicitItemCount !== allowedVisibleText.bullets.length) {
      throw new RangeError(
        `pages[${arrayIndex}].layoutDirection item count ${explicitItemCount} must match allowedVisibleText.bullets count ${allowedVisibleText.bullets.length}`,
      );
    }
    const mustShow = textList(rawPage.mustShow, `pages[${arrayIndex}].mustShow`, { min: 1, max: 10, itemMax: 100 });
    const visibleCorpus = [
      allowedVisibleText.headline,
      allowedVisibleText.subtitle,
      ...allowedVisibleText.bullets,
      ...allowedVisibleText.labels,
    ].join('\n');
    for (const [index, item] of mustShow.entries()) {
      const requiredVisibleText = requiredVisibleMustShowText(item);
      if (requiredVisibleText && !visibleCorpus.includes(requiredVisibleText)) {
        throw new TypeError(
          `pages[${arrayIndex}].mustShow[${index}] requires text absent from allowedVisibleText`,
        );
      }
    }
    return {
      index: expectedIndex,
      kind: expectedKind,
      layoutSchemaVersion: 1,
      layoutTemplate,
      ...(finalized.imagePlan[arrayIndex].layout ? { manualLayout: finalized.imagePlan[arrayIndex].layout } : {}),
      sourceEvidence,
      ...(direct ? { evidenceStatus: rawPage.evidenceStatus } : {}),
      visualSubject: requiredText(rawPage.visualSubject, `pages[${arrayIndex}].visualSubject`, { max: direct ? 1000 : 300 }),
      layoutDirection,
      allowedVisibleText,
      mustShow,
      mustAvoid: textList(rawPage.mustAvoid, `pages[${arrayIndex}].mustAvoid`, { min: 1, max: 10, itemMax: 100 }),
    };
}

// The same validators power partial repair and final acceptance; repair never skips a gate.
export function inspectVisualPlanOutput(raw, { post, imageCount = post?.imagePlan?.length } = {}) {
  const finalized = validatePost(post, imageCount);
  const candidate = parseFirstObject(raw);
  const errors = [];
  try {
    if (candidate.schemaVersion !== 1) throw new TypeError('visual plan schemaVersion must be 1');
    validateContentProfile(candidate.contentProfile);
  } catch (error) { errors.push({ pageIndex: null, message: error.message }); }
  if (!Array.isArray(candidate.pages)) throw new TypeError('visual plan pages must be an array');
  const receivedPages = candidate.pages;
  candidate.pages = finalized.imagePlan.map((_, index) => {
    const matches = receivedPages.filter((page) => page?.index === index + 1);
    // Missing/duplicate indices are repaired, while uniquely identified valid pages survive.
    return matches.length === 1 ? matches[0] : null;
  });
  for (const [index, page] of candidate.pages.entries()) {
    try { validatePage(page, index, finalized, `${finalized.title}\n${finalized.body}`); }
    catch (error) { errors.push({ pageIndex: index + 1, message: error.message }); }
  }
  return { candidate, errors };
}

export function createMockVisualPlan(post, { imageCount = post?.imagePlan?.length } = {}) {
  const finalized = validatePost(post, imageCount);
  const sentences = finalized.body.split(/[。！？\n]+/u).map((value) => value.trim()).filter(Boolean);
  const fallbackEvidence = sentences[0] ?? finalized.title;
  return {
    schemaVersion: 1,
    contentProfile: {
      category: '通用内容',
      tones: ['清晰', '实用'],
      visualMedium: 'PHOTO_INFOGRAPHIC',
      informationDensity: 'MEDIUM',
    },
    pages: finalized.imagePlan.map((page, index) => ({
      index: index + 1,
      kind: page.kind,
      layoutSchemaVersion: 1,
      layoutTemplate: requestedLayoutTemplate(page) ?? defaultLayoutTemplate(page.kind),
      ...(page.layout ? { manualLayout: page.layout } : {}),
      sourceEvidence: [sentences[index % Math.max(sentences.length, 1)] ?? fallbackEvidence],
      visualSubject: page.prompt,
      layoutDirection: `${page.kind} 页面使用清晰、适合手机阅读的信息层级`,
      allowedVisibleText: {
        language: 'zh-CN',
        headline: page.headline,
        subtitle: page.subtitle,
        bullets: [...page.bullets],
        labels: [],
      },
      mustShow: [page.headline, ...page.bullets],
      mustAvoid: ['正文没有的新事实', '品牌、水印、二维码和联系方式'],
    })),
  };
}
