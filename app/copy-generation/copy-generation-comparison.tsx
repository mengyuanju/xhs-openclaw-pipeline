'use client';

import { ArrowRight, CheckCircle2, CircleAlert, Clock3, Copy, RotateCcw } from 'lucide-react';
import { useRouter } from 'next/navigation';

import { formatDuration } from '../components/time-format';
import {
  createImageGenerationDraft,
  writeImageGenerationDraft,
} from '../image-generation/image-generation-draft';

export type CopyText = { title: string; body: string; tags: string[] };

type CopyImagePlanPage = {
  kind: 'hero' | 'steps' | 'checklist' | 'comparison' | 'detail' | 'summary';
  headline: string;
  subtitle: string;
  bullets: string[];
  prompt: string;
};

type StageReview = {
  decision: 'PASS' | 'REJECT';
  summary: string;
  issues: Array<{ code: string; severity: 'WARNING' | 'BLOCKING'; message: string }>;
};

type CopyGenerationVersion = {
  copy: CopyText;
  imagePlan: CopyImagePlanPage[];
  model: string;
  thinking: string | null;
  review: StageReview;
};

export type CopyGenerationTiming = {
  queryReviewMs: number;
  researchMs: number;
  originalGenerationMs: number;
  originalReviewMs: number;
  reviewedGenerationMs: number;
  reviewedReviewMs: number;
  totalMs: number;
};

export type CopyGenerationTimingStatistics = {
  sampleSize: number;
  averageMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  stageAverages: {
    [Field in keyof Omit<CopyGenerationTiming, 'totalMs'>]: number | null;
  };
};

export type CopyGenerationResult = {
  id: number;
  query: string;
  input: Record<string, unknown>;
  requestedImageCount: 'auto' | number;
  createdAt: string;
  original: CopyGenerationVersion;
  reviewed: CopyGenerationVersion;
  copy: CopyText;
  imagePlan: CopyImagePlanPage[];
  generation: {
    model: string;
    originalModel: string;
    reviewedModel: string;
    thinking: string | null;
    originalThinking: string | null;
    reviewedThinking: string | null;
    revisionAttempted: boolean;
    imageCount: number;
    timing: CopyGenerationTiming | null;
  };
};

const TIMING_STAGES: Array<{ field: keyof Omit<CopyGenerationTiming, 'totalMs'>; label: string }> = [
  { field: 'queryReviewMs', label: '选题审核' },
  { field: 'researchMs', label: '联网研究' },
  { field: 'originalGenerationMs', label: '原始版生成' },
  { field: 'originalReviewMs', label: '原始版质检' },
  { field: 'reviewedGenerationMs', label: '质检版生成' },
  { field: 'reviewedReviewMs', label: '质检版复检' },
];

const IMAGE_KIND_LABELS: Record<CopyImagePlanPage['kind'], string> = {
  hero: '封面',
  steps: '步骤',
  checklist: '清单',
  comparison: '对比',
  detail: '详解',
  summary: '总结',
};

function copyText(copy: CopyText) {
  const tags = copy.tags.map((tag) => tag.startsWith('#') ? tag : `#${tag}`).join(' ');
  return [copy.title, copy.body, tags].filter(Boolean).join('\n\n');
}

function CopyImagePlan({
  label,
  imagePlan,
}: {
  label: string;
  imagePlan: CopyImagePlanPage[];
}) {
  const headingId = `copy-image-plan-${label === '原始版' ? 'original' : 'reviewed'}`;

  return <section className="copy-image-plan" aria-labelledby={headingId}>
    <div className="copy-image-plan-head">
      <div>
        <span className="section-kicker">Image plan</span>
        <h4 id={headingId}>图片策划</h4>
      </div>
      <span className="pill">{imagePlan.length}页</span>
    </div>
    <ol className="copy-image-plan-list">
      {imagePlan.map((page, index) => <li className="copy-image-plan-page" key={`${page.kind}-${index}`}>
        <article>
          <div className="copy-image-plan-page-head">
            <span>第{index + 1}页 · {IMAGE_KIND_LABELS[page.kind]}</span>
            <code>{page.kind}</code>
          </div>
          <h5>{page.headline}</h5>
          <p>{page.subtitle}</p>
          <ul className="copy-image-plan-bullets">
            {page.bullets.map((bullet, bulletIndex) => <li key={`${bullet}-${bulletIndex}`}>{bullet}</li>)}
          </ul>
          <details className="copy-image-plan-prompt">
            <summary>查看画面提示</summary>
            <p>{page.prompt}</p>
          </details>
        </article>
      </li>)}
    </ol>
  </section>;
}

function CopyVersion({
  label,
  version,
}: {
  label: string;
  version: CopyGenerationVersion;
}) {
  return <article className="copy-version-card">
    <div className="copy-version-head">
      <div>
        <span className="section-kicker">{label}</span>
        <strong>{version.model}</strong>
        <small>thinking：{version.thinking ?? '历史记录未记录'}</small>
      </div>
      <span className={version.review.decision === 'PASS' ? 'pill pill-approved' : 'pill pill-rejected'}>
        {version.review.decision === 'PASS' ? '审核通过' : '审核未通过'}
      </span>
    </div>
    <h3 className="review-task-copy-title">{version.copy.title}</h3>
    <div className="review-copy-body">{version.copy.body}</div>
    <div className="review-copy-tags" aria-label={`${label}标签`}>
      {version.copy.tags.map((tag) => <span className="pill" key={tag}>
        {tag.startsWith('#') ? tag : `#${tag}`}
      </span>)}
    </div>
    <CopyImagePlan label={label} imagePlan={version.imagePlan} />
    <div className="copy-review-summary">
      <div><CheckCircle2 aria-hidden="true" size={15} /><strong>质检摘要</strong></div>
      <p>{version.review.summary}</p>
      {version.review.issues.length > 0 && <ul>
        {version.review.issues.map((issue) => <li key={`${issue.code}-${issue.message}`}>
          <strong>{issue.code}</strong>：{issue.message}
        </li>)}
      </ul>}
    </div>
  </article>;
}

