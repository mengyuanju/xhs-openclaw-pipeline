'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/input';
import { apiRequest } from './api-client';
import { createRequestId } from './request-id';
import { ImagePreview } from './image-preview';
import styles from './pending-image-edits-dialog.module.css';

export type PendingImageEdit = {
  id: string;
  version: number;
  status: string;
  target_page: number;
  source_asset_id: number;
  source_image_run_id: string;
  copy_revision_id: number;
  operation: string;
  created_at?: string;
  config?: { instruction?: string };
  result?: { asset_id: number; validation?: { passed?: boolean; mock?: boolean } } | null;
};
type Decision = 'accept' | 'reject' | 'cancel';
type Props = {
  taskId: number;
  imageRunId: string;
  copyRevisionId: number;
  currentPages: Array<{ assetId: number; page: number }>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onRefreshTask: () => Promise<void>;
  onResolved: (remaining: PendingImageEdit[]) => Promise<void>;
};
const statusLabels: Record<string, string> = { DRAFT: '草稿', QUEUED: '排队中', RUNNING: '执行中', PREVIEW_READY: '结果待确认' };
const operationLabels: Record<string, string> = { TEXT: '添加文字', SVG_DISCLOSURE: '添加标识', AI_LOCAL: '局部修改', AI_FUSION: '产品替换', RESTORE: '恢复版本' };
const endpoint = (taskId: number) => `/api/control-plane/v1/tasks/${taskId}/image-edits`;

