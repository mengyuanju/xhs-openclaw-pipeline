'use client';

import { useEffect, useState, type ComponentProps } from 'react';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { Button } from '@/components/ui/button';
import { ImageHistoryCompare, type ImageRunHistory } from '../components/image-history-compare';
import { apiRequest } from '../components/api-client';

type Props = ComponentProps<typeof ImageHistoryCompare> & { taskId: number };
type Metadata = { id: string; createdAt: string; status: string };
type Page = { items: Metadata[]; hasMore: boolean; nextCursor: string | null };

export function LazyImageHistory({ taskId, ...props }: Props) {
  const [open, setOpen] = useState(false);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [data, setData] = useState<Page | null>(null);
  const [selected, setSelected] = useState('');
  const [run, setRun] = useState<ImageRunHistory | null>(null);
  const [assets, setAssets] = useState<Props['assets']>([]);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const cursor = cursors.at(-1);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    const query = new URLSearchParams({ limit: '20' }); if (cursor) query.set('cursor', cursor);
    setData(null); setSelected(''); setRun(null); setError('');
    apiRequest<Page>(`/api/control-plane/v1/tasks/${taskId}/history/imageRuns?${query}`, { signal: abort.signal })
      .then(page => { if (!abort.signal.aborted) { setData(page); setSelected(page.items.find(item => item.id !== props.currentRunId && item.status === 'COMPLETED')?.id ?? ''); } })
      .catch(cause => { if (!abort.signal.aborted) setError(cause.message); });
    return () => abort.abort();
  }, [open, taskId, props.currentRunId, cursor, revision]);
  useEffect(() => {
    if (!open || !selected) return;
    const abort = new AbortController();
    setRun(null); setAssets([]); setError('');
    apiRequest<{ item: ImageRunHistory; assets: Props['assets'] }>(`/api/control-plane/v1/tasks/${taskId}/history/imageRuns/${selected}`, { signal: abort.signal })
      .then(detail => { if (!abort.signal.aborted) { setRun(detail.item); setAssets(detail.assets); } })
      .catch(cause => { if (!abort.signal.aborted) setError(cause.message); });
    return () => abort.abort();
  }, [open, taskId, selected, revision]);
  return <Disclosure open={open} onOpenChange={setOpen} className="image-history-compare">
    <DisclosureTrigger>历史图片 · 对照当前成品</DisclosureTrigger>
    <DisclosureContent>{open && <>
      {error && <p role="alert">{error} <Button unstyled className="button" type="button" onClick={() => setRevision(value => value + 1)}>重试历史图片</Button></p>}
      {!data && !error && <p role="status">正在加载历史图片版本…</p>}
      {data && <div className="field"><label htmlFor={`image-history-${taskId}`}>查看历史版本</label>
        <select id={`image-history-${taskId}`} value={selected} onChange={event => setSelected(event.target.value)}>
          {!selected && <option value="">当前批次没有其他已完成版本</option>}
          {data.items.filter(item => item.id !== props.currentRunId && item.status === 'COMPLETED').map(item => <option value={item.id} key={item.id}>{new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })} · {item.id.slice(0, 8)}</option>)}
        </select>
      </div>}
      {selected && !run && !error && <p role="status">正在加载所选版本图片…</p>}
      {run && <ImageHistoryCompare {...props} runs={[run]} assets={assets} expanded hideSelection />}
      {data && <div className="model-call-toolbar"><Button unstyled type="button" className="button" disabled={cursors.length === 1} onClick={() => setCursors(values => values.slice(0, -1))}>上一批图片版本</Button>
        <span>第 {cursors.length} 批</span><Button unstyled type="button" className="button" disabled={!data.hasMore || !data.nextCursor} onClick={() => setCursors(values => [...values, data.nextCursor])}>下一批图片版本</Button></div>}
    </>}</DisclosureContent>
  </Disclosure>;
}
