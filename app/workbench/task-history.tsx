'use client';

import { useEffect, useState } from 'react';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { Button } from '@/components/ui/button';
import { apiRequest } from '../components/api-client';
import { ImagePreview } from '../components/image-preview';

type Kind = 'copyRevisions' | 'imageRuns' | 'assessments' | 'executions';
type Item = { id: string | number; revision?: number; status?: string; stage?: string; score?: number;
  createdAt?: string; startedAt?: string; [key: string]: unknown };
type Page = { items: Item[]; hasMore: boolean; nextCursor: string | null };
const labels: Record<Kind, string> = { copyRevisions: '文案版本', imageRuns: '图片版本', assessments: '人工评分', executions: '执行记录' };

function HistoryContent({ kind, detail, assets }: { kind: Kind; detail: Record<string, unknown>; assets: Array<{ id: number }> }) {
  if (kind === 'copyRevisions') {
    const content = detail.content as { copy?: { title?: string; body?: string; tags?: string[] }; imagePlan?: Array<{ headline?: string; subtitle?: string; bullets?: string[] }> } | undefined;
    return <><h4>{content?.copy?.title || '文案内容'}</h4><p style={{ whiteSpace: 'pre-wrap' }}>{content?.copy?.body || '此版本没有正文。'}</p>
      <p>{content?.copy?.tags?.join(' ')}</p>{content?.imagePlan?.map((plan, index) => <section key={index}><h5>第 {index + 1} 页 · {plan.headline}</h5><p>{plan.subtitle}</p><p>{plan.bullets?.join('；')}</p></section>)}</>;
  }
  if (kind === 'imageRuns') return assets.length ? <div className="workbench-image-grid">{assets.map((asset, index) =>
    <ImagePreview key={asset.id} src={`/api/control-plane/v1/assets/${asset.id}`} alt={`历史图片 ${index + 1}`} />)}</div> : <p>此版本没有可用图片。</p>;
  if (kind === 'assessments') return <><p>评分：{String(detail.score ?? '未记录')} · {String(detail.action ?? '')}</p><p>{String(detail.note ?? '无补充说明')}</p></>;
  return <><p>{String(detail.status ?? '')} · {String(detail.stage ?? '')}</p><p>{String(detail.progressMessage ?? '')}</p>
    {detail.error != null && <p>{String(detail.error)}</p>}</>;
}

function HistoryItem({ taskId, kind, item }: { taskId: number; kind: Kind; item: Item }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [assets, setAssets] = useState<Array<{ id: number }>>([]);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setDetail(null); setAssets([]); setError('');
    apiRequest<{ item: Record<string, unknown>; assets?: Array<{ id: number }> }>(`/api/control-plane/v1/tasks/${taskId}/history/${kind}/${item.id}`, { signal: abort.signal })
      .then(result => { if (!abort.signal.aborted) { setDetail(result.item); setAssets(result.assets ?? []); } }).catch(cause => { if (!abort.signal.aborted) setError(cause.message); });
    return () => abort.abort();
  }, [open, taskId, kind, item.id, revision]);
  const time = item.createdAt ?? item.startedAt;
  return <Disclosure open={open} onOpenChange={setOpen} className="model-call-card">
    <DisclosureTrigger><span>{labels[kind]} · {item.revision ? `第 ${item.revision} 版` : `#${item.id}`}</span>
      <small>{item.status ?? item.stage ?? ''}{time ? ` · ${new Date(time).toLocaleString('zh-CN', { hour12: false })}` : ''}</small></DisclosureTrigger>
    <DisclosureContent>{open && <div className="model-call-body">
      {error && <p role="alert">{error} <Button unstyled className="button" onClick={() => setRevision(value => value + 1)}>重试</Button></p>}
      {!detail && !error && <p role="status">正在加载历史内容…</p>}
      {detail && <HistoryContent kind={kind} detail={detail} assets={assets} />}
    </div>}</DisclosureContent>
  </Disclosure>;
}

export function TaskHistory({ taskId, admin }: { taskId: number; admin: boolean }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>('copyRevisions');
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const cursor = cursors.at(-1);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setData(null); setError('');
    const params = new URLSearchParams({ limit: '20' });
    if (cursor) params.set('cursor', cursor);
    apiRequest<Page>(`/api/control-plane/v1/tasks/${taskId}/history/${kind}?${params}`, { signal: abort.signal })
      .then(result => { if (!abort.signal.aborted) setData(result); }).catch(cause => { if (!abort.signal.aborted) setError(cause.message); });
    return () => abort.abort();
  }, [open, taskId, kind, cursor, revision]);
  return <Disclosure open={open} onOpenChange={setOpen} className="workbench-review-section workbench-review-history">
    <DisclosureTrigger><strong>历史版本与审核记录</strong><span>展开后分批加载</span></DisclosureTrigger>
    <DisclosureContent>{open && <div className="model-call-trace-content">
      <div className="model-call-toolbar">{(Object.keys(labels) as Kind[]).filter(value => admin || value !== 'executions').map(value =>
        <Button unstyled type="button" className="button" aria-pressed={kind === value} key={value} onClick={() => { setData(null); setKind(value); setCursors([null]); }}>{labels[value]}</Button>)}
      </div>
      {error && <p role="alert">{error} <Button unstyled className="button" onClick={() => setRevision(value => value + 1)}>重试加载</Button></p>}
      {!data && !error && <p role="status">正在加载历史记录…</p>}
      {data?.items.length === 0 && <p>暂无历史记录。</p>}
      {data?.items.map(item => <HistoryItem key={`${kind}-${item.id}`} taskId={taskId} kind={kind} item={item} />)}
      {data && <div className="model-call-toolbar">
        <Button unstyled type="button" className="button" disabled={cursors.length === 1} onClick={() => setCursors(values => values.slice(0, -1))}>上一批历史</Button>
        <span>第 {cursors.length} 批</span>
        <Button unstyled type="button" className="button" disabled={!data.hasMore || !data.nextCursor} onClick={() => setCursors(values => [...values, data.nextCursor])}>下一批历史</Button>
      </div>}
    </div>}</DisclosureContent>
  </Disclosure>;
}
