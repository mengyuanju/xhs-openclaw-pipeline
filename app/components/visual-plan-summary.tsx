type Page = { index?: number; layoutTemplate?: string; templateVersion?: number; layoutSchemaVersion?: number; selectionReason?: string;
  visualSubject?: string; layoutDirection?: string; catalogTemplate?: { subjectRegion?: string; textRegion?: string } };

export function VisualPlanSummary({ value }: { value?: unknown }) {
  if (!value || typeof value !== 'object' || !('pages' in value) || !Array.isArray(value.pages)) return null;
  const pages = value.pages.filter(page => page && typeof page === 'object') as Page[];
  if (!pages.length) return null;
  const style = (value as { visualStyle?: { tone?: unknown; palette?: unknown } }).visualStyle;
  const planningMode = (value as { planningMode?: unknown }).planningMode;
  const palette = Array.isArray(style?.palette) ? style.palette.filter((color): color is string => typeof color === 'string' && /^#[0-9a-f]{6}$/iu.test(color)) : [];
  return <details className="visual-plan-summary"><summary>本次视觉规划 · {pages.length} 页{planningMode === 'RANDOM' ? ' · 随机匹配' : planningMode === 'DIRECT' ? ' · 自动匹配' : planningMode === 'MODEL' ? ' · 模型匹配' : ''}</summary>
    <p className="subtle">以下为本次实际保存的设计，续跑继续使用同一份规划。</p>
    {typeof style?.tone === 'string' && <p>整套风格：{style.tone}</p>}
    {palette.length > 0 && <p>配色：{palette.map((color, index) => <span key={index} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 12 }}><span aria-hidden="true" style={{ width: 14, height: 14, backgroundColor: color, border: '1px solid #ccc', borderRadius: 3 }} /><code>{color}</code></span>)}</p>}
    <div className="settings-stack">{pages.map((page, index) => <article className="prompt-content-card" key={index}>
      <h4>第 {page.index ?? index + 1} 页 · {page.layoutTemplate ?? '历史布局'} <small className="subtle">版本 {page.templateVersion ?? page.layoutSchemaVersion ?? 1}</small></h4>
      {page.selectionReason && <p>{page.selectionReason}</p>}
      <dl><dt>画面主体</dt><dd>{page.visualSubject}</dd><dt>排版设计</dt><dd>{page.layoutDirection}</dd>
        {page.catalogTemplate && <><dt>主体区域</dt><dd>{page.catalogTemplate.subjectRegion}</dd><dt>文字区域</dt><dd>{page.catalogTemplate.textRegion}</dd></>}
      </dl>
    </article>)}</div>
  </details>;
}
