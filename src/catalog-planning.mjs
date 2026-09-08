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

function chooseCatalogTemplate(options, pageKind, usage, random) {
  const score = (template) => (usage.templates.get(template.layoutTemplate) ?? 0) * 100
    + (usage.families.get(template.layoutKind) ?? 0) * 10;
  const lowestScore = Math.min(...options.map(score));
  const lowest = options.filter((template) => score(template) === lowestScore);
  const preferred = lowest.filter((template) => template.layoutKind === pageKind);
  const pool = preferred.length ? preferred : lowest;
  return random ? pool[Math.floor(random() * pool.length)] : pool[0];
}

function recordCatalogTemplate(usage, template) {
  usage.templates.set(template.layoutTemplate, (usage.templates.get(template.layoutTemplate) ?? 0) + 1);
  usage.families.set(template.layoutKind, (usage.families.get(template.layoutKind) ?? 0) + 1);
}

// Diversification is deliberately best-effort: an unavailable alternative must never stop image generation.
export function catalogDiversityIssues(visualPages, post, catalog) {
  const layoutCatalog = normalizeLayoutCatalog(catalog);
  if (!layoutCatalog || !Array.isArray(visualPages)) return [];
  const templateUsage = new Map();
  const familyUsage = new Map();
  const catalogByTemplate = new Map(layoutCatalog.templates.map((template) => [template.layoutTemplate, template]));
  for (const page of visualPages) {
    if (!page?.layoutTemplate) continue;
    templateUsage.set(page.layoutTemplate, (templateUsage.get(page.layoutTemplate) ?? 0) + 1);
    const family = catalogByTemplate.get(page.layoutTemplate)?.layoutKind;
    if (family) familyUsage.set(family, (familyUsage.get(family) ?? 0) + 1);
  }
  return visualPages.flatMap((visualPage, index) => {
    const sourcePage = post.imagePlan[index];
    if (!sourcePage || requestedLayoutTemplate(sourcePage)) return [];
    const options = catalogPageOptions(sourcePage, layoutCatalog);
    if (!options || !visualPage?.layoutTemplate) return [];
    const selectedFamily = catalogByTemplate.get(visualPage.layoutTemplate)?.layoutKind;
    const unusedTemplate = (templateUsage.get(visualPage.layoutTemplate) ?? 0) > 1
      && options.find((template) => (templateUsage.get(template.layoutTemplate) ?? 0) === 0);
    const unusedFamily = selectedFamily && (familyUsage.get(selectedFamily) ?? 0) > 1
      && options.find((template) => (familyUsage.get(template.layoutKind) ?? 0) === 0);
    const alternative = unusedTemplate || unusedFamily;
    return alternative ? [{
      code: unusedTemplate ? 'LAYOUT_TEMPLATE_REPEATED' : 'LAYOUT_FAMILY_REPEATED',
      pageIndex: index + 1,
      message: `第 ${index + 1} 页使用 ${visualPage.layoutTemplate}，可改用 ${alternative.layoutTemplate} 进一步增加整套排版差异`,
    }] : [];
  });
}

export function catalogDirectPlan(base, post, catalog, random = undefined) {
  const layoutCatalog = normalizeLayoutCatalog(catalog);
  if (!layoutCatalog) return base;
  const usage = { templates: new Map(), families: new Map() };
  return { ...base, layoutCatalog, visualStyle: { palette: ['#FFF8EF', '#252525', '#EF7D45'], tone: '沿用原场景，清晰简洁' },
    pages: base.pages.map((page, index) => {
      const options = catalogPageOptions(post.imagePlan[index], layoutCatalog);
      if (!options) return page;
      const selected = chooseCatalogTemplate(options, page.kind, usage, random);
      const repeats = usage.templates.get(selected.layoutTemplate) ?? 0;
      recordCatalogTemplate(usage, selected);
      const selectionReason = repeats
        ? `候选范围不足，复用 ${selected.layoutTemplate}；已优先选择本页用途、条目数量及整套重复最少的模板`
        : random
          ? '从符合本页用途与条目数量的候选中随机选择，并优先避开本套已用模板'
          : '按本页用途、条目数量及整套去重确定性匹配，未调用视觉规划模型';
      const fields = catalogPageFields({ ...selected, layoutSchemaVersion: 2, selectionReason }, post.imagePlan[index], layoutCatalog);
      return { ...page, ...fields, visualStyle: { palette: ['#FFF8EF', '#252525', '#EF7D45'], tone: '沿用原场景，清晰简洁' }, layoutDirection: `${selected.description}；主体：${selected.subjectRegion}；文字：${selected.textRegion}`.slice(0, 300) };
    }) };
}
