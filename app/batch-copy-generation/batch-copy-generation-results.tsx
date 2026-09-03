import {
  CheckCircle2,
  CircleAlert,
  CircleStop,
  FileCheck2,
  LoaderCircle,
} from 'lucide-react';
import Link from 'next/link';

import type { CopyGenerationResult } from '../copy-generation/copy-generation-comparison';

export type BatchCopyItemStatus =
  | 'PENDING'
  | 'COPYING'
  | 'AWAITING_REVIEW'
  | 'APPROVING'
  | 'APPROVED'
  | 'FAILED'
  | 'STOPPED';

export type BatchCopyItem = {
  query: string;
  status: BatchCopyItemStatus;
  copyResult: CopyGenerationResult | null;
  error: string;
  reviewError: string;
};

export type BatchCopySummary = { generated: number; failed: number; stopped: number };

const STATUS_LABELS: Record<BatchCopyItemStatus, string> = {
  PENDING: '等待处理',
  COPYING: '生成文案',
  AWAITING_REVIEW: '待人工质检',
  APPROVING: '保存质检结果',
  APPROVED: '人工质检通过',
  FAILED: '生成失败',
  STOPPED: '已停止',
};

export function batchCopyResultMessage(summary: BatchCopySummary) {
  if (summary.stopped > 0) return `批量文案已停止：生成 ${summary.generated} 条，失败 ${summary.failed} 条，未继续 ${summary.stopped} 条。`;
  if (summary.failed === 0) return `批量文案已完成：共生成 ${summary.generated} 条，等待人工质检。`;
  return `批量文案已结束：生成 ${summary.generated} 条，失败 ${summary.failed} 条。`;
}

function statusClass(status: BatchCopyItemStatus) {
  if (status === 'APPROVED') return 'pill pill-approved';
  if (status === 'FAILED') return 'pill pill-rejected';
  if (status === 'COPYING' || status === 'APPROVING') return 'pill batch-generation-active-pill';
  return 'pill';
}

export function BatchCopyGenerationResults({
  batchName,
  items,
  busy,
  stopRequested,
  summary,
  onStop,
  onApprove,
}: {
  batchName: string;
  items: BatchCopyItem[];
  busy: boolean;
  stopRequested: boolean;
  summary: BatchCopySummary | null;
  onStop: () => void;
  onApprove: (index: number) => void;
}) {
  const settledCount = items.filter((item) => !['PENDING', 'COPYING'].includes(item.status)).length;

  return <section className="panel batch-generation-results" aria-labelledby="batch-copy-results-heading">
    <div className="panel-head batch-generation-results-head">
      <div><span className="section-kicker">Copy progress</span><h2 id="batch-copy-results-heading">文案与质检</h2>{batchName && <span className="pill">批次：{batchName}</span>}</div>
      {busy && <LoaderCircle aria-hidden="true" className="animate-spin" size={20} />}
    </div>

    {items.length === 0
      ? <div className="batch-generation-empty">
          <FileCheck2 aria-hidden="true" size={26} />
          <strong>还没有批量文案</strong>
          <span>提交后会在这里显示生成状态，并可逐条查看和确认文案。</span>
        </div>
      : <>
          <div className="batch-generation-progress" aria-live="polite">
            <div>
              <strong>{settledCount}/{items.length} 条已生成或结束</strong>
              <span>{busy ? stopRequested ? '等待当前条结束后停止' : '正在顺序生成文案' : summary ? batchCopyResultMessage(summary) : batchName ? '已恢复该批次记录' : '已恢复待人工质检记录'}</span>
            </div>
            <progress value={settledCount} max={items.length} aria-label={`批量文案进度：${settledCount}/${items.length}`} />
            {busy && <button className="button small" type="button" disabled={stopRequested} onClick={onStop}>
              <CircleStop aria-hidden="true" size={15} />{stopRequested ? '已请求停止' : '完成当前条后停止'}
            </button>}
          </div>
          <ol className="batch-generation-list">
            {items.map((item, index) => <li className="batch-generation-item" key={`${index}-${item.query}`}>
              <div className="batch-generation-item-head">
                <span className="batch-generation-index">{index + 1}</span>
                <div><strong>{item.copyResult?.copy.title || item.query}</strong>{item.copyResult && <span>{item.query}</span>}</div>
                <span className={statusClass(item.status)}>
                  {(item.status === 'COPYING' || item.status === 'APPROVING') && <LoaderCircle aria-hidden="true" className="animate-spin" size={12} />}
                  {item.status === 'APPROVED' && <CheckCircle2 aria-hidden="true" size={12} />}
                  {item.status === 'FAILED' && <CircleAlert aria-hidden="true" size={12} />}
                  {STATUS_LABELS[item.status]}
                </span>
              </div>
              {item.error && <p className="batch-generation-error" role="alert">文案阶段：{item.error}</p>}
              {item.copyResult && <details className="batch-copy-review">
                <summary>展开质检内容</summary>
                <h3>{item.copyResult.copy.title}</h3>
                <p>{item.copyResult.copy.body}</p>
                <div className="review-copy-tags" aria-label="文案标签">
                  {item.copyResult.copy.tags.map((tag) => <span className="pill" key={tag}>{tag.startsWith('#') ? tag : `#${tag}`}</span>)}
                </div>
                <div className="batch-copy-plan">
                  <strong>配图策划 · {item.copyResult.imagePlan.length} 页</strong>
                  <ol>{item.copyResult.imagePlan.map((page, pageIndex) => <li key={`${page.kind}-${pageIndex}`}>
                    <span>{pageIndex + 1}. {page.headline}</span>
                    <small>{page.subtitle}</small>
                    <ul>{page.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul>
                  </li>)}</ol>
                </div>
                <small>文案记录 #{item.copyResult.id}</small>
              </details>}
              {item.reviewError && <p className="batch-generation-error" role="alert">{item.reviewError}</p>}
              {(item.status === 'AWAITING_REVIEW' || item.status === 'APPROVING' || item.status === 'APPROVED') && <div className="batch-generation-item-meta">
                <button className="button small" type="button" disabled={item.status !== 'AWAITING_REVIEW'} onClick={() => onApprove(index)}>
                  <FileCheck2 aria-hidden="true" size={14} />{item.status === 'APPROVED' ? '人工质检通过' : item.status === 'APPROVING' ? '正在保存…' : '确认人工质检通过'}
                </button>
              </div>}
            </li>)}
          </ol>
          <div className="batch-generation-next-step">
            <span>只有人工质检通过的记录会出现在批量生图中。</span>
            <Link className="button small primary" href="/batch-image-generation">前往批量生图</Link>
          </div>
        </>}
  </section>;
}
