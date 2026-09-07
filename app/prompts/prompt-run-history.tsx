'use client';

import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Disclosure, DisclosureTrigger, DisclosureContent } from '@/components/ui/disclosure';
import { Button } from '@/components/ui/button';

import { useState } from 'react';
import { apiRequest } from '../components/api-client';

export function PromptRunHistory() {
  const [runs, setRuns] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState('WEB');
  async function load(id?: string) {
    setBusy(true); setError('');
    try { const value = await apiRequest<any>(`/api/prompt-runs?source=${source}${id ? `&id=${encodeURIComponent(id)}` : ''}`, { cache: 'no-store' });
      if (id) setSelected(value); else setRuns(value);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '记录读取失败'); }
    finally { setBusy(false); }
  }
  return <Disclosure className="panel stack"><DisclosureTrigger>查看 Web 执行记录（管理员）</DisclosureTrigger><DisclosureContent>
    <p className="subtle">独立生成、筛选和知识分析的实际调用保存在这里。中心任务的调用记录在任务详情查看。记录包含本次冻结配置、版本来源、实际请求和原始响应；敏感凭据会脱敏。</p>
    <label className="field">记录位置<Select value={source} onValueChange={(nextValue) => { setSource(nextValue); setRuns([]); setSelected(null); }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="WEB">本机 Web / 本地 worker</SelectItem><SelectItem value="CENTER">中心知识分析</SelectItem></SelectContent></Select></label>
    <Button unstyled className="button" type="button" disabled={busy} onClick={() => void load()}>刷新最近 50 次执行</Button>
    {error && <p role="alert">{error}</p>}
    {runs.map((run) => <Button unstyled className="button" type="button" disabled={busy} key={run.id} onClick={() => void load(run.id)}>{run.kind} · {run.query || run.id} · {run.status} · {run.callCount} 次调用</Button>)}
    {selected && <pre className="prompt-history-content">{JSON.stringify(selected, null, 2)}</pre>}
  </DisclosureContent></Disclosure>;
}
