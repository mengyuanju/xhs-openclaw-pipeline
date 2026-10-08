'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiRequest } from '../../components/api-client';
import { createRequestId } from '../../components/request-id';

type Job = { id: number; status: 'QUEUED' | 'RUNNING' | 'COMPLETE' | 'FAILED' | 'EXPIRED'; rowCount: number; expiresAt: string; error: string | null };
const base = '/api/control-plane/v1/admin/task-data-report/exports';
const labels: Record<Job['status'], string> = { QUEUED: '排队中', RUNNING: '正在生成', COMPLETE: '已完成', FAILED: '生成失败', EXPIRED: '已过期' };

export function ReportExports({ query, disabled }: { query: object; disabled: boolean }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const pending = jobs.some(job => ['QUEUED', 'RUNNING'].includes(job.status));
  useEffect(() => {
    const abort = new AbortController();
    apiRequest<Job[]>(base, { signal: abort.signal }).then(values => { if (!abort.signal.aborted) setJobs(values); }).catch(cause => { if (!abort.signal.aborted) setError(cause.message); });
    const timer = pending ? window.setTimeout(() => setRevision(value => value + 1), 2000) : null;
    return () => { abort.abort(); if (timer) window.clearTimeout(timer); };
  }, [revision, pending]);
  async function create() {
    setBusy(true); setError('');
    try {
      const job = await apiRequest<Job>(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...query, requestId: createRequestId() }) });
      setJobs(values => [job, ...values.filter(value => value.id !== job.id)].slice(0, 20));
      setRevision(value => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '导出失败'); }
    finally { setBusy(false); }
  }
  return <section aria-label="任务明细导出" className="panel">
    <div className="panel-head"><div><strong>任务明细导出</strong><p className="subtle">按已应用的筛选条件在后台生成 CSV，完成后可下载，文件保留 24 小时。</p></div>
      <Button variant="outline" size="sm" type="button" disabled={disabled || busy} onClick={() => void create()}>{busy ? '正在提交…' : '生成任务明细 CSV'}</Button></div>
    {error && <p role="alert">{error} <Button variant="outline" size="sm" type="button" onClick={() => { setError(''); setRevision(value => value + 1); }}>刷新导出记录</Button></p>}
    {jobs.length > 0 && <ul>{jobs.map(job => <li key={job.id}>导出 #{job.id} · {labels[job.status]} · {job.rowCount.toLocaleString('zh-CN')} 条
      {job.status === 'COMPLETE' && new Date(job.expiresAt).valueOf() > Date.now() && <> · <a href={`${base}/${job.id}/download`}>下载 CSV</a></>}
      {job.error && <> · {job.error}</>}
    </li>)}</ul>}
  </section>;
}
