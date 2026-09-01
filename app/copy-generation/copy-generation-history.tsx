'use client';

import { CircleAlert, FileText, History, LoaderCircle } from 'lucide-react';

import { formatDuration } from '../components/time-format';
import type {
  CopyGenerationResult,
  CopyGenerationTimingStatistics,
} from './copy-generation-comparison';
import type { CopyGenerationJob } from './use-copy-generation-history';

function CopyGenerationJobs({ jobs }: { jobs: CopyGenerationJob[] }) {
  if (jobs.length === 0) return null;
  const hasRunningJobs = jobs.some((job) => job.status === 'RUNNING');
  return <section className="copy-job-section" aria-labelledby="copy-job-heading" aria-live="polite" aria-busy={hasRunningJobs}>
    <div className="copy-job-section-head">
      <h3 id="copy-job-heading">生成任务</h3>
      <span>{jobs.length} 条</span>
    </div>
    <ol className="copy-job-list">
      {jobs.map((job) => <li className="copy-job-card" data-status={job.status} key={job.id}>
        <div className="copy-job-row">
          <strong>{job.query}</strong>
          <span className={job.status === 'RUNNING' ? 'pill pill-processing' : 'pill pill-failed'}>
            {job.status === 'RUNNING'
              ? <><LoaderCircle aria-hidden="true" className="animate-spin" size={12} />生成中</>
              : <><CircleAlert aria-hidden="true" size={12} />生成失败</>}
          </span>
        </div>
        <span className="copy-job-meta">任务 #{job.id} · {new Date(job.createdAt).toLocaleString('zh-CN')}</span>
        {job.error && <p className="copy-job-error" role="alert">{job.error}</p>}
      </li>)}
    </ol>
  </section>;
}

function TimingStatistics({ statistics }: { statistics: CopyGenerationTimingStatistics | null }) {
  if (!statistics || statistics.sampleSize < 1) {
    return <p className="copy-timing-empty">新生成的文案会自动记录总耗时和各阶段耗时。</p>;
  }
  return <dl className="copy-timing-statistics" aria-label="文案生成耗时统计">
    <div><dt>有效样本</dt><dd>{statistics.sampleSize} 条</dd></div>
    <div><dt>平均耗时</dt><dd>{formatDuration(statistics.averageMs)}</dd></div>
    <div><dt>P50</dt><dd>{formatDuration(statistics.p50Ms)}</dd></div>
    <div><dt>P95</dt><dd>{formatDuration(statistics.p95Ms)}</dd></div>
  </dl>;
}

export function CopyGenerationHistory({
  records,
  jobs,
  statistics,
  selectedId,
  loading,
  error,
  onSelect,
}: {
  records: CopyGenerationResult[];
  jobs: CopyGenerationJob[];
  statistics: CopyGenerationTimingStatistics | null;
  selectedId: number | null;
  loading: boolean;
  error: string;
  onSelect: (record: CopyGenerationResult) => void;
}) {
  return <aside className="panel copy-generation-history" aria-labelledby="copy-history-heading">
    <div className="panel-head">
      <div><span className="section-kicker">Saved history</span><h2 id="copy-history-heading">已保存记录</h2></div>
      <History aria-hidden="true" size={20} />
    </div>
    {!loading && !error && <CopyGenerationJobs jobs={jobs} />}
    {!loading && !error && <TimingStatistics statistics={statistics} />}
    {loading ? <div className="empty-state" role="status">正在读取历史记录…</div>
      : error ? <div className="notice error" role="alert">{error}</div>
        : records.length === 0 ? <div className="empty-state">
          <FileText aria-hidden="true" size={28} />
          <p>还没有已保存的双版本文案。</p>
        </div> : <ol className="copy-history-list">
          {records.map((record) => <li key={record.id}>
            <button type="button" aria-pressed={selectedId === record.id} onClick={() => onSelect(record)}>
              <strong>{record.query}</strong>
              {record.reviewed.review.decision === 'REJECT'
                && <span className="pill pill-rejected">待人工复核</span>}
              <span>#{record.id} · {new Date(record.createdAt).toLocaleString('zh-CN')} · {record.generation.timing
                ? formatDuration(record.generation.timing.totalMs)
                : '耗时未记录'}</span>
            </button>
          </li>)}
        </ol>}
  </aside>;
}