function CopyGenerationTimingBreakdown({
  timing,
  revisionAttempted,
}: {
  timing: CopyGenerationTiming | null;
  revisionAttempted: boolean;
}) {
  return <section className="copy-timing-breakdown" aria-labelledby="copy-timing-heading">
    <div className="copy-timing-head">
      <div><Clock3 aria-hidden="true" size={17} /><h3 id="copy-timing-heading">生成耗时</h3></div>
      <strong>{timing ? `总耗时 ${formatDuration(timing.totalMs)}` : '总耗时未记录'}</strong>
    </div>
    {timing ? <dl className="copy-timing-stage-grid">
      {TIMING_STAGES.map(({ field, label }) => <div key={field}>
        <dt>{label}</dt>
        <dd>{!revisionAttempted && ['reviewedGenerationMs', 'reviewedReviewMs'].includes(field)
          ? '未执行'
          : formatDuration(timing[field])}</dd>
      </div>)}
    </dl> : <p>这条历史记录生成于耗时统计上线前，仍可正常查看和对比文案。</p>}
  </section>;
}

export function CopyGenerationComparison({
  result,
  onClose,
  onMessage,
}: {
  result: CopyGenerationResult;
  onClose: () => void;
  onMessage: (message: string, isError: boolean) => void;
}) {
  const router = useRouter();
  const revisionAttempted = result.generation.revisionAttempted;
  const activeVersionLabel = revisionAttempted ? '质检版' : '当前版';
  const reviewedCopyPassed = result.reviewed.review.decision === 'PASS';
  const blockingIssues = result.reviewed.review.issues
    .filter((issue) => issue.severity === 'BLOCKING');

  async function copyVersion(label: string, copy: CopyText) {
    try {
      await navigator.clipboard.writeText(copyText(copy));
      onMessage(`${label}的标题、正文和标签已复制。`, false);
    } catch {
      onMessage('复制失败，请手动选择文案内容。', true);
    }
  }

  function importReviewedCopy() {
    if (!reviewedCopyPassed) {
      onMessage(`${activeVersionLabel}尚未通过，不能导入图片生成。`, true);
      return;
    }
    try {
      writeImageGenerationDraft(window.sessionStorage, createImageGenerationDraft({
        query: result.query,
        copy: result.reviewed.copy,
        imagePlan: result.reviewed.imagePlan,
      }));
      router.push('/image-generation');
    } catch {
      onMessage('导入图片模块失败，请刷新页面后重试。', true);
    }
  }

  return <section className="panel" aria-labelledby="copy-result-heading" aria-live="polite">
    <div className="panel-head copy-comparison-head">
      <div>
        <span className="section-kicker">Saved comparison #{result.id}</span>
        <h2 id="copy-result-heading">{result.query}</h2>
        <small>{new Date(result.createdAt).toLocaleString('zh-CN')} · {result.generation.imageCount} 页配图策划</small>
      </div>
      <div className="inline">
        <button className="button small" type="button" onClick={() => copyVersion(revisionAttempted ? '原始版' : '当前版', result.original.copy)}>
          <Copy aria-hidden="true" size={14} />{revisionAttempted ? '复制原始版' : '复制当前版'}
        </button>
        {revisionAttempted && <button className="button small" type="button" onClick={() => copyVersion('质检版', result.reviewed.copy)}>
          <Copy aria-hidden="true" size={14} />复制质检版
        </button>}
        <button
          className="button small primary"
          type="button"
          disabled={!reviewedCopyPassed}
          aria-describedby={!reviewedCopyPassed ? 'copy-validation-note' : undefined}
          onClick={importReviewedCopy}
        >
          导入{activeVersionLabel}到图片生成<ArrowRight aria-hidden="true" size={14} />
        </button>
        <button className="button small" type="button" onClick={onClose}>
          <RotateCcw aria-hidden="true" size={14} />关闭对比
        </button>
      </div>
    </div>
    {!reviewedCopyPassed && <div className="notice error copy-validation-notice" id="copy-validation-note" role="alert">
      <div><CircleAlert aria-hidden="true" size={17} /><strong>质检未通过，结果已保留</strong></div>
      <p>{result.reviewed.review.summary}</p>
      {blockingIssues.length > 0 && <ul>
        {blockingIssues.map((issue) => <li key={`${issue.code}-${issue.message}`}>
          <strong>{issue.code}</strong>：{issue.message}
        </li>)}
      </ul>}
      <p>文案仍可查看、复制并进行人工二次质检；人工确认前不能导入图片生成。</p>
    </div>}
    <CopyGenerationTimingBreakdown
      timing={result.generation.timing}
      revisionAttempted={revisionAttempted}
    />
    <div className={`copy-comparison-grid${revisionAttempted ? '' : ' single'}`}>
      <CopyVersion label={revisionAttempted ? '原始版' : '当前版'} version={result.original} />
      {revisionAttempted && <CopyVersion label="质检版" version={result.reviewed} />}
    </div>
  </section>;
}
