'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { apiRequest } from '../components/api-client';
import { StatusPill } from '../components/status-pill';
import { DemandScreeningPanel } from './demand-screening-panel';
import { QueueGenerationPanel } from './queue-generation-panel';

function commitButtonLabel(batch: any) {
  if (batch.status === 'COMMITTED') return '已写入队列';
  if (batch.pendingScreeningRows > 0) return '筛选未完成';
  if (batch.admittedRows === 0) return '完成批次（0 条入队）';
  return `确认入队 ${batch.admittedRows} 条`;
}

export function ImportWorkbench({ initialBatch = null }: { initialBatch?: any }) {
  const router = useRouter();
  const [batch, setBatch] = useState<any>(initialBatch);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [messageIsError, setMessageIsError] = useState(false);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setMessage(''); setMessageIsError(false);
    try {
      const data = new FormData(event.currentTarget);
      const result = await apiRequest<any>('/api/import-batches', { method: 'POST', body: data });
      setBatch(result);
      const modelScreenedRows = result.rows.filter(
        (row: any) => row.screeningSource === 'OPENCLAW',
      ).length;
      setMessage(modelScreenedRows > 0
        ? `结构预检完成；OpenClaw 已自动判定 ${modelScreenedRows} 行，请复核后再入队。`
        : `已完成 ${result.totalRows} 行结构预检；现有 Excel 判定可继续人工复核。`);
      setMessageIsError(false);
      router.replace(`/imports?batchId=${result.id}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '上传失败');
      setMessageIsError(true);
    } finally { setBusy(false); }
  }

  async function commit() {
    if (!batch || batch.pendingScreeningRows > 0) {
      setMessage('筛选未完成：请先判定所有结构合格选题的需求强度。');
      setMessageIsError(true);
      return;
    }
    const commitMessage = batch.admittedRows > 0
      ? `确认将 ${batch.admittedRows} 条强需/中需选题写入生产队列？`
      : '当前没有强需/中需选题，确认完成该批次且不创建任务？';
    if (!window.confirm(commitMessage)) return;
    setBusy(true); setMessage(''); setMessageIsError(false);
    try {
      const result = await apiRequest<any>(`/api/import-batches/${batch.id}/commit`, { method: 'POST' });
      setBatch({ ...batch, status: 'COMMITTED', committedAt: result.batch.committedAt });
      setMessage(`已入队 ${result.createdTasks} 条任务。重复点击不会重复创建。`);
      setMessageIsError(false);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '提交失败');
      setMessageIsError(true);
    } finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <form className="panel" onSubmit={upload}>
        <div className="panel-head"><h2>1. 上传、预检与模型检测</h2><span className="subtle">最大 5 MiB · 最多 5,000 行</span></div>
        <div className="form-grid">
          <div className="field"><label htmlFor="batch-name">批次名称（可选）</label><input id="batch-name" className="input" name="name" maxLength={200} placeholder="如：8月收纳选题" /></div>
          <div className="field"><label htmlFor="excel-file">Excel 文件</label><input id="excel-file" className="input file-input" name="file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required /></div>
          <div className="field full inline"><button className="button primary" type="submit" disabled={busy}>{busy ? 'OpenClaw 检测中…' : '上传并调用 OpenClaw 检测'}</button><span className="subtle">未预筛选的有效行会调用文本模型，可能产生费用并延长上传时间。</span></div>
        </div>
      </form>

      {message && <div className={messageIsError ? 'notice error' : 'notice success'} role={messageIsError ? 'alert' : 'status'} aria-live="polite">{message}</div>}

      {batch && <>
        <section className="panel import-summary">
          <div className="panel-head"><div><h2>{batch.name}</h2><span className="subtle">{batch.sourceFileName}</span></div><StatusPill value={batch.status} /></div>
          <div className="stats-grid">
            <div className="stat-card"><span className="label">总行数</span><strong>{batch.totalRows}</strong></div>
            <div className="stat-card"><span className="label">可入队（强/中需）</span><strong>{batch.admittedRows}</strong></div>
            <div className="stat-card"><span className="label">已废弃（弱/无需）</span><strong>{batch.discardedRows}</strong></div>
            <div className="stat-card"><span className="label">待筛选</span><strong>{batch.pendingScreeningRows}</strong></div>
          </div>
        </section>
        <DemandScreeningPanel key={batch.id} batch={batch} onBatchChange={setBatch} onMessage={(nextMessage, isError = false) => {
          setMessage(nextMessage);
          setMessageIsError(isError);
        }} />
        <section className="panel commit-panel">
          <div><h2>3. 确认入队</h2><p className="subtle">仅强需和中需进入生产；弱需、无需及结构错误行保留在批次记录中。</p></div>
          <button className="button primary" type="button" disabled={busy || batch.status === 'COMMITTED' || batch.pendingScreeningRows > 0} onClick={commit}>{commitButtonLabel(batch)}</button>
        </section>
        {batch.status === 'COMMITTED' && <QueueGenerationPanel maxTasks={batch.admittedRows} />}
      </>}
    </div>
  );
}
