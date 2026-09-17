'use client';

import { Button } from '@/components/ui/button';
import { ToastFeedback } from '@/components/ui/sonner';
import { CheckCircle2, Download, LoaderCircle, PackageCheck, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { apiRequest } from '../components/api-client';
import {
  normalizeDeliveryBatchPage,
  type DeliveryBatchSummary,
} from '../delivery-pool/types';

function timeLabel(value: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
}

function statusLabel(batch: DeliveryBatchSummary) {
  if (batch.status === 'DELIVERED') return '已确认交付';
  if (batch.status === 'DOWNLOADED') return '已下载，待确认交付';
  return '已生成，待下载';
}

export function OperatorDeliveryHistory({ refreshKey }: { refreshKey: number }) {
  const [batches, setBatches] = useState<DeliveryBatchSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const currentRequestId = ++requestId.current;
    setLoading(true);
    try {
      const page = normalizeDeliveryBatchPage(await apiRequest<unknown>(
        '/api/control-plane/v1/delivery-batches?limit=20&offset=0',
      ));
      if (currentRequestId !== requestId.current) return;
      setBatches(page.items);
      setTotal(page.total);
      setError('');
    } catch (caught) {
      if (currentRequestId !== requestId.current) return;
      setError(caught instanceof Error ? caught.message : '交付记录读取失败');
    } finally {
      if (currentRequestId === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => () => { requestId.current += 1; }, []);

  async function confirmDelivery(batch: DeliveryBatchSummary) {
    if (confirming || batch.status !== 'DOWNLOADED') return;
    setConfirming(batch.publicId);
    setError('');
    setMessage('');
    try {
      await apiRequest<unknown>(
        `/api/control-plane/v1/delivery-batches/${encodeURIComponent(batch.publicId)}/confirm`,
        { method: 'POST' },
      );
      setMessage(`${batch.code} 已确认完成交付，管理员现在可以看到该记录。`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '确认交付失败');
    } finally {
      setConfirming(null);
    }
  }

  return <section className="panel workbench-task-panel" aria-labelledby="operator-delivery-history-title">
    <div className="workbench-toolbar">
      <div>
        <span className="section-kicker">Delivery history</span>
        <h2 id="operator-delivery-history-title"><PackageCheck size={18} />我的交付记录</h2>
        <p>下载完成后，请确认是否已经把文件交付给接收方；管理员会同步看到创建、下载和确认记录。</p>
      </div>
      <div className="workbench-toolbar-actions">
        <Button unstyled className="button small" type="button" disabled={loading} onClick={() => { void load(); }}>
          <RefreshCw className={loading ? 'animate-spin' : ''} size={14} />刷新记录
        </Button>
      </div>
    </div>
    <ToastFeedback id="operator-delivery-history-feedback" message={message} />
    {error && <div className="notice error" role="alert">{error}</div>}
    {loading && batches.length === 0
      ? <div className="empty-state"><LoaderCircle className="animate-spin" size={18} />正在读取交付记录…</div>
      : batches.length === 0
        ? <div className="empty-state">还没有交付记录。请在下方勾选已完成作业并创建交付包。</div>
        : <div className="table-wrap mobile-cards" role="region" aria-label="我的交付记录，可横向滚动" tabIndex={0}>
          <table>
            <thead><tr><th>批次</th><th>数量</th><th>创建时间</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>{batches.map((batch) => <tr key={batch.publicId}>
              <td data-label="批次"><strong>{batch.code}</strong></td>
              <td data-label="数量">{batch.taskCount} 条</td>
              <td data-label="创建时间">{timeLabel(batch.createdAt)}</td>
              <td data-label="状态"><span className="pill">{statusLabel(batch)}</span>
                <small>{batch.status === 'DELIVERED'
                  ? `确认于 ${timeLabel(batch.deliveredAt)}`
                  : batch.downloadCount ? `已下载 ${batch.downloadCount} 次` : '尚未记录完整下载'}</small>
              </td>
              <td className="row-action" data-label="操作"><div className="workbench-toolbar-actions">
                <a
                  className="button small"
                  href={`/api/control-plane/v1/delivery-batches/${encodeURIComponent(batch.publicId)}/archive`}
                  download={batch.fileName}
                  onClick={() => window.setTimeout(() => { void load(); }, 1500)}
                ><Download size={14} />{batch.downloadCount ? '重新下载' : '下载'}</a>
                {batch.status === 'DOWNLOADED' && <Button
                  unstyled className="button small primary" type="button"
                  disabled={Boolean(confirming)} onClick={() => { void confirmDelivery(batch); }}
                ><CheckCircle2 size={14} />{confirming === batch.publicId ? '确认中…' : '确认已交付'}</Button>}
              </div></td>
            </tr>)}</tbody>
          </table>
        </div>}
    {total > batches.length && <p className="workbench-updated-at">当前显示最近 {batches.length} / {total} 批。</p>}
  </section>;
}
