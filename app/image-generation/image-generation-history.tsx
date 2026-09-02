'use client';

import {
  CircleAlert,
  CircleCheck,
  History,
  Image as ImageIcon,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react';

import type { ImageGenerationHistoryRecord } from './use-image-generation-history';

function statusPill(record: ImageGenerationHistoryRecord) {
  if (record.status === 'RUNNING') {
    return <span className="pill pill-processing">
      <LoaderCircle aria-hidden="true" className="animate-spin" size={12} />生成中
    </span>;
  }
  if (record.status === 'FAILED') {
    if (record.canResume) {
      return <span className="pill pill-processing">
        <RefreshCw aria-hidden="true" size={12} />待重新验收
      </span>;
    }
    return <span className="pill pill-failed">
      <CircleAlert aria-hidden="true" size={12} />生成失败
    </span>;
  }
  return <span className="pill pill-approved">
    <CircleCheck aria-hidden="true" size={12} />已完成
  </span>;
}

function runTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未记录' : date.toLocaleString('zh-CN');
}

export function ImageGenerationHistory({
  records,
  total,
  selectedRunId,
  openingRunId,
  loading,
  error,
  disabled,
  onSelect,
  onRefresh,
}: {
  records: ImageGenerationHistoryRecord[];
  total: number;
  selectedRunId: string | null;
  openingRunId: string | null;
  loading: boolean;
  error: string;
  disabled: boolean;
  onSelect: (record: ImageGenerationHistoryRecord) => void;
  onRefresh: () => void;
}) {
  return <aside className="panel standalone-image-history" aria-labelledby="image-history-heading">
    <div className="panel-head standalone-image-history-head">
      <div>
        <span className="section-kicker">Saved runs</span>
        <h2 id="image-history-heading">图片生成历史</h2>
      </div>
      <button
        className="button small standalone-image-history-refresh"
        type="button"
        onClick={onRefresh}
        disabled={loading}
        aria-label="刷新图片生成历史"
      >
        <RefreshCw aria-hidden="true" className={loading ? 'animate-spin' : undefined} size={15} />
      </button>
    </div>
    {!loading && !error && <p className="standalone-image-history-count">已保存 {total} 次运行，按生成时间从新到旧排列。</p>}
    {loading ? <div className="empty-state" role="status">正在读取图片历史…</div>
      : error ? <div className="standalone-image-history-error">
        <div className="notice error" role="alert">{error}</div>
        <button className="button small" type="button" onClick={onRefresh}>重新读取</button>
      </div>
        : records.length === 0 ? <div className="empty-state">
          <ImageIcon aria-hidden="true" size={28} />
          <p>还没有图片生成记录。</p>
        </div>
          : <ol className="standalone-image-history-list" aria-live="polite">
            {records.map((record) => {
              const opening = openingRunId === record.runId;
              return <li key={record.runId}>
                <button
                  type="button"
                  aria-pressed={selectedRunId === record.runId}
                  disabled={disabled || opening}
                  onClick={() => onSelect(record)}
                >
                  <span className="standalone-image-history-row">
                    <strong>{record.title}</strong>
                    {opening
                      ? <span className="pill pill-processing"><LoaderCircle aria-hidden="true" className="animate-spin" size={12} />读取中</span>
                      : statusPill(record)}
                  </span>
                  <span className="standalone-image-history-query">{record.query}</span>
                  <span className="standalone-image-history-meta">
                    <time dateTime={record.startedAt}>{runTime(record.startedAt)}</time>
                    <span>{record.mode === 'LIVE' ? 'Live' : 'Mock'}</span>
                    <span>已生成 {record.generatedImages}/{record.imageCount}</span>
                    <span>已验收 {record.validatedImages}/{record.imageCount}</span>
                    {record.qcScore !== null && <span>QC {record.qcScore}/3</span>}
                  </span>
                  {record.error && <span className="standalone-image-history-failure">{record.error}</span>}
                </button>
              </li>;
            })}
          </ol>}
    <div className="standalone-image-history-footnote">
      <History aria-hidden="true" size={14} />点击记录可恢复图片、视觉布局和质检结果。
    </div>
  </aside>;
}
