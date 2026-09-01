const PAGE_KIND_LABELS = Object.freeze({
  hero: '封面页',
  steps: '步骤页',
  checklist: '清单页',
  comparison: '对比页',
  detail: '详情页',
  summary: '总结页',
});

const LAYOUT_LABELS = Object.freeze({
  HERO_LEFT: '左上标题封面',
  HERO_RIGHT: '右上标题封面',
  STEPS_LEFT: '左侧纵向步骤',
  STEPS_RIGHT: '右侧纵向步骤',
  STEPS_DIAGONAL: '对角线步骤流程',
  DETAIL_LEFT_STACK: '左侧详情卡片',
  DETAIL_RIGHT_STACK: '右侧详情卡片',
  DETAIL_SPLIT: '左右分栏详情',
  COMPARISON_RIGHT_STACK: '右侧纵向对比',
  COMPARISON_TWO_COLUMN: '双栏对比',
  COMPARISON_FOUR_COLUMN: '四栏对比',
  CHECKLIST_RIGHT: '右侧纵向清单',
  CHECKLIST_LOWER_GRID: '下半区清单网格',
  SUMMARY_GRID: '总结网格',
});

function text(value, fallback = '未单独说明') {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 2_000) : fallback;
}

function textList(value, maxItems = 12) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string' && item.trim())
    .slice(0, maxItems)
    .map((item) => item.trim().slice(0, 500));
}

function taggedJson(content, tag) {
  if (typeof content !== 'string' || !content.trim()) return null;
  const match = content.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'));
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function pageLabel(position) {
  if (typeof position !== 'string') return '页码未记录';
  const match = position.trim().match(/^(\d+)\s*\/\s*(\d+)$/u);
  return match ? `第 ${match[1]} / ${match[2]} 页` : '页码未记录';
}

export function summarizeImagePrompt(content) {
  const plan = taggedJson(content, 'current_image_plan');
  if (!plan) {
    return {
      available: false,
      message: '这条历史图片提示词无法整理为审核摘要；底层原始记录仍保留，可由技术人员排查。',
      page: '',
      kind: '',
      layout: '',
      visualSubject: '',
      layoutDirection: '',
      visibleText: { headline: '', subtitle: '', bullets: [], labels: [] },
      mustShow: [],
      mustAvoid: [],
      sourceEvidence: [],
      originalVisualDirection: '',
    };
  }

  const visible = plan.allowedVisibleText && typeof plan.allowedVisibleText === 'object'
    && !Array.isArray(plan.allowedVisibleText)
    ? plan.allowedVisibleText
    : {};

  return {
    available: true,
    page: pageLabel(plan.position),
    kind: PAGE_KIND_LABELS[plan.kind] || '图片页',
    layout: LAYOUT_LABELS[plan.layoutTemplate] || '自定义版式',
    visualSubject: text(plan.visualSubject),
    layoutDirection: text(plan.layoutDirection),
    visibleText: {
      headline: text(visible.headline, ''),
      subtitle: text(visible.subtitle, ''),
      bullets: textList(visible.bullets),
      labels: textList(visible.labels),
    },
    mustShow: textList(plan.mustShow),
    mustAvoid: textList(plan.mustAvoid),
    sourceEvidence: textList(plan.sourceEvidence),
    originalVisualDirection: text(plan.originalVisualDirection),
  };
}
