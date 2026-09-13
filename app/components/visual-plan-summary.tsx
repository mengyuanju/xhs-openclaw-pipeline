import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';

type Page = {
  index?: unknown;
  layoutTemplate?: unknown;
  templateVersion?: unknown;
  layoutSchemaVersion?: unknown;
  selectionReason?: unknown;
  visualSubject?: unknown;
  layoutDirection?: unknown;
  catalogTemplate?: unknown;
};

const LAYOUT_LABELS: Record<string, string> = {
  HERO_CENTER: '居中封面',
  DETAIL_SPLIT: '细节分栏',
  MODULAR_MASONRY: '模块拼贴',
  COMPARISON_TWO_COLUMN: '双栏对比',
};

function cleanText(value: unknown, fallback = '未记录') {
  return typeof value === 'string' && value.trim() ? [...value.trim()].slice(0, 500).join('') : fallback;
}

function positiveInteger(value: unknown, fallback: number) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function layoutLabel(template: string) {
  return LAYOUT_LABELS[template] ?? template.replaceAll('_', ' ');
}

function planningModeLabel(value: unknown) {
  if (value === 'RANDOM') return '随机匹配';
  if (value === 'DIRECT') return '自动匹配';
  if (value === 'MODEL') return '模型匹配';
  return '已保存规划';
}

export function VisualPlanSummary({ value }: { value?: unknown }) {
  if (!value || typeof value !== 'object' || !('pages' in value) || !Array.isArray(value.pages)) return null;
  const pages = value.pages.filter(page => page && typeof page === 'object') as Page[];
  if (!pages.length) return null;
  const style = (value as { visualStyle?: { tone?: unknown; palette?: unknown } }).visualStyle;
  const planningMode = planningModeLabel((value as { planningMode?: unknown }).planningMode);
  const tone = cleanText(style?.tone, '未单独记录整套视觉基调');
  const palette = Array.isArray(style?.palette)
    ? style.palette.filter((color): color is string => typeof color === 'string' && /^#[0-9a-f]{6}$/iu.test(color)).slice(0, 5)
    : [];

  return <Disclosure className="visual-plan-summary">
    <DisclosureTrigger className="visual-plan-summary-trigger">
      <span className="visual-plan-summary-icon" aria-hidden="true">视觉</span>
      <span className="visual-plan-summary-title"><strong>本次视觉规划</strong><small>以下为实际保存的设计，续跑继续使用同一份规划</small></span>
      <span className="visual-plan-summary-meta"><b>{pages.length} 页</b><em>{planningMode}</em></span>
    </DisclosureTrigger>
    <DisclosureContent className="visual-plan-summary-content">
      <section className="visual-plan-overview" aria-label="整套视觉规划">
        <div><span>整套风格</span><p>{tone}</p></div>
        {palette.length > 0 && <div><span>核心配色</span><div className="visual-plan-palette">{palette.map((color, index) => <span className="visual-plan-color" key={`${color}-${index}`}>
          <i aria-hidden="true" style={{ backgroundColor: color }} /><code>{color.toUpperCase()}</code>
        </span>)}</div></div>}
      </section>
      <div className="visual-plan-pages">{pages.map((page, index) => {
        const pageIndex = positiveInteger(page.index, index + 1);
        const template = cleanText(page.layoutTemplate, '历史布局');
        const version = positiveInteger(page.templateVersion, positiveInteger(page.layoutSchemaVersion, 1));
        const catalog = page.catalogTemplate && typeof page.catalogTemplate === 'object'
          ? page.catalogTemplate as { subjectRegion?: unknown; textRegion?: unknown }
          : null;
        return <article className="visual-plan-page-card" key={`${pageIndex}-${index}`}>
          <header>
            <span className="visual-plan-page-index">{String(pageIndex).padStart(2, '0')}</span>
            <div><h4>第 {pageIndex} 页 · {layoutLabel(template)}</h4><small>{template} · 版本 {version}</small></div>
          </header>
          {typeof page.selectionReason === 'string' && page.selectionReason.trim()
            && <p className="visual-plan-page-reason"><strong>选用理由</strong>{cleanText(page.selectionReason)}</p>}
          <dl className="visual-plan-page-facts">
            <div className="full"><dt>画面主体</dt><dd>{cleanText(page.visualSubject)}</dd></div>
            <div className="full"><dt>排版设计</dt><dd>{cleanText(page.layoutDirection)}</dd></div>
            {catalog && <>
              <div><dt>主体区域</dt><dd>{cleanText(catalog.subjectRegion)}</dd></div>
              <div><dt>文字区域</dt><dd>{cleanText(catalog.textRegion)}</dd></div>
            </>}
          </dl>
        </article>;
      })}</div>
    </DisclosureContent>
  </Disclosure>;
}
