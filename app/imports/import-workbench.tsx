'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { apiRequest } from '../components/api-client';
import { StatusPill } from '../components/status-pill';

export function ImportWorkbench() {
  const router = useRouter();
  const [batch, setBatch] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setMessage('');
    try {
      const data = new FormData(event.currentTarget);
      const result = await apiRequest<any>('/api/import-batches', { method: 'POST', body: data });
      setBatch(result);
      setMessage(`已预检 ${result.totalRows} 行，请确认后入队。`);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '上传失败');
    } finally { setBusy(false); }
  }

  async function commit() {
    if (!batch || !window.confirm(`确认将 ${batch.validRows} 条有效选题写入生产队列？`)) return;
    setBusy(true); setMessage('');
    try {
      const result = await apiRequest<any>(`/api/import-batches/${batch.id}/commit`, { method: 'POST' });
      setBatch({ ...batch, status: 'COMMITTED', committedAt: result.batch.committedAt });
      setMessage(`已入队 ${result.createdTasks} 条任务。重复点击不会重复创建。`);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '提交失败');
    } finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <form className="panel" onSubmit={upload}>
        <div className="panel-head"><h2>上传并预检</h2><span className="subtle">最大 5 MiB · 最多 5,000 行</span></div>
        <div className="form-grid">
          <div className="field"><label htmlFor="batch-name">批次名称（可选）</label><input id="batch-name" className="input" name="name" maxLength={200} placeholder="如：8月收纳选题" /></div>
          <div className="field"><label htmlFor="excel-file">Excel 文件</label><input id="excel-file" className="input" name="file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required /></div>
          <div className="field full inline"><button className="button primary" disabled={busy}>{busy ? '处理中…' : '上传并预检'}</button><span className="subtle">必需列：query / 查询 / 选题；图片数量支持 3–5。</span></div>
        </div>
      </form>

      {message && <div className={message.includes('失败') || message.includes('无效') ? 'notice error' : 'notice success'}>{message}</div>}

      {batch && (
        <section className="panel">
          <div className="panel-head"><div><h2>{batch.name}</h2><span className="subtle">{batch.sourceFileName}</span></div><StatusPill value={batch.status} /></div>
          <div className="stats-grid">
            <div className="stat-card"><span className="label">总行数</span><strong>{batch.totalRows}</strong></div>
            <div className="stat-card"><span className="label">有效</span><strong>{batch.validRows}</strong></div>
            <div className="stat-card"><span className="label">无效</span><strong>{batch.invalidRows}</strong></div>
            <div className="stat-card"><span className="label">当前状态</span><strong style={{fontSize: 20}}>{batch.status === 'COMMITTED' ? '已入队' : '待确认'}</strong></div>
          </div>
          <div className="table-wrap">
            <table><thead><tr><th>行</th><th>外部 ID</th><th>选题</th><th>图片</th><th>校验结果</th></tr></thead>
              <tbody>{batch.rows.slice(0, 100).map((row: any) => <tr key={row.id}><td>{row.rowNumber}</td><td className="mono">{row.externalId || '—'}</td><td className="query-cell">{row.query || '—'}</td><td>{row.imageCount}</td><td>{row.isValid ? <StatusPill value="APPROVED" /> : <span className="pill pill-failed">{row.errors.join('；')}</span>}</td></tr>)}</tbody>
            </table>
          </div>
          {batch.rows.length > 100 && <p className="subtle">页面仅展示前 100 行，全部 {batch.rows.length} 行已完成校验。</p>}
          <div className="inline" style={{marginTop: 16}}><button className="button primary" disabled={busy || batch.status === 'COMMITTED' || batch.validRows === 0} onClick={commit}>{batch.status === 'COMMITTED' ? '已写入队列' : `确认入队 ${batch.validRows} 条`}</button><span className="subtle">无效行会保留在预检记录中，但不会进入任务队列。</span></div>
        </section>
      )}
    </div>
  );
}
