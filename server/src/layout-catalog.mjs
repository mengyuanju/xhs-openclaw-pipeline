// Browser-safe catalog contract. Version 1 geometry remains in layout-contract.mjs.
export const LAYOUT_CATALOG_VERSION = 2;
export const LAYOUT_FAMILIES = Object.freeze({ hero: '中心聚焦', steps: '流程步骤', comparison: '对比比较', detail: '详情说明', checklist: '清单要点', summary: '总结汇总', radial: '环绕布局', focus: '聚焦强调', modular: '模块卡片', timeline: '时间/顺序' });
export const CONTENT_PAGE_KINDS = Object.freeze(['hero', 'steps', 'comparison', 'detail', 'checklist', 'summary']);
const applicable = { hero: ['hero'], steps: ['steps'], comparison: ['comparison'], detail: ['detail'], checklist: ['checklist'], summary: ['summary'], radial: ['detail', 'summary'], focus: ['hero', 'detail', 'summary'], modular: ['detail', 'checklist', 'summary'], timeline: ['steps', 'detail'] };
const entries = [
  ['hero', 'HERO_CENTER', '主体居中，说明围绕或辅助主体', '单一产品、食材、物品', '中央', '主体四周，顶部标题'],
  ['hero', 'HERO_LEFT', '主体/视觉在左', '产品介绍', '左侧', '右侧说明，顶部标题'],
  ['hero', 'HERO_RIGHT', '主体/视觉在右', '产品介绍', '右侧', '左侧说明，顶部标题'],
  ['steps', 'STEPS_VERTICAL', '纵向从上到下', '3～6步教程', '纵向步骤节点', '各节点旁，顶部标题', 3, 6],
  ['steps', 'STEPS_HORIZONTAL', '横向从左到右', '3～4步简短流程', '横向步骤节点', '节点下方，顶部标题', 3, 4],
  ['steps', 'STEPS_DIAGONAL', '沿对角线展开', '强调视觉动线', '左上至右下的步骤节点', '节点旁的独立文字区'],
  ['steps', 'STEPS_TRIANGLE', '3个步骤形成三角关系', '3步骤、3个要点', '三角形三个顶点', '各顶点旁，顶部标题', 3, 3],
  ['comparison', 'COMPARISON_TWO_COLUMN', '左右两列对应', 'A vs B、正反对比', '左右两列', '对应主体下方，顶部标题'],
  ['comparison', 'COMPARISON_FOUR_COLUMN', '四列并列比较', '多型号、多选项', '四列同等宽度主体', '各列内部横排，顶部标题'],
  ['comparison', 'COMPARISON_SYMMETRIC', '中轴对称，左右对应', '两类信息、正反信息', '中轴两侧对称', '左右镜像区域内横排'],
  ['detail', 'DETAIL_LEFT_STACK', '左图右文/左侧主体', '产品、食材说明', '左侧', '右侧纵向说明'],
  ['detail', 'DETAIL_RIGHT_STACK', '右图左文', '产品、食材说明', '右侧', '左侧纵向说明'],
  ['detail', 'DETAIL_SPLIT', '左右分栏', '图文并列', '左栏', '右栏，顶部标题'],
  ['detail', 'DETAIL_TOP_BOTTOM', '上方视觉，下方说明', '科普、生活技巧', '上半区', '下半区说明，顶部标题'],
  ['checklist', 'CHECKLIST_RIGHT', '主体左侧，清单右侧', '注意事项、避坑', '左侧', '右侧清单'],
  ['checklist', 'CHECKLIST_LOWER_GRID', '主视觉上方，信息网格下方', '知识点、注意事项', '上半区', '下半区网格'],
  ['checklist', 'CHECKLIST_CARD_GRID', '多个独立卡片组成整体', '4～6个知识点', '各卡片内小图', '各卡片文字区，顶部标题', 4, 6],
  ['summary', 'SUMMARY_GRID', '网格化总结', '知识总结、攻略', '网格内图形', '网格文字区，顶部标题'],
  ['summary', 'SUMMARY_HIERARCHY', '大主体＋多个小模块', '综合攻略', '上方大主体', '下方从属模块'],
  ['radial', 'RADIAL_AROUND', '主体居中，信息环绕', '食材、物品、单一主题', '中央', '主体周围独立信息块'],
  ['radial', 'RADIAL_ORBIT', '信息沿主体外围分布', '功能、特点、组成', '中央', '外围轨道上的独立横排文字块'],
  ['focus', 'FOCUS_CENTER', '核心信息居中放大', '核心结论、关键知识', '中央核心图形', '中央结论与外围解释'],
  ['focus', 'FOCUS_TOP', '顶部核心结论＋下方解释', '科普、结论型内容', '下方辅助图形', '顶部核心结论，下方解释'],
  ['modular', 'MODULAR_GRID', '多个独立模块组合', '4～6个知识点', '各模块内图形', '各模块文字区', 4, 6],
  ['modular', 'MODULAR_MASONRY', '大小模块错落排列', '综合信息、攻略', '错落模块内图形', '各模块独立文字区'],
  ['timeline', 'TIMELINE_VERTICAL', '纵向时间轴', '时间顺序、流程', '纵向轴线及节点', '节点两侧横排文字'],
  ['timeline', 'TIMELINE_HORIZONTAL', '横向时间轴', '简短阶段说明', '横向轴线及节点', '节点上下横排文字'],
];
const templates = entries.map(([layoutKind, layoutTemplate, description, suitableContent, subjectRegion, textRegion, minItems = 2, maxItems = 5]) => ({
  layoutTemplate, templateVersion: 2, layoutKind, name: description, description, suitableContent,
  applicablePageKinds: applicable[layoutKind], subjectRegion, textRegion, readingOrder: description,
  minItems, maxItems, rules: ['全部可见文字水平排列，保持清晰对比', '只使用本页已确认文字，不新增事实或编号'], enabled: true, source: 'REFERENCE',
}));
const deepFreeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };
export const BUILTIN_LAYOUT_CATALOG = deepFreeze({ schemaVersion: 2, selectionMode: 'MODEL', templates });