export function PendingImageEditsDialog({ taskId, imageRunId, copyRevisionId, currentPages, open, onOpenChange, onBusyChange, onRefreshTask, onResolved }: Props) {
  const [edits, setEdits] = useState<PendingImageEdit[]>([]);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [cancelUnfinished, setCancelUnfinished] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requestRef = useRef<{ fingerprint: string; id: string } | null>(null);
  const activeRef = useRef(false);
  const loadSequence = useRef(0);
  const refreshTaskRef = useRef(onRefreshTask);
  refreshTaskRef.current = onRefreshTask;

  const refresh = useCallback(async (reloadTask = false) => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError('');
    try {
      if (reloadTask) await refreshTaskRef.current();
      const rows = await apiRequest<PendingImageEdit[]>(`${endpoint(taskId)}?pending=true`);
      if (sequence !== loadSequence.current) return;
      setEdits(rows);
      setDecisions({});
      setCancelUnfinished(false);
    } catch (caught) {
      if (sequence === loadSequence.current) setError(caught instanceof Error ? caught.message : '待处理修改读取失败');
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    if (open) { setNotice(''); void refresh(); }
    return () => { loadSequence.current++; };
  }, [open, refresh]);

  const ready = edits.filter(edit => edit.status === 'PREVIEW_READY');
  const unfinished = edits.filter(edit => edit.status !== 'PREVIEW_READY');
  const conflictingPages = [...new Set(ready.filter(edit => ready.some(other => other.id !== edit.id && other.target_page === edit.target_page)).map(edit => edit.target_page))];
  const canAccept = (edit: PendingImageEdit) => edit.status === 'PREVIEW_READY'
    && edit.result?.validation?.passed === true && edit.result.validation.mock !== true
    && Number(edit.copy_revision_id) === copyRevisionId
    && currentPages.some(page => page.page === edit.target_page && page.assetId === Number(edit.source_asset_id))
    && (edit.operation !== 'RESTORE' || edit.source_image_run_id === imageRunId);

  function choose(edit: PendingImageEdit, decision: Decision | '') {
    setDecisions(current => {
      const next = { ...current };
      if (decision) next[edit.id] = decision;
      else delete next[edit.id];
      // A deliberate page choice rejects the alternative results for that page.
      if (decision === 'accept') for (const other of ready) {
        if (other.id !== edit.id && other.target_page === edit.target_page) next[other.id] = 'reject';
      }
      return next;
    });
  }

  async function apply(selected: Record<string, Decision>) {
    if (activeRef.current || loading) return;
    const chosen = { ...selected };
    if (cancelUnfinished) for (const edit of unfinished) chosen[edit.id] = 'cancel';
    const items = edits.filter(edit => chosen[edit.id]).map(edit => ({ id: edit.id, version: edit.version, action: chosen[edit.id] }));
    if (!items.length) return;
    const fingerprint = JSON.stringify({ imageRunId, decisions: items });
    if (requestRef.current?.fingerprint !== fingerprint) requestRef.current = { fingerprint, id: createRequestId() };
    activeRef.current = true;
    setBusy(true);
    onBusyChange(true);
    setError('');
    setNotice('');
    try {
      await apiRequest(`${endpoint(taskId)}/resolve-pending`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: requestRef.current.id, imageRunId, decisions: items }),
      });
      const remaining = await apiRequest<PendingImageEdit[]>(`${endpoint(taskId)}?pending=true`);
      setEdits(remaining);
      setDecisions({});
      setCancelUnfinished(false);
      setNotice(`已处理 ${items.length} 项修改${remaining.length ? `，还有 ${remaining.length} 项待处理。` : '。'}`);
      await onResolved(remaining);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '处理失败，请重试或刷新列表');
    } finally {
      activeRef.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }

  async function continueReview() {
    if (activeRef.current || loading) return;
    activeRef.current = true;
    setBusy(true);
    onBusyChange(true);
    setError('');
    try { await onResolved([]); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '刷新图集失败，请重试'); }
    finally { activeRef.current = false; setBusy(false); onBusyChange(false); }
  }

  return <Dialog open={open} onOpenChange={next => { if (!activeRef.current) onOpenChange(next); }}>
    <DialogContent className={styles.dialog} showCloseButton={!busy}
      onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}
      onInteractOutside={event => event.preventDefault()}>
      <header className={styles.header}>
        <DialogTitle>集中处理图片修改</DialogTitle>
        <DialogDescription>采用、拒绝或取消后再提交图片初审。拒绝会保留当前图片；采用会更新对应页面。处理完成后可继续初审确认。</DialogDescription>
        <div className={styles.summary}><strong>{ready.length} 项结果待确认</strong><span>{unfinished.length} 项尚未完成</span>
          <Button variant="outline" size="sm" disabled={busy || loading} onClick={() => void refresh(true)}>刷新列表</Button></div>
      </header>
      <div className={styles.body} aria-busy={busy || loading}>
        {loading ? <p role="status">正在读取待处理修改…</p> : <>
          {conflictingPages.length > 0 && <p className="notice warning">第 {conflictingPages.join('、')} 页有多个结果，请选择要采用的一个，其余结果将标记为拒绝。</p>}
          {notice && <p className="notice" role="status">{notice}</p>}
          {edits.length === 0 && !error && <p>当前没有待处理修改，可以继续初审。</p>}
          <div className={styles.list}>{[...ready].sort((a, b) => a.target_page - b.target_page).map(edit => <article className={styles.card} key={edit.id}>
            <div className={styles.cardTitle}><strong>第 {edit.target_page} 页 · {operationLabels[edit.operation] ?? '图片修改'}</strong>
              <span>{statusLabels[edit.status]}</span></div>
            <p className={styles.instruction}>{edit.config?.instruction || '请对比原图与修改结果'}</p>
            <div className={styles.comparison}>
              <figure><figcaption>修改前</figcaption><ImagePreview src={`/api/control-plane/v1/assets/${edit.source_asset_id}`} alt={`第 ${edit.target_page} 页修改前`} /></figure>
              <figure><figcaption>修改结果</figcaption>{edit.result ? <ImagePreview src={`/api/control-plane/v1/assets/${edit.result.asset_id}`} alt={`第 ${edit.target_page} 页修改结果`} /> : <p>结果不可用</p>}</figure>
            </div>
            {!canAccept(edit) && <p className="notice warning">源图已更新或结果不可用，请拒绝此修改，保留当前图片。</p>}
            <label className={styles.choice}>处理方式
              <select aria-label={`第 ${edit.target_page} 页修改 ${edit.id} 处理方式`} disabled={busy} value={decisions[edit.id] ?? ''}
                onChange={event => choose(edit, event.target.value as Decision | '')}>
                <option value="">暂不处理</option><option value="accept" disabled={!canAccept(edit)}>采用此结果</option><option value="reject">拒绝，保留当前图片</option>
              </select>
            </label>
          </article>)}</div>
          {unfinished.length > 0 && <section className={styles.unfinished}>
            <strong>尚未生成可确认结果</strong>
            <p>可以稍后刷新等待结果，或明确取消这些修改。取消执行中的修改不会退回已产生的模型费用。</p>
            {unfinished.map(edit => <label key={edit.id} className={styles.unfinishedRow}>
              <Checkbox checked={cancelUnfinished || decisions[edit.id] === 'cancel'} disabled={busy || cancelUnfinished}
                onChange={event => choose(edit, event.target.checked ? 'cancel' : '')} />
              <span>取消第 {edit.target_page} 页 · {statusLabels[edit.status] ?? edit.status} · {edit.config?.instruction || operationLabels[edit.operation] || '图片修改'}</span>
            </label>)}
          </section>}
        </>}
      </div>
      <footer className={styles.footer}>
        {error && <p className="notice error" role="alert">{error}</p>}
        {unfinished.length > 0 && <label className={styles.cancelAll}><Checkbox checked={cancelUnfinished} disabled={busy || loading} onChange={event => setCancelUnfinished(event.target.checked)} />同时取消全部 {unfinished.length} 项未完成修改</label>}
        <div className={styles.actions}>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>稍后处理</Button>
          {edits.length > 0 ? <>
            <Button variant="outline" disabled={busy || loading || !ready.length} onClick={() => void apply(Object.fromEntries(ready.map(edit => [edit.id, 'reject'])))}>一键拒绝 {ready.length} 项</Button>
            <Button disabled={busy || loading || !ready.length || conflictingPages.length > 0 || !ready.every(canAccept)} onClick={() => void apply(Object.fromEntries(ready.map(edit => [edit.id, 'accept'])))}>一键采用 {ready.length} 项</Button>
            <Button variant="outline" disabled={busy || loading || (!Object.keys(decisions).length && !cancelUnfinished)} onClick={() => void apply(decisions)}>{busy ? '正在处理…' : '应用所选处理'}</Button>
          </> : <Button disabled={busy || loading || Boolean(error)} onClick={() => void continueReview()}>继续初审</Button>}
        </div>
      </footer>
    </DialogContent>
  </Dialog>;
}
