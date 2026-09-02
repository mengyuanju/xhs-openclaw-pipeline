'use client';

import {
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Copy,
  LoaderCircle,
  RotateCcw,
  UserCheck,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { useConfirmDialog } from '@/components/ui/confirm-dialog';

import { apiRequest } from '../components/api-client';
import { formatDuration } from '../components/time-format';
import {
  createImageGenerationDraft,
  writeImageGenerationDraft,
} from '../image-generation/image-generation-draft';
import {
  CopyGenerationResearchPanel,
  type CopyGenerationResearch,
} from './copy-generation-research';

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
  manualReview: {
    decision: 'APPROVED';
    reviewedAt: string;
    reviewedBy: string;
  } | null;
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
    research: CopyGenerationResearch | null;
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
  onResultChange,
}: {
  result: CopyGenerationResult;
  onClose: () => void;
  onMessage: (message: string, isError: boolean) => void;
  onResultChange: (result: CopyGenerationResult) => void;
}) {
  const confirm = useConfirmDialog();
  const router = useRouter();
  const [manualReviewBusy, setManualReviewBusy] = useState(false);
  const revisionAttempted = result.generation.revisionAttempted;
  const activeVersionLabel = revisionAttempted ? '质检版' : '当前版';
  const reviewedCopyPassed = result.reviewed.review.decision === 'PASS';
  const manuallyApproved = result.manualReview?.decision === 'APPROVED';
  const canImportReviewedCopy = reviewedCopyPassed || manuallyApproved;
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

  async function approveReviewedCopyManually() {
    if (reviewedCopyPassed || manuallyApproved || manualReviewBusy) return;
    if (!await confirm({
      title: '确认人工审核通过？',
      description: `请确认你已完整检查${activeVersionLabel}的正文、事实依据、风险边界和配图策划。确认后会保留自动质检问题，但允许将当前文案导入图片生成。`,
      confirmLabel: '确认人工审核通过',
    })) return;
    setManualReviewBusy(true);
    try {
      const approved = await apiRequest<CopyGenerationResult>(
        `/api/copy-generations/${result.id}/manual-review`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: 'APPROVED' }),
        },
      );
      onResultChange(approved);
      onMessage('已保存本次人工确认，现在可以导入图片生成；刷新页面后状态仍会保留。', false);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : '人工审核结果保存失败，请重试。', true);
    } finally {
      setManualReviewBusy(false);
    }
  }

  function importReviewedCopy() {
    if (!canImportReviewedCopy) {
      onMessage(`${activeVersionLabel}尚未通过自动质检或人工确认，不能导入图片生成。`, true);
      document.getElementById('copy-manual-review-button')?.focus();
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
          aria-disabled={!canImportReviewedCopy}
          aria-describedby={!canImportReviewedCopy ? 'copy-validation-note' : undefined}
          onClick={importReviewedCopy}
        >
          导入{activeVersionLabel}到图片生成<ArrowRight aria-hidden="true" size={14} />
        </button>
        <button className="button small" type="button" onClick={onClose}>
          <RotateCcw aria-hidden="true" size={14} />关闭对比
        </button>
      </div>
    </div>
    {!reviewedCopyPassed && <div
      className={`notice copy-validation-notice${manuallyApproved ? '' : ' error'}`}
      id="copy-validation-note"
      role={manuallyApproved ? 'status' : 'alert'}
    >
      <div><CircleAlert aria-hidden="true" size={17} /><strong>{manuallyApproved
        ? '自动质检未通过，已人工确认'
        : '质检未通过，结果已保留'}</strong></div>
      <p>{result.reviewed.review.summary}</p>
      {blockingIssues.length > 0 && <ul>
        {blockingIssues.map((issue) => <li key={`${issue.code}-${issue.message}`}>
          <strong>{issue.code}</strong>：{issue.message}
        </li>)}
      </ul>}
      <p>{manuallyApproved
        ? '已完成本次人工确认；自动质检证据仍保留，现在可导入图片生成。'
        : '文案仍可查看、复制并进行人工二次质检；人工确认前不能导入图片生成。'}</p>
      <div className="copy-manual-review-action">
        <button
          className="button small"
          id="copy-manual-review-button"
          type="button"
          aria-pressed={manuallyApproved}
          aria-busy={manualReviewBusy}
          disabled={manualReviewBusy || manuallyApproved}
          onClick={approveReviewedCopyManually}
        >
          {manualReviewBusy
            ? <><LoaderCircle aria-hidden="true" className="animate-spin" size={14} />正在保存审核结果…</>
            : manuallyApproved
            ? <><CheckCircle2 aria-hidden="true" size={14} />已人工审核通过</>
            : <><UserCheck aria-hidden="true" size={14} />人工审核通过</>}
        </button>
        <span>{manuallyApproved
          ? '已保留自动质检问题，可继续生成图片。'
          : '仅在你已逐项复核当前文案后确认。'}</span>
      </div>
    </div>}
    <CopyGenerationTimingBreakdown
      timing={result.generation.timing}
      revisionAttempted={revisionAttempted}
    />
    <CopyGenerationResearchPanel research={result.generation.research} />
    <div className={`copy-comparison-grid${revisionAttempted ? '' : ' single'}`}>
      <CopyVersion label={revisionAttempted ? '原始版' : '当前版'} version={result.original} />
      {revisionAttempted && <CopyVersion label="质检版" version={result.reviewed} />}
    </div>
  </section>;
}
