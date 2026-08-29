'use client';

import { useEffect, useState } from 'react';

import { buildTaskTiming } from '../../src/admin/task-timing.mjs';
import { formatCompletionTime, formatDuration } from './time-format';

type TaskTimingProps = {
  task: {
    status: string;
    processingStartedAt: string | null;
    finishedAt: string | null;
    queuePosition: number | null;
    config?: { imageCount?: number } | null;
  };
  timingStats: {
    serverNow: string;
    sampleSize: number;
    typicalDurationMs: number | null;
    byImageCount: Record<string, { sampleSize: number; typicalDurationMs: number }>;
    activeTasks: Array<{ processingStartedAt: string | null; imageCount: number }>;
  };
};

function estimateTitle(sampleSize: number, scope: string | null) {
  if (sampleSize < 1) return undefined;
  const source = scope === 'same_image_count' ? '同图片数真实完成任务' : '真实完成任务';
  return `估算基于最近 ${sampleSize} 条${source}的典型耗时`;
}

export function TaskTiming({ task, timingStats }: TaskTimingProps) {
  const serverNow = Date.parse(timingStats.serverNow);
  const [nowMs, setNowMs] = useState(Number.isFinite(serverNow) ? serverNow : 0);

  useEffect(() => {
    if (task.status !== 'processing') return undefined;
    const update = () => setNowMs(Date.now());
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [task.status]);

  const timing = buildTaskTiming(task, timingStats, { now: new Date(nowMs) });
  const completionTime = formatCompletionTime(timing.estimatedCompletionAt);

  if (task.status === 'completed') {
    return <div className="task-timing" aria-live="off">
      <span className="task-timing-primary">{timing.actualDurationMs === null
        ? '实际耗时未记录'
        : `实际用时 ${formatDuration(timing.actualDurationMs)}`}</span>
      {timing.actualDurationMs === null && <span className="task-timing-secondary">升级后的新任务会自动记录</span>}
    </div>;
  }

  if (task.status === 'failed') {
    return <div className="task-timing" aria-live="off">
      <span className="task-timing-primary">{timing.actualDurationMs === null
        ? '失败耗时未记录'
        : `失败前运行 ${formatDuration(timing.actualDurationMs)}`}</span>
    </div>;
  }

  if (task.status === 'processing') {
    return <div className="task-timing" aria-live="off" title={estimateTitle(timing.estimateSampleSize, timing.estimateScope)}>
      <span className="task-timing-primary">已运行 {formatDuration(timing.elapsedMs)}</span>
      <span className="task-timing-secondary">{timing.estimatedDurationMs === null
        ? '首条完成后自动估算'
        : timing.estimatedRemainingMs === 0
          ? '已超过历史典型耗时，仍在处理'
          : `预计还需 ${formatDuration(timing.estimatedRemainingMs)} · 约 ${completionTime} 完成`}</span>
    </div>;
  }

  return <div className="task-timing" aria-live="off" title={estimateTitle(timing.estimateSampleSize, timing.estimateScope)}>
    <span className="task-timing-primary">{timing.queuePosition
      ? `排队第 ${timing.queuePosition} 条`
      : '等待进入队列'}</span>
    <span className="task-timing-secondary">{timing.estimatedRemainingMs === null
      ? '首条完成后自动估算'
      : `预计 ${formatDuration(timing.estimatedRemainingMs)} 后 · 约 ${completionTime} 完成`}</span>
  </div>;
}
