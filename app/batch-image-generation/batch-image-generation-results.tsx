import {
  CheckCircle2,
  CircleAlert,
  CircleStop,
  ExternalLink,
  Images,
  LoaderCircle,
} from 'lucide-react';

import type { CopyGenerationResult } from '../copy-generation/copy-generation-comparison';
import type { ImageGenerationResult } from '../image-generation/use-image-generation-run';

export type BatchImageItemStatus = 'PENDING' | 'IMAGING' | 'COMPLETED' | 'FAILED' | 'STOPPED';
export type BatchImageItem = {
  copyResult: CopyGenerationResult;
  status: BatchImageItemStatus;
  runId: string | null;
  imageResult: ImageGenerationResult | null;
  error: string;
};
export type BatchImageSummary = { completed: number; failed: number; stopped: number };

const STATUS_LABELS: Record<BatchImageItemStatus, string> = {
  PENDING: '等待处理',
  IMAGING: '生成图片',
  COMPLETED: '图片已完成',
  FAILED: '生成失败',
  STOPPED: '已停止',
};

export function batchImageResultMessage(summary: BatchImageSummary) {
  if (summary.stopped > 0) return `批量图片已停止：完成 ${summary.completed} 条，失败 ${summary.failed} 条，未继续 ${summary.stopped} 条。`;
  if (summary.failed === 0) return `批量图片已完成：共完成 ${summary.completed} 条。`;
  return `批量图片已结束：完成 ${summary.completed} 条，失败 ${summary.failed} 条。`;
}

function statusClass(status: BatchImageItemStatus) {
  if (status === 'COMPLETED') return 'pill pill-approved';
  if (status === 'FAILED') return 'pill pill-rejected';
  if (status === 'IMAGING') return 'pill batch-generation-active-pill';
  return 'pill';
}

export function BatchImageGenerationResults({ items, busy, stopRequested, summary, onStop }: {
  items: BatchImageItem[];
  busy: boolean;
  stopRequested: boolean;
  summary: BatchImageSummary | null;
  onStop: () => void;
}) {
  const settledCount = items.filter((item) => ['COMPLETED', 'FAILED', 'STOPPED'].includes(item.status)).length;
  return <section className="panel batch-generation-results" aria-labelledby="batch-image-results-heading">
    <div className="panel-head batch-generation-results-head">
      <div><span className="section-kicker">Image progress</span><h2 id="batch-image-results-heading">图片生成进度</h2></div>
      {busy && <LoaderCircle aria-hidden="true" className="animate-spin" size={20} />}
    </div>
    {items.length === 0
      ? <div className="batch-generation-empty"><Images aria-hidden="true" size={26} /><strong>还没有图片批次</strong><span>选择已质检文案后，图片进度会显示在这里。</span></div>
      : <>
          <div className="batch-generation-progress" aria-live="polite">
            <div><strong>{settledCount}/{items.length} 条已处理</strong><span>{busy ? stopRequested ? '等待当前条结束后停止' : '正在顺序生成图片' : summary ? batchImageResultMessage(summary) : '准备开始'}</span></div>
            <progress value={settledCount} max={items.length} aria-label={`批量图片进度：${settledCount}/${items.length}`} />
            {busy && <button className="button small" type="button" disabled={stopRequested} onClick={onStop}><CircleStop aria-hidden="true" size={15} />{stopRequested ? '已请求停止' : '完成当前条后停止'}</button>}
          </div>
          <ol className="batch-generation-list">
            {items.map((item, index) => <li className="batch-generation-item" key={item.copyResult.id}>
              <div className="batch-generation-item-head">
                <span className="batch-generation-index">{index + 1}</span>
                <div><strong>{item.copyResult.copy.title}</strong><span>{item.copyResult.query}</span></div>
                <span className={statusClass(item.status)}>
                  {item.status === 'IMAGING' && <LoaderCircle aria-hidden="true" className="animate-spin" size={12} />}
                  {item.status === 'COMPLETED' && <CheckCircle2 aria-hidden="true" size={12} />}
                  {item.status === 'FAILED' && <CircleAlert aria-hidden="true" size={12} />}
                  {STATUS_LABELS[item.status]}
                </span>
              </div>
              {item.error && <p className="batch-generation-error" role="alert">图片阶段：{item.error}</p>}
              <div className="batch-generation-item-meta">
                <span>文案记录 #{item.copyResult.id}</span>
                {item.imageResult && <span>{item.imageResult.imageCount} 张</span>}
                {item.runId && <a href={`/image-generation?runId=${encodeURIComponent(item.runId)}`} target="_blank" rel="noopener noreferrer">查看运行记录<ExternalLink aria-hidden="true" size={12} /></a>}
                {item.imageResult?.images[0]?.url && <a href={item.imageResult.images[0].url} target="_blank" rel="noopener noreferrer">打开首图<ExternalLink aria-hidden="true" size={12} /></a>}
              </div>
            </li>)}
          </ol>
        </>}
  </section>;
}
