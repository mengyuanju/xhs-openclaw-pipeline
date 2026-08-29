export const LAYOUT_SCHEMA_VERSION = 1;

export const LAYOUT_TEMPLATES_BY_KIND = Object.freeze({
  hero: Object.freeze(['HERO_LEFT', 'HERO_RIGHT']),
  steps: Object.freeze(['STEPS_LEFT', 'STEPS_RIGHT', 'STEPS_DIAGONAL']),
  detail: Object.freeze(['DETAIL_LEFT_STACK', 'DETAIL_RIGHT_STACK', 'DETAIL_SPLIT']),
  comparison: Object.freeze([
    'COMPARISON_RIGHT_STACK',
    'COMPARISON_TWO_COLUMN',
    'COMPARISON_FOUR_COLUMN',
  ]),
  checklist: Object.freeze(['CHECKLIST_RIGHT', 'CHECKLIST_LOWER_GRID']),
  summary: Object.freeze(['SUMMARY_GRID']),
});

const TEMPLATE_GEOMETRY = Object.freeze({
  HERO_LEFT: Object.freeze({
    titlePosition: 'top-left', contentLayout: 'bottom-strip', subtitlePosition: 'title',
    subjectRegion: '中央与右侧', textSafeRegion: '左上标题区与底部要点区',
  }),
  HERO_RIGHT: Object.freeze({
    titlePosition: 'top-right', contentLayout: 'bottom-strip', subtitlePosition: 'title',
    subjectRegion: '中央与左侧', textSafeRegion: '右上标题区与底部要点区',
  }),
  STEPS_LEFT: Object.freeze({
    titlePosition: 'top-right', contentLayout: 'vertical-flow', subtitlePosition: 'title',
    subjectRegion: '中央与右侧', textSafeRegion: '左侧纵向步骤区与右上标题区',
  }),
  STEPS_RIGHT: Object.freeze({
    titlePosition: 'top-left', contentLayout: 'vertical-flow', subtitlePosition: 'title',
    subjectRegion: '中央与左侧', textSafeRegion: '右侧纵向步骤区与左上标题区',
  }),
  STEPS_DIAGONAL: Object.freeze({
    titlePosition: 'top-left', contentLayout: 'diagonal-flow', subtitlePosition: 'title',
    subjectRegion: '中央背景层', textSafeRegion: '左上标题区与左上至右下的步骤槽位',
  }),
  DETAIL_LEFT_STACK: Object.freeze({
    titlePosition: 'top-right', contentLayout: 'left-detail', subtitlePosition: 'title',
    subjectRegion: '中央与右侧', textSafeRegion: '左侧信息卡区与右上标题区',
  }),
  DETAIL_RIGHT_STACK: Object.freeze({
    titlePosition: 'top-right', contentLayout: 'right-detail', subtitlePosition: 'title',
    subjectRegion: '左侧约52%', textSafeRegion: '右侧约48%的纵向信息区',
  }),
  DETAIL_SPLIT: Object.freeze({
    titlePosition: 'top-right', contentLayout: 'detail-split', subtitlePosition: 'title',
    subjectRegion: '中央背景层', textSafeRegion: '左右两列信息区与右上标题区',
  }),
  COMPARISON_RIGHT_STACK: Object.freeze({
    titlePosition: 'top-left', contentLayout: 'right-comparison', subtitlePosition: 'title',
    subjectRegion: '左侧与中央', textSafeRegion: '右侧纵向比较区与左上标题区',
  }),
  COMPARISON_TWO_COLUMN: Object.freeze({
    titlePosition: 'top-left', contentLayout: 'comparison-matrix', subtitlePosition: 'title',
    subjectRegion: '中央背景层', textSafeRegion: '左右两列矩阵区、底部结论区与左上标题区',
  }),
  COMPARISON_FOUR_COLUMN: Object.freeze({
    titlePosition: 'top-left', contentLayout: 'four-column-matrix', subtitlePosition: 'title',
    subjectRegion: '上半区', textSafeRegion: '下半区四列矩阵、底部结论区与左上标题区',
  }),
  CHECKLIST_RIGHT: Object.freeze({
    titlePosition: 'top-right', contentLayout: 'right-checklist', subtitlePosition: 'bottom',
    subjectRegion: '左侧约54%', textSafeRegion: '右侧约46%的五项清单区、右上标题区与底部提示区',
  }),
  CHECKLIST_LOWER_GRID: Object.freeze({
    titlePosition: 'top-right', contentLayout: 'lower-grid', subtitlePosition: 'title',
    subjectRegion: '上半区', textSafeRegion: '下半区清单网格与右上标题区',
  }),
  SUMMARY_GRID: Object.freeze({
    titlePosition: 'top-center', contentLayout: 'grid', subtitlePosition: 'title',
    subjectRegion: '中央背景层', textSafeRegion: '中部网格与顶部居中标题区',
  }),
});

export function validateLayoutTemplate(kind, schemaVersion, template, name = 'layout') {
  if (schemaVersion !== LAYOUT_SCHEMA_VERSION) {
    throw new TypeError(`${name}.layoutSchemaVersion must be ${LAYOUT_SCHEMA_VERSION}`);
  }
  if (typeof template !== 'string' || !template.trim()) {
    throw new TypeError(`${name}.layoutTemplate is required`);
  }
  const allowed = LAYOUT_TEMPLATES_BY_KIND[kind];
  if (!allowed) throw new TypeError(`${name}.kind ${kind} has no layout templates`);
  if (!allowed.includes(template)) {
    throw new TypeError(`${name}.layoutTemplate ${template} is invalid for ${kind}`);
  }
  return template;
}

export function layoutGeometry(template) {
  const geometry = TEMPLATE_GEOMETRY[template];
  if (!geometry) throw new TypeError(`unknown layout template: ${template}`);
  return geometry;
}

export function defaultLayoutTemplate(kind) {
  const template = LAYOUT_TEMPLATES_BY_KIND[kind]?.[0];
  if (!template) throw new TypeError(`no default layout template for ${kind}`);
  return template;
}

export function layoutTemplatePromptRules() {
  return Object.entries(LAYOUT_TEMPLATES_BY_KIND)
    .map(([kind, templates]) => `${kind}: ${templates.join(' | ')}`)
    .join('；');
}

export function fullPageInstructionForLayout(template) {
  const geometry = layoutGeometry(template);
  return `layoutTemplate=${template}。主体区域：${geometry.subjectRegion}。文字排版区域：${geometry.textSafeRegion}。请在同一次生成中完成主体、标题、要点、标签、卡片和装饰，让文字成为画面设计的一部分；不得留下空白占位框，也不得使用后贴字幕式的悬浮黑框。`;
}
