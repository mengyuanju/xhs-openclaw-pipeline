'use client';

import dynamic from 'next/dynamic';
import { RefreshCw } from 'lucide-react';
import type { Statistics, StateGroup } from './types';
export const Chart = dynamic(() => import('./statistics-chart'), { ssr: false,
  loading: () => <div className="job-stats-chart job-stats-loading">图表加载中…</div> });
export const STATE_LABELS: Record<StateGroup, string> = {
  queued: '排队中', running: '生成中', copyReview: '待文案审核', imageReview: '待图片审核',
  failed: '执行失败', completed: '已完成', cancelled: '已废弃',
};
export const ROLE_LABELS: Record<string, string> = { USER: '作业员', REVIEWER: '审核员', ADMIN: '管理员' };
export const number = (value: number | undefined | null) => value == null ? '—' : value.toLocaleString('zh-CN');
export const duration = (ms: number | null | undefined) => ms == null ? '暂无样本'
  : ms < 60_000 ? `${(ms / 1000).toFixed(1)} 秒` : ms < 3_600_000 ? `${(ms / 60_000).toFixed(1)} 分` : `${(ms / 3_600_000).toFixed(1)} 小时`;
export const percent = (value: number | null | undefined) => value == null ? '暂无样本' : `${(value * 100).toFixed(1)}%`;
export function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="job-stats-metric"><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>;
}
export function StatisticsStatus({ data, error, busy, cooldown, refresh }: {
  data: Statistics | null; error: string; busy: boolean; cooldown: boolean; refresh: () => void;
}) {
  const progress = data?.progress;
  const status = error || data?.notice || (!data || data.state === 'loading'
    ? `正在汇总${progress ? ` ${progress.loaded} / ${progress.total ?? '…'} 项` : '…'}`
    : data.state === 'refreshing' ? `正在更新 ${progress?.loaded} / ${progress?.total} 项，当前显示上次完整结果`
      : `更新于 ${new Date(data.updatedAt!).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`);
  return <div className="job-stats-status">
    <span role="status" className={error || data?.notice ? 'job-stats-warning' : ''}>{status}</span>
    <button className="button small" type="button" disabled={busy || cooldown} onClick={refresh}>
      <RefreshCw size={13} aria-hidden="true" className={busy ? 'animate-spin' : ''} />{cooldown ? '稍后可刷新' : '刷新统计'}
    </button>
  </div>;
}
