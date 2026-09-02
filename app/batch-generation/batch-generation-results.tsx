import {
  CheckCircle2,
  CircleAlert,
  CircleStop,
  ExternalLink,
  Images,
  LoaderCircle,
} from 'lucide-react';

import type { ImageGenerationResult } from '../image-generation/use-image-generation-run';

export type BatchItemStatus = 'PENDING' | 'COPYING' | 'IMAGING' | 'COMPLETED' | 'FAILED' | 'STOPPED';

export type BatchItem = {
  query: string;
  status: BatchItemStatus;
  copyId: number | null;
  copyTitle: string;
  imageResult: ImageGenerationResult | null;
  failedStage: '文案' | '图片' | null;
  error: string;
};

export type BatchSummary = {
  completed: number;
  failed: number;
  stopped: number;
};

const STATUS_LABELS: Record<BatchItemStatus, string> = {
  PENDING: '等待处理',
  COPYING: '生成文案',
  IMAGING: '生成图片',
  COMPLETED: '图文已完成',
  FAILED: '生成失败',
  STOPPED: '已停止',
};

export function batchResultMessage(summary: BatchSummary) {
  if (summary.stopped > 0) {
    return `批量生成已停止：完成 ${summary.completed} 条，失败 ${summary.failed} 条，未继续 ${summary.stopped} 条。`;
  }
  if (summary.failed === 0) return `批次已完成：共生成 ${summary.completed} 条图文。`;
  return `批量生成结束：完成 ${summary.completed} 条，失败 ${summary.failed} 条。`;
}

function statusClass(status: BatchItemStatus) {
  if (status === 'COMPLETED') return 'pill pill-approved';
  if (status === 'FAILED') return 'pill pill-rejected';
  if (status === 'COPYING' || status === 'IMAGING') return 'pill batch-generation-active-pill';
  return 'pill';
}

export function BatchGenerationResults({
  items,
  busy,
  stopRequested,
  summary,
  onStop,
}: {
  items: BatchItem[];
  busy: boolean;
  stopRequested: boolean;
  summary: BatchSummary | null;
  onStop: () => void;
}) {
  const settledCount = items.filter((item) => (
    item.status === 'COMPLETED' || item.status === 'FAILED' || item.status === 'STOPPED'
  )).length;

  return <section className="panel batch-generation-results" aria-labelledby="batch-generation-results-heading">
    <div className="panel-head batch-generation-results-head">
      <div>
        <span className="section-kicker">Batch progress</span>
        <h2 id="batch-generation-results-heading">逐条进度</h2>
      </div>
      {busy && <LoaderCircle aria-hidden="true" className="animate-spin" size={20} />}
    </div>

    {items.length === 0
      ? <div className="batch-generation-empty">
          <Images aria-hidden="true" size={26} />
          <strong>还没有批量任务</strong>
          <span>提交后会在这里显示每条文案与图片的生成状态。</span>
        </div>
      : <>
          <div className="batch-generation-progress" aria-live="polite">
            <div>
              <strong>{settledCount}/{items.length} 条已处理</strong>
              <span>{busy ? stopRequested ? '等待当前条结束后停止' : '正在顺序生成' : summary ? batchResultMessage(summary) : '准备开始'}</span>
            </div>
            <progress value={settledCount} max={items.length} aria-label={`批量生成进度：${settledCount}/${items.length}`} />
            {busy && <button className="button small" type="button" disabled={stopRequested} onClick={onStop}>
              <CircleStop aria-hidden="true" size={15} />
              {stopRequested ? '已请求停止' : '完成当前条后停止'}
            </button>}
          </div>
          <ol className="batch-generation-list">
            {items.map((item, index) => <li key={`${index}-${item.query}`} className="batch-generation-item">
              <div className="batch-generation-item-head">
                <span className="batch-generation-index">{index + 1}</span>
                <div>
                  <strong>{item.copyTitle || item.query}</strong>
                  {item.copyTitle && <span>{item.query}</span>}
                </div>
                <span className={statusClass(item.status)}>
                  {(item.status === 'COPYING' || item.status === 'IMAGING') && <LoaderCircle aria-hidden="true" className="animate-spin" size={12} />}
                  {item.status === 'COMPLETED' && <CheckCircle2 aria-hidden="true" size={12} />}
                  {item.status === 'FAILED' && <CircleAlert aria-hidden="true" size={12} />}
                  {STATUS_LABELS[item.status]}
                </span>
              </div>
              {item.status === 'FAILED' && <p className="batch-generation-error" role="alert">
                {item.failedStage}阶段：{item.error}
              </p>}
              {(item.copyId || item.imageResult) && <div className="batch-generation-item-meta">
                {item.copyId && <span>文案记录 #{item.copyId}</span>}
                {item.imageResult && <span>{item.imageResult.imageCount} 张图片 · {item.imageResult.mode === 'MOCK' ? 'Mock' : 'Live'}</span>}
                {item.imageResult?.images[0]?.url && <a href={item.imageResult.images[0].url} target="_blank" rel="noopener noreferrer">
                  打开首图<ExternalLink aria-hidden="true" size={12} />
                </a>}
              </div>}
            </li>)}
          </ol>
        </>}
  </section>;
}