function record(value, fields, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name}必须是对象`);
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw new TypeError(`${name}不支持字段 ${key}`);
}
function text(value, name, max = 300) {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > max) throw new TypeError(`${name}需为1～${max}个字符`);
  return value.trim();
}
function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${name}需为${min}～${max}的整数`);
  return value;
}
export function normalizeCatalogTemplate(value) {
  record(value, ['layoutTemplate', 'templateVersion', 'layoutKind', 'name', 'description', 'suitableContent', 'applicablePageKinds', 'subjectRegion', 'textRegion', 'readingOrder', 'minItems', 'maxItems', 'rules', 'enabled', 'source'], '模板');
  if (typeof value.layoutTemplate !== 'string' || !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u.test(value.layoutTemplate) || value.layoutTemplate.length > 80) throw new TypeError('模板编码无效');
  if (!Object.hasOwn(LAYOUT_FAMILIES, value.layoutKind)) throw new TypeError('版式分类无效');
  if (!Array.isArray(value.applicablePageKinds) || !value.applicablePageKinds.length || value.applicablePageKinds.length > 6 || value.applicablePageKinds.some(kind => !CONTENT_PAGE_KINDS.includes(kind))) throw new TypeError('适用页面无效');
  if (!Array.isArray(value.rules) || value.rules.length > 8 || value.rules.length < 1) throw new TypeError('视觉规则需为1～8条');
  if (typeof value.enabled !== 'boolean') throw new TypeError('启用状态必须为布尔值');
  if (!['REFERENCE', 'MANUAL', 'MODEL'].includes(value.source)) throw new TypeError('模板来源无效');
  const minItems = integer(value.minItems, 1, 6, '最少条目数量');
  const maxItems = integer(value.maxItems, minItems, 6, '最多条目数量');
  return { layoutTemplate: value.layoutTemplate, templateVersion: integer(value.templateVersion, 2, 10000, '模板版本'), layoutKind: value.layoutKind,
    name: text(value.name, '名称', 60), description: text(value.description, '排版含义'), suitableContent: text(value.suitableContent, '适合内容'),
    applicablePageKinds: [...new Set(value.applicablePageKinds)].sort(), subjectRegion: text(value.subjectRegion, '主体区域'), textRegion: text(value.textRegion, '文字区域'), readingOrder: text(value.readingOrder, '阅读顺序'),
    minItems, maxItems, rules: value.rules.map(rule => text(rule, '视觉规则', 200)), enabled: value.enabled, source: value.source };
}
export const templateKey = item => `${item.layoutTemplate}@${item.templateVersion}`;
export function normalizeLayoutCatalog(value) {
  if (value == null) return null;
  record(value, ['schemaVersion', 'selectionMode', 'templates'], '布局目录');
  if (value.schemaVersion !== 2 || !['MODEL', 'RANDOM'].includes(value.selectionMode)) throw new TypeError('布局目录版本或选择方式无效');
  if (!Array.isArray(value.templates) || value.templates.length > 100) throw new TypeError('布局目录最多100条');
  const normalized = value.templates.map(normalizeCatalogTemplate);
  if (new Set(normalized.map(templateKey)).size !== normalized.length) throw new TypeError('模板编码与版本重复');
  const catalog = { schemaVersion: 2, selectionMode: value.selectionMode, templates: normalized };
  if (new TextEncoder().encode(JSON.stringify(catalog)).byteLength > 200_000) throw new TypeError('布局目录过大');
  return catalog;
}
export function importLayoutTemplates(current, items, { source } = {}) {
  const catalog = normalizeLayoutCatalog(current) ?? { schemaVersion: 2, selectionMode: 'MODEL', templates: [] };
  if (!Array.isArray(items) || !items.length || items.length > 100) throw new TypeError('导入模板需为1～100条');
  const incoming = normalizeLayoutCatalog({ ...catalog, templates: items.map(item => source ? { ...item, source,
    ...(source === 'MODEL' || item?.enabled === undefined ? { enabled: false } : {}) } : item) });
  const byKey = new Map(catalog.templates.map(item => [templateKey(item), item]));
  let added = 0; let unchanged = 0;
  for (const item of incoming.templates) {
    const prior = byKey.get(templateKey(item));
    // Reimporting a design preserves its current activation and original provenance.
    if (prior && JSON.stringify(prior) !== JSON.stringify({ ...item, enabled: prior.enabled, source: prior.source })) throw new TypeError(`模板版本冲突：${templateKey(item)}，请增加版本号`);
    if (prior) unchanged += 1;
    else { byKey.set(templateKey(item), item); added += 1; }
  }
  return { catalog: normalizeLayoutCatalog({ ...catalog, templates: [...byKey.values()] }), added, unchanged };
}
export function matchingLayoutTemplates(catalog, page) {
  const normalized = normalizeLayoutCatalog(catalog);
  const latest = new Map();
  for (const item of normalized?.templates ?? []) {
    if (!item.enabled || !item.applicablePageKinds.includes(page.kind) || page.bullets.length < item.minItems || page.bullets.length > item.maxItems) continue;
    if ((latest.get(item.layoutTemplate)?.templateVersion ?? 0) < item.templateVersion) latest.set(item.layoutTemplate, item);
  }
  return [...latest.values()];
}
