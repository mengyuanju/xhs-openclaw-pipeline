import {
  CircleCheck,
  ExternalLink,
  LayoutTemplate,
  ScanText,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';

import type { ImageGenerationResult } from './use-image-generation-run';

const DIMENSION_LABELS: Record<string, string> = {
  queryRelevance: '选题相关性',
  contentOriginality: '内容原创性',
  imageBaseQuality: '图片基础质量',
  imageTextQuality: '图片文字质量',
  imageConsistency: '图集一致性',
  noteTone: '笔记语气',
  platformAdaptation: '平台适配',
  informationValue: '信息价值',
  imageAesthetics: '图片美观度',
  imageDiversity: '图集多样性',
};

const DISPOSITION_LABELS: Record<string, string> = {
  manual_review_required: '待人工复核',
  blocked: '质检阻断',
  not_available: '暂无结论',
};

const ACTION_LABELS: Record<string, string> = {
  priority_review: '优先人工复核',
  return_for_revision: '返回修订',
  redline_block: '红线阻断',
};

function qualityScore(score: number | null) {
  return score === null ? '未评分' : `${score} / 3`;
}

function alignmentLabel(value: boolean | null) {
  if (value === true) return 'OCR 对齐通过';
  if (value === false) return 'OCR 对齐未通过';
  return '未执行 OCR 对齐';
}

function severityClass(severity: string) {
  return ['blocking', 'major', 'redline'].includes(severity)
    ? 'standalone-image-quality-issue blocking'
    : 'standalone-image-quality-issue';
}

export function ImageGenerationResultView({ result }: { result: ImageGenerationResult }) {
  return <section className="panel standalone-image-result" aria-labelledby="image-result-heading">
    <div className="panel-head">
      <div>
        <span className="section-kicker">Run result</span>
        <h2 id="image-result-heading">图片试验结果</h2>
      </div>
      <span className={result.status === 'COMPLETED' ? 'pill pill-approved' : 'pill pill-warning'}>
        {result.status === 'COMPLETED' ? '已完成' : '仅供验证'}
      </span>
    </div>

    <dl className="standalone-image-summary">
      <div><dt>运行 ID</dt><dd className="mono">{result.runId}</dd></div>
      <div><dt>图片</dt><dd>{result.imageCount} 张</dd></div>
      <div><dt>QC</dt><dd>{qualityScore(result.qc.overallScore)}</dd></div>
    </dl>

    {result.visualPlan?.degraded && <div className="notice warning standalone-image-plan-warning">
      <TriangleAlert aria-hidden="true" size={16} />
      <div>
        <strong>视觉规划使用了降级方案</strong>
        <span>{result.visualPlan.warning?.message ?? '规划模型不可用，系统已使用确定性布局继续生成。'}</span>
      </div>
    </div>}

    <section className="standalone-image-preview-section" aria-labelledby="standalone-image-preview-heading">
      <div className="standalone-image-section-heading">
        <div>
          <span className="section-kicker">Delivery preview</span>
          <h3 id="standalone-image-preview-heading">成品预览</h3>
        </div>
        <span>{result.imageCount} 页 · 3:4 竖版</span>
      </div>

      <ol className="standalone-image-page-list">
        {result.images.map((image) => {
          const layoutHeadingId = `standalone-layout-${result.runId}-${image.pageIndex}`;
          const alt = image.layout?.allowedVisibleText.headline
            ? `第 ${image.pageIndex} 页预览：${image.layout.allowedVisibleText.headline}`
            : `第 ${image.pageIndex} 页图片预览：${image.kind}`;
          return <li key={image.pageIndex}>
            <article className="standalone-image-page-card">
              <div className="standalone-image-preview">
                <a href={image.url} target="_blank" rel="noreferrer" aria-label={`打开第 ${image.pageIndex} 页原图`}>
                  <img
                    src={image.url}
                    alt={alt}
                    width={1086}
                    height={1448}
                    loading="lazy"
                  />
                </a>
                <div className="standalone-image-preview-meta">
                  <strong>{String(image.pageIndex).padStart(2, '0')} · {image.kind}</strong>
                  <span>{image.provider}{image.model ? ` · ${image.model}` : ''}</span>
                  <div>
                    <span className={image.alignmentPassed === false ? 'pill pill-warning' : 'pill pill-approved'}>
                      <ScanText aria-hidden="true" size={12} />{alignmentLabel(image.alignmentPassed)}
                    </span>
                    {image.generationAttempts !== null && <span>生成 {image.generationAttempts} 次</span>}
                  </div>
                  <a href={image.url} target="_blank" rel="noreferrer">
                    查看原图 <ExternalLink aria-hidden="true" size={13} />
                  </a>
                </div>
              </div>

              <section className="standalone-image-layout" aria-labelledby={layoutHeadingId}>
                <div className="standalone-image-layout-heading">
                  <div>
                    <LayoutTemplate aria-hidden="true" size={17} />
                    <h4 id={layoutHeadingId}>视觉布局</h4>
                  </div>
                  {image.layout && <code>{image.layout.layoutTemplate}</code>}
                </div>
                {image.layout ? <>
                  <div className="standalone-image-layout-copy">
                    <span>标题区</span>
                    <strong>{image.layout.allowedVisibleText.headline}</strong>
                    <p>{image.layout.allowedVisibleText.subtitle}</p>
                  </div>
                  <div className="standalone-image-layout-block">
                    <strong>页面要点</strong>
                    <ul>{image.layout.allowedVisibleText.bullets.map((bullet, index) =>
                      <li key={`${bullet}-${index}`}>{bullet}</li>)}</ul>
                  </div>
                  <dl className="standalone-image-layout-facts">
                    <div><dt>构图方向</dt><dd>{image.layout.layoutDirection}</dd></div>
                    <div><dt>视觉主体</dt><dd>{image.layout.visualSubject}</dd></div>
                  </dl>
                  <div className="standalone-image-layout-constraints">
                    <div>
                      <strong>必须呈现</strong>
                      <ul>{image.layout.mustShow.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
                    </div>
                    <div>
                      <strong>必须避开</strong>
                      <ul>{image.layout.mustAvoid.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
                    </div>
                  </div>
                </> : <p className="standalone-image-empty">此历史结果没有保存可展示的视觉布局。</p>}
              </section>
            </article>
          </li>;
        })}
      </ol>
    </section>

    <section className="standalone-image-quality" aria-labelledby="standalone-image-quality-heading">
      <div className="standalone-image-section-heading">
        <div>
          <span className="section-kicker">Quality review</span>
          <h3 id="standalone-image-quality-heading">图片质检意见</h3>
        </div>
        <span>{DISPOSITION_LABELS[result.qc.disposition] ?? result.qc.disposition}</span>
      </div>

      <div className="standalone-image-quality-summary">
        <ShieldCheck aria-hidden="true" size={20} />
        <div>
          <strong>{qualityScore(result.qc.overallScore)} · {result.qc.action ? ACTION_LABELS[result.qc.action] ?? result.qc.action : '等待人工抽查'}</strong>
          <p>{result.qc.summary}</p>
        </div>
      </div>

      {result.qc.issues.length > 0
        ? <ul className="standalone-image-quality-issues">{result.qc.issues.map((issue, index) => <li className={severityClass(issue.severity)} key={`${issue.label}-${index}`}>
          <TriangleAlert aria-hidden="true" size={16} />
          <div><strong>{issue.label}</strong><p>{issue.evidence}</p></div>
        </li>)}</ul>
        : <div className="notice success standalone-image-quality-clear">
          <CircleCheck aria-hidden="true" size={16} />当前质检没有记录阻断或警告问题，仍建议人工查看成品细节。
        </div>}

      {result.qc.dimensions.length > 0
        ? <div className="standalone-image-quality-dimensions">
          {result.qc.dimensions.map((dimension) => <article key={dimension.key}>
            <header>
              <strong>{DIMENSION_LABELS[dimension.key] ?? dimension.key}</strong>
              <span>{dimension.applicable ? qualityScore(dimension.score) : '不参与评分'}</span>
            </header>
            {dimension.evidence.length > 0
              ? <ul>{dimension.evidence.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
              : <p>本项没有保存详细质检证据。</p>}
          </article>)}
        </div>
        : <p className="standalone-image-empty">此历史结果没有保存逐项质检意见。</p>}

      {result.qc.limitations.length > 0 && <details className="standalone-image-quality-limitations">
        <summary>查看质检能力边界</summary>
        <ul>{result.qc.limitations.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
      </details>}
    </section>
  </section>;
}
