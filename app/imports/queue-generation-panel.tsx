'use client';

import Link from 'next/link';
import { useState } from 'react';

import { useConfirmDialog } from '@/components/ui/confirm-dialog';

import { apiRequest } from '../components/api-client';
import { formatDuration } from '../components/time-format';

type LaunchState = 'IDLE' | 'STARTING' | 'STARTED' | 'ERROR';
const TASK_CONCURRENCY = 2;

export function QueueGenerationPanel({ maxTasks, timingStats }: { maxTasks: number; timingStats: any }) {
  const confirm = useConfirmDialog();
  const boundedMax = Math.max(0, Math.min(20, Math.floor(maxTasks || 0)));
  const typicalDurationMs = Number(timingStats?.typicalDurationMs) || null;
  const estimatedBatchDurationMs = typicalDurationMs === null
    ? null
    : typicalDurationMs * Math.ceil(boundedMax / TASK_CONCURRENCY);
  const [launchState, setLaunchState] = useState<LaunchState>('IDLE');
  const [message, setMessage] = useState('');

  async function startGeneration() {
    if (boundedMax < 1 || launchState === 'STARTING' || launchState === 'STARTED') return;
    const confirmed = await confirm({
      title: `启动最多 ${boundedMax} 条真实生成？`,
      description: '系统将按全局队列顺序运行，最多同时生产 2 条。每条基础流程会调用 4 次文本模型（Query 审核、正文生成、文本生成后审核、视觉规划）、3–5 次图片模型和 3–5 次视觉验收；验收失败的页面最多再生成 2 次，可能产生额外费用。',
      confirmLabel: '接受费用并启动',
    });
    if (!confirmed) return;

    setLaunchState('STARTING');
    setMessage('');
    try {
      const result = await apiRequest<any>('/api/worker-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          max: boundedMax,
          confirmation: 'LIVE_MODEL_COST_ACCEPTED',
        }),
      });
      setLaunchState('STARTED');
      setMessage(`后台生成已启动，本次最多处理 ${result.max} 条，同时生产 ${result.concurrency} 条。${estimatedBatchDurationMs === null
        ? '首条完成后会自动形成估算。'
        : `预计总耗时约 ${formatDuration(estimatedBatchDurationMs)}。`}可在内容审核查看每条数据的预计完成时间。`);
    } catch (error) {
      setLaunchState('ERROR');
      setMessage(error instanceof Error ? error.message : '启动生成失败');
    }
  }

  const buttonLabel = launchState === 'STARTING'
    ? '正在启动…'
    : launchState === 'STARTED'
      ? '生成已启动'
      : boundedMax > 0
        ? `启动后台生成（最多 ${boundedMax} 条）`
        : '没有可生成任务';

  return <section className="panel commit-panel generation-panel" aria-labelledby="queue-generation-title">
    <div>
      <h2 id="queue-generation-title">启动文案与图片生成</h2>
      <p className="subtle">按全局队列顺序异步处理，最多 2 条任务同时生产；网页可以继续使用，生成结果和失败原因在内容审核中查看。</p>
    </div>
    <div className="inline">
      <button
        className="button primary"
        type="button"
        disabled={boundedMax < 1 || launchState === 'STARTING' || launchState === 'STARTED'}
        onClick={startGeneration}
      >{buttonLabel}</button>
      <Link className="button small" href="/tasks">打开内容审核</Link>
    </div>
    <div className="generation-estimate" role="note">{typicalDurationMs === null
      ? '暂无升级后的真实完成样本；首条完成后会自动形成估算。'
      : <>按最近 {timingStats.sampleSize} 条真实任务：单条通常 {formatDuration(typicalDurationMs)}，按 2 条并发估算本次最多约 {formatDuration(estimatedBatchDurationMs)}。验收重试可能延长时间。</>}</div>
    {message && <div
      className={launchState === 'ERROR' ? 'notice error' : 'notice success'}
      role={launchState === 'ERROR' ? 'alert' : 'status'}
      aria-live="polite"
    >{message}</div>}
  </section>;
}
