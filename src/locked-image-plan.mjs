import { createHash } from 'node:crypto';
import { defaultLayoutTemplate } from './layout-contract.mjs';

export function lockedImageText(post) {
  if (!Array.isArray(post?.imagePlan) || post.imagePlan.length < 3 || post.imagePlan.length > 5) throw new TypeError('已确认的逐页配图策划不完整');
  return post.imagePlan.map((page, index) => ({ index: index + 1, kind: page.kind,
    allowedVisibleText: { language: 'zh-CN', headline: page.headline, subtitle: page.subtitle,
      bullets: [...page.bullets], labels: [] } }));
}
export const imageTextHash = (post) => createHash('sha256').update(JSON.stringify(lockedImageText(post))).digest('hex');

export function assertImagePlanNumericEvidence(post) {
  const corpus = `${post.title}\n${post.body}`;
  for (const page of lockedImageText(post)) {
    const { headline, subtitle, bullets } = page.allowedVisibleText;
    const numbers = [headline, subtitle, ...bullets].flatMap((text) => String(text).match(/\d+(?:\.\d+)?%?/gu) ?? []);
    for (const number of numbers) if (!corpus.includes(number)) {
      throw new TypeError(`原配图第 ${page.index} 页包含正文或标题未支持的数字 ${number}，请先修订配图文案；未调用视觉规划或生图模型`);
    }
  }
}

export function assertLockedImageText(plan, post) {
  const expected = lockedImageText(post);
  if (plan?.pages?.length !== expected.length) throw new TypeError('锁定文字的图片页数不一致');
  for (const [index, item] of expected.entries()) {
    const actual = plan.pages[index];
    if (actual?.index !== item.index || actual?.kind !== item.kind
      || actual?.allowedVisibleText?.headline !== item.allowedVisibleText.headline
      || actual?.allowedVisibleText?.subtitle !== item.allowedVisibleText.subtitle
      || JSON.stringify(actual?.allowedVisibleText?.bullets) !== JSON.stringify(item.allowedVisibleText.bullets)
      || (actual?.allowedVisibleText?.labels?.length ?? 0) !== 0) {
      throw new TypeError(`第 ${index + 1} 页文字锁定校验失败：视觉规划不得改写文字、添加标签或移动页面`);
    }
  }
  return plan;
}

export function createDirectVisualPlan(post) {
  const corpus = `${post.title}\n${post.body}`;
  const pages = lockedImageText(post).map((page, index) => {
    const text = page.allowedVisibleText;
    const sourceEvidence = [...new Set([text.headline, text.subtitle, ...text.bullets])]
      .filter((value) => typeof value === 'string' && value.length <= 200 && corpus.includes(value)).slice(0, 3);
    return { ...page, layoutSchemaVersion: 1, layoutTemplate: defaultLayoutTemplate(page.kind),
      sourceEvidence, evidenceStatus: sourceEvidence.length ? 'VERBATIM_MATCH' : 'POST_REFERENCE_ONLY',
      visualSubject: post.imagePlan[index].prompt,
      layoutDirection: '依据原配图场景和当前默认版式安排主体与阅读顺序',
      mustShow: [`文字：${text.headline}`, ...text.bullets.map((value) => `文字：${value}`)],
      mustAvoid: ['未经确认的新事实', '文字契约外的新增文字'] };
  });
  return { schemaVersion: 1, planningMode: 'DIRECT', textContractSha256: imageTextHash(post),
    contentProfile: { category: '原配图策划', tones: ['沿用已发布图片规则'], visualMedium: 'PHOTO_INFOGRAPHIC', informationDensity: 'MEDIUM' }, pages };
}
