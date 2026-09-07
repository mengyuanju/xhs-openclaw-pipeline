import { matchingLayoutTemplates, normalizeLayoutCatalog } from '../server/src/layout-catalog.mjs';
import { requestedLayoutTemplate } from './image-layout-controls.mjs';

export function catalogPageOptions(page, layoutCatalog) {
  if (!layoutCatalog || requestedLayoutTemplate(page)) return null;
  const options = matchingLayoutTemplates(layoutCatalog, page);
  if (!options.length) throw new TypeError(`${page.kind} 页面没有适配 ${page.bullets.length} 条内容的已启用模板`);
  return options;
}

export function catalogPageFields(rawPage, page, layoutCatalog) {
  const options = catalogPageOptions(page, layoutCatalog);
  if (!options) return null;
  const selected = options.find(item => item.layoutTemplate === rawPage.layoutTemplate && item.templateVersion === rawPage.templateVersion);
  if (!selected || rawPage.layoutKind !== selected.layoutKind || rawPage.layoutSchemaVersion !== 2) throw new TypeError('layoutTemplate 必须匹配本次目录中的启用模板、分类和版本');
  if (typeof rawPage.selectionReason !== 'string' || !rawPage.selectionReason.trim() || [...rawPage.selectionReason].length > 300) throw new TypeError('selectionReason 必须说明选择原因（1～300字）');
  return { layoutSchemaVersion: 2, layoutTemplate: selected.layoutTemplate, templateVersion: selected.templateVersion,
    layoutKind: selected.layoutKind, selectionReason: rawPage.selectionReason.trim(), catalogTemplate: selected };
}

export function normalizeVisualStyle(value) {
  if (!value || !Array.isArray(value.palette) || value.palette.length < 2 || value.palette.length > 5 || value.palette.some(color => typeof color !== 'string' || !/^#[0-9a-f]{6}$/iu.test(color))) throw new TypeError('visualStyle.palette 需为2～5个十六进制颜色');
  if (typeof value.tone !== 'string' || !value.tone.trim() || [...value.tone].length > 100) throw new TypeError('visualStyle.tone 需为1～100个字符');
  return { palette: [...value.palette], tone: value.tone.trim() };
}

export function catalogDirectPlan(base, post, catalog, random = undefined) {
  const layoutCatalog = normalizeLayoutCatalog(catalog);
  if (!layoutCatalog) return base;
  return { ...base, layoutCatalog, visualStyle: { palette: ['#FFF8EF', '#252525', '#EF7D45'], tone: '沿用原场景，清晰简洁' },
    pages: base.pages.map((page, index) => {
      const options = catalogPageOptions(post.imagePlan[index], layoutCatalog);
      if (!options) return page;
      const selected = random ? options[Math.floor(random() * options.length)] : options.find(item => item.layoutKind === page.kind) ?? options[0];
      const fields = catalogPageFields({ ...selected, layoutSchemaVersion: 2, selectionReason: random ? '从匹配本页用途与条目数量的模板中随机选择' : '按本页用途与条目数量确定性匹配，未调用视觉规划模型' }, post.imagePlan[index], layoutCatalog);
      return { ...page, ...fields, visualStyle: { palette: ['#FFF8EF', '#252525', '#EF7D45'], tone: '沿用原场景，清晰简洁' }, layoutDirection: `${selected.description}；主体：${selected.subjectRegion}；文字：${selected.textRegion}`.slice(0, 300) };
    }) };
}
