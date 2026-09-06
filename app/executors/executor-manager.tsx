'use client';

import { Cpu, Image as ImageIcon, RefreshCw, ServerCog } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { apiRequest } from '../components/api-client';

export type ExecutorStatus = {
  id: string;
  name: string;
  online: boolean;
  imageWorkerEnabled: boolean;
  copyConcurrency: number;
  imageConcurrency: number;
  copyRunningCount: number;
  imageRunningCount: number;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

function statusOf(node: ExecutorStatus) {
  if (!node.online) return { label: '离线', className: 'executor-status-offline' };
  const copyAvailable = node.copyRunningCount < node.copyConcurrency;
  const imageAvailable = node.imageWorkerEnabled && node.imageRunningCount < node.imageConcurrency;
  return copyAvailable || imageAvailable
    ? { label: '在线空闲', className: 'executor-status-ready' }
    : { label: '在线满载', className: 'executor-status-busy' };
}

function dateTime(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
    : '从未上报';
}

export function ExecutorManager({ initialNodes }: { initialNodes: ExecutorStatus[] }) {
  const [nodes, setNodes] = useState(initialNodes);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setRefreshing(true);
    try {
      const next = await apiRequest<ExecutorStatus[]>('/api/control-plane/v1/executor-statuses');
      setNodes(next);
      setLastRefreshedAt(new Date().toISOString());
      setError('');
    } catch (caught) {
      if (!silent) setError(caught instanceof Error ? caught.message : '执行机状态读取失败');
    } finally {
      if (!silent) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => { void refresh({ silent: true }); }, 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const summary = useMemo(() => ({
    online: nodes.filter((node) => node.online).length,
    copyRunning: nodes.filter((node) => node.online)
      .reduce((total, node) => total + node.copyRunningCount, 0),
    copyCapacity: nodes.filter((node) => node.online).reduce((total, node) => total + node.copyConcurrency, 0),
    imageRunning: nodes.filter((node) => node.online && node.imageWorkerEnabled)
      .reduce((total, node) => total + node.imageRunningCount, 0),
    imageCapacity: nodes.filter((node) => node.online && node.imageWorkerEnabled)
      .reduce((total, node) => total + node.imageConcurrency, 0),
  }), [nodes]);

  return <div className="executor-manager">
    <section className="executor-summary" aria-label="执行机概览">
      <article><ServerCog aria-hidden="true" size={19} /><div><strong>{summary.online} / {nodes.length}</strong><span>在线执行机</span></div></article>
      <article><Cpu aria-hidden="true" size={19} /><div><strong>{summary.copyRunning} / {summary.copyCapacity}</strong><span>文案并发占用</span></div></article>
      <article><ImageIcon aria-hidden="true" size={19} /><div><strong>{summary.imageRunning} / {summary.imageCapacity}</strong><span>生图并发占用</span></div></article>
    </section>

    <section className="panel executor-panel">
      <div className="panel-head executor-panel-head">
        <div>
          <span className="section-kicker">Live status</span>
          <h2>全部执行机</h2>
          <p>每 15 秒自动刷新；超过 90 秒未上报心跳会显示为离线。</p>
        </div>
        <div className="executor-refresh-area">
          <span>{lastRefreshedAt ? `更新于 ${dateTime(lastRefreshedAt)}` : '显示中心服务最新状态'}</span>
          <button className="button small" type="button" disabled={refreshing} onClick={() => { void refresh(); }}>
            <RefreshCw className={refreshing ? 'animate-spin' : ''} size={14} />{refreshing ? '刷新中…' : '刷新'}
          </button>
        </div>
      </div>
      {error && <div className="notice error" role="alert">{error}</div>}
      {nodes.length === 0
        ? <div className="executor-empty">当前还没有执行机注册到中心服务。</div>
        : <div className="table-wrap executor-table-wrap mobile-cards"><table>
          <thead><tr><th>执行机</th><th>状态</th><th>文案任务</th><th>生图任务</th><th>最后心跳</th></tr></thead>
          <tbody>{nodes.map((node) => {
            const status = statusOf(node);
            const copyAvailable = Math.max(0, node.copyConcurrency - node.copyRunningCount);
            const imageAvailable = Math.max(0, node.imageConcurrency - node.imageRunningCount);
            return <tr key={node.id}>
              <td data-label="执行机"><div className="executor-identity"><strong>{node.name}</strong><code>{node.id}</code></div></td>
              <td data-label="状态"><span className={`executor-status ${status.className}`}><i aria-hidden="true" />{status.label}</span></td>
              <td data-label="文案任务"><div className="executor-capacity"><strong>{node.copyRunningCount} / {node.copyConcurrency} 执行中</strong><span>空闲 {copyAvailable} 个槽位</span></div></td>
              <td data-label="生图任务">{node.imageWorkerEnabled
                ? <div className="executor-capacity"><strong>{node.imageRunningCount} / {node.imageConcurrency} 执行中</strong><span>空闲 {imageAvailable} 个槽位</span></div>
                : <span className="executor-disabled">未启用生图</span>}</td>
              <td data-label="最后心跳"><time dateTime={node.lastSeenAt}>{dateTime(node.lastSeenAt)}</time></td>
            </tr>;
          })}</tbody>
        </table></div>}
    </section>
  </div>;
}
