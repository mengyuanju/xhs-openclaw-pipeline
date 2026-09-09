'use client';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';

import { Cpu, Image as ImageIcon, RefreshCw, ServerCog, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
  const confirm = useConfirmDialog();
  const [nodes, setNodes] = useState(initialNodes);
  const [refreshing, setRefreshing] = useState(false);
  const [deletingNodeId, setDeletingNodeId] = useState('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [actionError, setActionError] = useState('');
  const latestRefreshId = useRef(0);
  const manualRefreshRunning = useRef(false);

  const refresh = useCallback(async ({ silent = false } = {}) => {
    if (silent && manualRefreshRunning.current) return;
    const refreshId = ++latestRefreshId.current;
    if (!silent) {
      manualRefreshRunning.current = true;
      setRefreshing(true);
    }
    try {
      const next = await apiRequest<ExecutorStatus[]>('/api/control-plane/v1/executor-statuses');
      if (refreshId !== latestRefreshId.current) return;
      setNodes(next);
      setLastRefreshedAt(new Date().toISOString());
      setRefreshError('');
    } catch (caught) {
      if (!silent && refreshId === latestRefreshId.current) {
        setRefreshError(caught instanceof Error ? caught.message : '执行机状态读取失败');
      }
    } finally {
      if (!silent) {
        manualRefreshRunning.current = false;
        setRefreshing(false);
      }
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

  async function deleteNode(node: ExecutorStatus) {
    const approved = await confirm({
      title: '删除这条执行机信息？',
      description: `将从执行机列表移除 ${node.name}（${node.id}），但不会删除它参与过的任务和执行历史。若这台执行机再次启动并连接中心服务，它会自动重新出现。`,
      confirmLabel: '确认删除',
      tone: 'danger',
    });
    if (!approved) return;
    setDeletingNodeId(node.id);
    setMessage('');
    setActionError('');
    setRefreshError('');
    try {
      await apiRequest('/api/control-plane/v1/executor-statuses', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: node.id }),
      });
      latestRefreshId.current += 1;
      setNodes((current) => current.filter((candidate) => candidate.id !== node.id));
      setLastRefreshedAt(new Date().toISOString());
      setMessage(`执行机 ${node.name} 的信息已删除。`);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : '执行机信息删除失败');
    } finally {
      setDeletingNodeId('');
    }
  }

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
          <p id="executor-delete-policy">每 15 秒自动刷新；超过 90 秒未上报心跳会显示为离线，离线且无运行任务时可删除。</p>
        </div>
        <div className="executor-refresh-area">
          <span>{lastRefreshedAt ? `更新于 ${dateTime(lastRefreshedAt)}` : '显示中心服务最新状态'}</span>
          <Button unstyled className="button small" type="button" disabled={refreshing} onClick={() => { void refresh(); }}>
            <RefreshCw className={refreshing ? 'animate-spin' : ''} size={14} />{refreshing ? '刷新中…' : '刷新'}
          </Button>
        </div>
      </div>
      {(message || actionError || refreshError) && <div className={`notice ${actionError || refreshError ? 'error' : 'success'}`} role={actionError || refreshError ? 'alert' : 'status'}>{actionError || refreshError || message}</div>}
      {nodes.length === 0
        ? <div className="executor-empty">当前还没有执行机注册到中心服务。</div>
        : <div className="table-wrap executor-table-wrap mobile-cards"><table>
          <thead><tr><th>执行机</th><th>状态</th><th>文案任务</th><th>生图任务</th><th>最后心跳</th><th className="executor-actions-heading">操作</th></tr></thead>
          <tbody>{nodes.map((node) => {
            const status = statusOf(node);
            const copyAvailable = Math.max(0, node.copyConcurrency - node.copyRunningCount);
            const imageAvailable = Math.max(0, node.imageConcurrency - node.imageRunningCount);
            const hasRunningTasks = node.copyRunningCount > 0 || node.imageRunningCount > 0;
            const deletionDisabled = Boolean(deletingNodeId) || node.online || hasRunningTasks;
            const deleteTitle = node.online
              ? '请先停止执行机并等待其显示为离线'
              : hasRunningTasks
                ? '请先处理这台执行机仍在运行的任务'
                : `删除 ${node.name} 的执行机信息`;
            return <tr key={node.id}>
              <td data-label="执行机"><div className="executor-identity"><strong>{node.name}</strong><code>{node.id}</code></div></td>
              <td data-label="状态"><span className={`executor-status ${status.className}`}><i aria-hidden="true" />{status.label}</span></td>
              <td data-label="文案任务"><div className="executor-capacity"><strong>{node.copyRunningCount} / {node.copyConcurrency} 执行中</strong><span>空闲 {copyAvailable} 个槽位</span></div></td>
              <td data-label="生图任务">{node.imageWorkerEnabled
                ? <div className="executor-capacity"><strong>{node.imageRunningCount} / {node.imageConcurrency} 执行中</strong><span>空闲 {imageAvailable} 个槽位</span></div>
                : <span className="executor-disabled">未启用生图</span>}</td>
              <td data-label="最后心跳"><time dateTime={node.lastSeenAt}>{dateTime(node.lastSeenAt)}</time></td>
              <td className="row-action" data-label="操作"><div className="executor-row-actions">
                <Button unstyled className="button small danger" type="button" disabled={deletionDisabled} title={deleteTitle} aria-label={`删除执行机 ${node.name}`} aria-describedby={deletionDisabled ? 'executor-delete-policy' : undefined} onClick={() => { void deleteNode(node); }}>
                  {deletingNodeId === node.id ? <RefreshCw className="animate-spin" size={14} /> : <Trash2 size={14} />}
                  {deletingNodeId === node.id ? '删除中…' : '删除'}
                </Button>
              </div></td>
            </tr>;
          })}</tbody>
        </table></div>}
    </section>
  </div>;
}
