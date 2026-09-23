'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, CheckCircle2, ChevronLeft, ChevronRight, Clock3, FileText, History, Inbox, Loader2, RefreshCw, RotateCcw, ShieldCheck, Trash2, UserRound, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { apiRequest } from '../components/api-client';
import { notifyWorkspaceUpdated } from '../components/workspace-updates';
import { createRequestId } from '../components/request-id';
import styles from './reassignment-queue.module.css';

type Case = {
  id: number; taskId: number; stage: string; query: string; status: string; version: number;
  resetStatus: string; cleanupStatus: string; resetError: string | null; baselineSource: string | null;
  canAssign: boolean; operatorAccountId: number; operatorName: string | null; note: string;
  createdAt: string | null; initialContent?: unknown;
  assignments?: Array<{ id: number; assignee_username_snapshot: string; assigned_at: string; ended_at: string | null }>;
};
type Account = { id: number; username: string; displayName: string; status: string; role: string; copyReviewEnabled?: boolean };
type Operation = 'reassign' | 'discard' | 'restore' | 'reset' | 'regenerate';
const root = '/api/control-plane/v1/admin/reassignment-cases';
const pageSize = 30;
const filters = [{ value: 'PENDING', label: '待处理' }, { value: 'REASSIGNED', label: '已重新分配' }, { value: 'DISCARDED', label: '已废弃' }, { value: 'ALL', label: '全部记录' }];
const statusLabels: Record<string, string> = { PENDING: '待处理', REASSIGNED: '已重新分配', DISCARDED: '已废弃' };
const resetLabels: Record<string, string> = { PENDING: '等待还原', READY: '已还原', BLOCKED: '还原受阻', REGENERATING: '生成中' };
const cleanupLabels: Record<string, string> = { PENDING: '等待清理', FAILED: '清理失败', COMPLETE: '已清理' };

