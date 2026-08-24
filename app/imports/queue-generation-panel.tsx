'use client';

import Link from 'next/link';
import { useState } from 'react';

import { apiRequest } from '../components/api-client';

type LaunchState = 'IDLE' | 'STARTING' | 'STARTED' | 'ERROR';

export function QueueGenerationPanel({ maxTasks }: { maxTasks: number }) {
  const boundedMax = Math.max(0, Math.min(20, Math.floor(maxTasks || 0)));
  const [launchState, setLaunchState] = useState<LaunchState>('IDLE');
  const [message, setMessage] = useState('');

  async function startGeneration() {
    if (boundedMax < 1 || launchState === 'STARTING' || launchState === 'STARTED') return;
    const confirmed = window.confirm(
      `即将按全局队列顺序启动最多 ${boundedMax} 条真实生成。每条会调用 1 次文本模型和 3–5 次图片模型，可能产生费用。确认启动？`,
    );
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
      setMessage(`OpenClaw 后台生成已启动，本次最多处理 ${result.max} 条。`);
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
        ? `启动 OpenClaw 生成（最多 ${boundedMax} 条）`
        : '没有可生成任务';

  return <section className="panel commit-panel generation-panel" aria-labelledby="queue-generation-title">
    <div>
      <h2 id="queue-generation-title">4. 启动文案与图片生成</h2>
      <p className="subtle">按全局队列顺序异步处理；网页可以继续使用，生成结果和失败原因在内容审核中查看。</p>
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
    {message && <div
      className={launchState === 'ERROR' ? 'notice error' : 'notice success'}
      role={launchState === 'ERROR' ? 'alert' : 'status'}
      aria-live="polite"
    >{message}</div>}
  </section>;
}