function dateLabel(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return '暂无时间';
  return new Date(value).toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function caseState(item: Case) {
  if (item.status !== 'PENDING') return { label: statusLabels[item.status] ?? item.status, tone: item.status === 'REASSIGNED' ? 'good' : 'muted' };
  if (item.canAssign) return { label: '可分配', tone: 'good' };
  if (item.resetStatus === 'BLOCKED' || item.cleanupStatus === 'FAILED') return { label: '需处理', tone: 'danger' };
  return { label: '准备中', tone: 'warning' };
}

function StatusBadge({ item }: { item: Case }) {
  const state = caseState(item);
  return <span className={styles.badge} data-tone={state.tone}><span aria-hidden="true" />{state.label}</span>;
}

function PreparationStatus({ item }: { item: Case }) {
  return <div className={styles.preparation}>
    <span data-tone={item.resetStatus === 'READY' ? 'good' : item.resetStatus === 'BLOCKED' ? 'danger' : 'muted'}>
      {item.resetStatus === 'READY' ? <CheckCircle2 size={13} aria-hidden="true" /> : <RotateCcw size={13} aria-hidden="true" />}
      初稿 · {resetLabels[item.resetStatus] ?? item.resetStatus}
    </span>
    <span data-tone={item.cleanupStatus === 'COMPLETE' ? 'good' : item.cleanupStatus === 'FAILED' ? 'danger' : 'muted'}>
      {item.cleanupStatus === 'COMPLETE' ? <CheckCircle2 size={13} aria-hidden="true" /> : <Clock3 size={13} aria-hidden="true" />}
      标注 · {cleanupLabels[item.cleanupStatus] ?? '等待清理'}
    </span>
  </div>;
}

export function ReassignmentQueue() {
  const [items, setItems] = useState<Case[]>([]);
  const [total, setTotal] = useState(0), [offset, setOffset] = useState(0), [status, setStatus] = useState('PENDING');
  const [selected, setSelected] = useState<Case | null>(null), [accounts, setAccounts] = useState<Account[]>([]);
  const [target, setTarget] = useState(''), [note, setNote] = useState('');
  const [loading, setLoading] = useState(true), [detailLoading, setDetailLoading] = useState(false), [detailReady, setDetailReady] = useState(false);
  const [busy, setBusy] = useState<Operation | null>(null), [loadError, setLoadError] = useState(''), [error, setError] = useState('');
  const [accountsLoading, setAccountsLoading] = useState(true), [accountsError, setAccountsError] = useState(''), [notice, setNotice] = useState('');
  const pending = useRef(false), request = useRef<{ key: string; id: string } | null>(null);
  const loadSequence = useRef(0), detailSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true); setLoadError('');
    try {
      const page = await apiRequest<{ items: Case[]; total: number }>(`${root}?status=${status}&offset=${offset}&limit=${pageSize}`, { cache: 'no-store' });
      if (sequence !== loadSequence.current) return;
      if (offset > 0 && offset >= page.total) { setOffset(Math.max(0, Math.floor((page.total - 1) / pageSize) * pageSize)); return; }
      setItems(page.items); setTotal(page.total);
    } catch (e) {
      if (sequence === loadSequence.current) setLoadError(e instanceof Error ? e.message : '读取处置列表失败');
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [status, offset]);

  const loadAccounts = useCallback(async () => {
    setAccountsLoading(true); setAccountsError('');
    try {
      const data = await apiRequest<Account[] | { items: Account[] }>('/api/control-plane/v1/users', { cache: 'no-store' });
      setAccounts((Array.isArray(data) ? data : data.items).filter(a => a.status === 'ACTIVE' && (a.role === 'ADMIN' || a.copyReviewEnabled)));
    } catch (e) { setAccountsError(e instanceof Error ? e.message : '读取接手账号失败'); }
    finally { setAccountsLoading(false); }
  }, []);

  useEffect(() => { void load(); return () => { loadSequence.current++; }; }, [load]);
  useEffect(() => { void loadAccounts(); }, [loadAccounts]);
  useEffect(() => () => { detailSequence.current++; }, []);

  async function open(item: Case) {
    const sequence = ++detailSequence.current;
    setSelected(item); setDetailLoading(true); setDetailReady(false); setError(''); setTarget(''); setNote('');
    try {
      const detail = await apiRequest<Case>(`${root}/${item.id}`, { cache: 'no-store' });
      if (sequence === detailSequence.current) { setSelected({ ...detail, operatorName: detail.operatorName ?? item.operatorName }); setDetailReady(true); }
    } catch (e) { if (sequence === detailSequence.current) setError(e instanceof Error ? e.message : '读取详情失败'); }
    finally { if (sequence === detailSequence.current) setDetailLoading(false); }
  }

  function close() {
    if (pending.current) return;
    detailSequence.current++; setSelected(null); setError('');
  }

  async function act(operation: Operation) {
    if (!selected || !detailReady || pending.current) return;
    if (['reassign', 'discard', 'restore'].includes(operation) && !note.trim()) { setError('请填写处理原因'); return; }
    if (operation === 'reassign' && !target) { setError('请选择接手账号'); return; }
    pending.current = true; setBusy(operation); setError(''); setNotice('');
    const payload = { expectedVersion: selected.version, note: note.trim(), ...(operation === 'reassign' ? { targetAccountId: Number(target) } : {}) };
    const key = JSON.stringify({ id: selected.id, operation, payload });
    if (request.current?.key !== key) request.current = { key, id: createRequestId() };
    try {
      await apiRequest(`${root}/${selected.id}/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, requestId: request.current.id }) });
      notifyWorkspaceUpdated(); setSelected(null);
      setNotice(operation === 'reassign' ? '已分配初始数据，原账号统计保留。' : operation === 'discard' ? '已最终废弃，原质检日期的统计已更新。' : operation === 'restore' ? '已撤销废弃，任务恢复待二次分配。' : '处理已提交，可刷新列表查看最新结果。');
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); }
    finally { pending.current = false; setBusy(null); }
  }

  return <div className={styles.page}>
    <header className={styles.header}>
      <div className={styles.heading}>
        <span className={styles.headerIcon}><Users size={24} aria-hidden="true" /></span>
        <div><div className={styles.titleRow}><h1>待二次分配</h1><span className={styles.adminLabel}>管理员处置</span></div><p>集中处理复检未通过的任务，让已还原的初稿重新进入创作流程。</p></div>
      </div>
      <Button variant="outline" disabled={loading} onClick={() => void load()}><RefreshCw size={15} aria-hidden="true" className={loading ? styles.spin : undefined} />{loading ? '刷新中' : '刷新列表'}</Button>
    </header>

    <div className={styles.guide}>
      <div className={styles.guideIntro}><ShieldCheck size={18} aria-hidden="true" /><strong>分配前准备</strong></div>
      <ol><li><span>1</span>还原机器初稿</li><li><span>2</span>清理旧标注</li><li><span>3</span>分配新操作者</li></ol>
      <p>原操作者的历史质检统计保留</p>
    </div>

    {notice && <div role="status" className={styles.notice}><CheckCircle2 size={17} aria-hidden="true" />{notice}</div>}

    <section className={styles.panel} aria-label="二次分配任务列表">
      <div className={styles.toolbar}>
        <div className={styles.filters} role="group" aria-label="处置状态">
          {filters.map(filter => <Button unstyled key={filter.value} className={styles.filter} aria-pressed={status === filter.value} onClick={() => { if (status !== filter.value) { setStatus(filter.value); setOffset(0); setNotice(''); } }}>{filter.label}</Button>)}
        </div>
        <span className={styles.count}>{loading || loadError ? '—' : total} 条记录</span>
      </div>

      {loading ? <div className={styles.empty} role="status"><Loader2 size={28} className={styles.spin} aria-hidden="true" /><strong>正在加载处置记录</strong><p>请稍候，正在获取最新任务状态。</p></div>
        : loadError ? <div className={styles.empty} role="alert"><AlertCircle size={30} aria-hidden="true" /><strong>处置列表加载失败</strong><p>{loadError}</p><Button variant="outline" onClick={() => void load()}>重新加载</Button></div>
          : !items.length ? <div className={styles.empty}><span className={styles.emptyIcon}><Inbox size={30} aria-hidden="true" /></span><strong>{status === 'PENDING' ? '暂无待二次分配的任务' : '暂无处置记录'}</strong><p>{status === 'PENDING' ? '复检未通过并提交管理员的任务会出现在这里。' : '当前状态下没有记录，可切换其他状态查看。'}</p>{status !== 'PENDING' && <Button variant="outline" onClick={() => { setStatus('PENDING'); setOffset(0); }}>返回待处理</Button>}</div>
            : <div className={styles.tableScroll} role="region" aria-label="任务明细，可横向滚动" tabIndex={0}>
              <table className={styles.table}>
                <thead><tr><th scope="col">任务信息</th><th scope="col">原操作者</th><th scope="col">移交原因</th><th scope="col">分配前准备</th><th scope="col">处置状态</th><th scope="col">操作</th></tr></thead>
                <tbody>{items.map(item => <tr key={item.id}>
                  <td><div className={styles.taskMeta}><span>#{item.taskId}</span><span className={styles.stage}>{item.stage === 'COPY' ? '文案' : '图片'}</span></div><p className={styles.query} title={item.query}>{item.query || '未命名任务'}</p><span className={styles.timestamp}>移交于 {dateLabel(item.createdAt)}</span></td>
                  <td><div className={styles.operator}><UserRound size={14} aria-hidden="true" /><span>{item.operatorName || `账号 #${item.operatorAccountId}`}</span></div></td>
                  <td><p className={styles.reason} title={item.note}>{item.note || '未填写移交原因'}</p></td>
                  <td><PreparationStatus item={item} />{item.resetError && <p className={styles.rowError} title={item.resetError}>{item.resetError}</p>}</td>
                  <td><StatusBadge item={item} /></td>
                  <td><Button variant="outline" size="sm" className={item.canAssign ? styles.assignButton : undefined} aria-label={`查看处置：任务 #${item.taskId}`} onClick={() => void open(item)}>{item.status === 'PENDING' ? '查看处置' : '查看记录'}<ArrowRight size={13} aria-hidden="true" /></Button></td>
                </tr>)}</tbody>
              </table>
            </div>}

      <footer className={styles.pagination}>
        <span>{loading ? '正在更新列表…' : loadError ? '请重新加载列表' : total ? `显示 ${offset + 1}–${Math.min(offset + pageSize, total)} 条，共 ${total} 条` : '共 0 条记录'}</span>
        <div><Button variant="outline" size="sm" disabled={loading || !!loadError || !offset} onClick={() => setOffset(Math.max(0, offset - pageSize))}><ChevronLeft size={14} aria-hidden="true" />上一页</Button><span>{loading || loadError ? '—' : `${Math.floor(offset / pageSize) + 1} / ${Math.max(1, Math.ceil(total / pageSize))}`}</span><Button variant="outline" size="sm" disabled={loading || !!loadError || offset + pageSize >= total} onClick={() => setOffset(offset + pageSize)}>下一页<ChevronRight size={14} aria-hidden="true" /></Button></div>
      </footer>
    </section>

    <Dialog open={!!selected} onOpenChange={isOpen => { if (!isOpen) close(); }}>
      <DialogContent className={styles.dialog} showCloseButton={!busy}>
        <header className={styles.dialogHeader}><span className={styles.eyebrow}>二次分配 · 管理员处置</span><DialogTitle className={styles.dialogTitle}>任务 #{selected?.taskId}</DialogTitle><DialogDescription className={styles.description}>重新分配后，接手账号须重新标注并接受完整质检。</DialogDescription></header>
        {error && <div className={styles.dialogError}><div className={styles.error} role="alert"><AlertCircle size={17} aria-hidden="true" /><span>{error}</span>{!detailReady && selected && <Button variant="outline" size="sm" onClick={() => void open(selected)}>重试</Button>}</div></div>}
        {detailLoading ? <div className={styles.empty} role="status"><Loader2 size={26} className={styles.spin} aria-hidden="true" /><strong>正在读取任务详情</strong></div> : selected && <div className={styles.dialogBody}>
          {detailReady && <>
            <section className={styles.summary}>
              <div className={styles.summaryTitle}><span className={styles.stage}>{selected.stage === 'COPY' ? '文案' : '图片'}</span><StatusBadge item={selected} /></div>
              <h3>{selected.query || '未命名任务'}</h3>
              <dl><div><dt>原操作者</dt><dd>{selected.operatorName || `账号 #${selected.operatorAccountId}`}</dd></div><div><dt>移交时间</dt><dd>{dateLabel(selected.createdAt)}</dd></div></dl>
              <div className={styles.handoffReason}><span>移交原因</span><p>{selected.note || '未填写移交原因'}</p></div>
            </section>

            <section className={styles.detailSection}>
              <h3><ShieldCheck size={16} aria-hidden="true" />分配前准备</h3>
              <PreparationStatus item={selected} />
              {selected.resetError && <p className={styles.blocker}><AlertCircle size={14} aria-hidden="true" />{selected.resetError}</p>}
              {selected.status === 'PENDING' && <p className={styles.help}>{selected.canAssign ? '初稿还原和旧标注清理已完成，可以分配给接手账号。' : selected.resetStatus === 'REGENERATING' ? '正在重新生成初始数据，请稍后刷新列表查看进度。' : '完成初稿还原和旧标注清理后，才能进行二次分配。'}</p>}
              {selected.status === 'PENDING' && <div className={styles.repairActions}><Button variant="outline" size="sm" disabled={!!busy || selected.resetStatus === 'REGENERATING'} onClick={() => void act('reset')}><RotateCcw size={14} aria-hidden="true" />{busy === 'reset' ? '正在重试…' : '重试还原 / 清理'}</Button>{selected.resetStatus === 'BLOCKED' && !selected.baselineSource && <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void act('regenerate')}>{busy === 'regenerate' ? '正在提交…' : '重新生成初始数据'}</Button>}</div>}
            </section>

            <div className={styles.disclosures}>
              <details><summary><FileText size={15} aria-hidden="true" />查看初始数据</summary><pre>{selected.initialContent ? JSON.stringify(selected.initialContent, null, 2) : '没有可信机器初稿，尚未清理旧内容。'}</pre></details>
              <details><summary><History size={15} aria-hidden="true" />分配记录<span>{selected.assignments?.length ?? 0}</span></summary>{selected.assignments?.length ? <ol className={styles.history}>{selected.assignments.map(assignment => <li key={assignment.id}><div><strong>{assignment.assignee_username_snapshot}</strong><span>{assignment.ended_at ? '已结束' : '当前分配'}</span></div><time>{dateLabel(assignment.assigned_at)}</time></li>)}</ol> : <p className={styles.help}>暂无分配记录。</p>}</details>
            </div>

            {['PENDING', 'DISCARDED'].includes(selected.status) && <section className={styles.detailSection}>
              <h3><Users size={16} aria-hidden="true" />{selected.status === 'DISCARDED' ? '恢复任务' : '分配与处置'}</h3>
              {selected.status === 'PENDING' && <div className={styles.field}>
                <label htmlFor="reassignment-target">接手账号</label>
                <Select value={target} disabled={!!busy || !selected.canAssign || accountsLoading || !!accountsError} onValueChange={setTarget}>
                  <SelectTrigger id="reassignment-target" aria-describedby="reassignment-accounts-help"><SelectValue placeholder={accountsLoading ? '正在加载账号…' : '请选择接手账号'} /></SelectTrigger>
                  <SelectContent>{accounts.map(account => <SelectItem key={account.id} value={String(account.id)}>{account.displayName || account.username}（{account.username}）</SelectItem>)}</SelectContent>
                </Select>
                <span id="reassignment-accounts-help" className={styles.help}>{accountsError || (!accountsLoading && !accounts.length ? '暂无可用账号，请先在用户管理中启用具有标注权限的账号。' : '仅显示已启用且具有文案标注权限的账号。')}</span>
              </div>}
              {selected.status === 'PENDING' && accountsError && <Button variant="outline" size="sm" disabled={accountsLoading} onClick={() => void loadAccounts()}>重新加载账号</Button>}
              <label className={styles.field}>{selected.status === 'DISCARDED' ? '恢复原因' : '处理原因'}<textarea maxLength={1000} rows={3} value={note} disabled={!!busy} placeholder={selected.status === 'DISCARDED' ? '请说明恢复任务的原因' : '请说明重新分配或废弃的原因，便于后续追溯'} onChange={event => setNote(event.target.value)} /><span className={styles.fieldFoot}><span>分配、废弃或恢复时必填</span><span>{note.length} / 1000</span></span></label>
            </section>}
            <p className={styles.dialogNote}>原操作者的已判定总量包含该条任务；最终废弃会更新原质检日期的统计。</p>
          </>}
        </div>}
        {detailReady && selected && <footer className={styles.dialogFooter}>
          {selected.status === 'PENDING' ? <div className={styles.dispositionActions}>
            <Button variant="outline" className={styles.dangerButton} disabled={!!busy || !note.trim() || selected.resetStatus === 'REGENERATING'} onClick={() => void act('discard')}><Trash2 size={15} aria-hidden="true" />{busy === 'discard' ? '正在废弃…' : '最终废弃'}</Button>
            <Button disabled={!!busy || !selected.canAssign || !target || !note.trim() || accountsLoading || !!accountsError} onClick={() => void act('reassign')}><Users size={15} aria-hidden="true" />{busy === 'reassign' ? '正在分配…' : '确认二次分配'}</Button>
          </div> : selected.status === 'DISCARDED' ? <Button disabled={!!busy || !note.trim()} onClick={() => void act('restore')}><RotateCcw size={15} aria-hidden="true" />{busy === 'restore' ? '正在恢复…' : '撤销废弃，恢复待二次分配'}</Button> : <Button variant="outline" onClick={close}>关闭记录</Button>}
        </footer>}
      </DialogContent>
    </Dialog>
  </div>;
}
