'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { apiRequest } from '../components/api-client';
import { StatusPill } from '../components/status-pill';
import {
  DEMAND_LEVEL_COPY as LEVEL_COPY,
  DEMAND_LEVELS as LEVELS,
  DemandScreeningRules,
  type DemandLevel,
} from './demand-screening-rules';

const PAGE_SIZE = 50;

function initialDrafts(rows: any[]) {
  return Object.fromEntries(rows
    .filter((row) => row.isValid && row.demandLevel)
    .map((row) => [row.id, {
      demandLevel: row.demandLevel as DemandLevel,
      reason: row.screeningReason || LEVEL_COPY[row.demandLevel as DemandLevel].reason,
    }]));
}

function screeningSourceLabel(row: any) {
  if (row.screeningSource === 'OPENCLAW' || row.screeningSource === 'CODEX') {
    const label = row.screeningSource === 'CODEX' ? 'Codex' : 'OpenClaw';
    return row.screeningModel ? `${label} · ${row.screeningModel}` : label;
  }
  if (row.screeningSource === 'EXCEL') return 'Excel';
  if (row.screeningSource === 'MANUAL') return '人工';
  return '—';
}

export function DemandScreeningPanel({
  batch,
  onBatchChange,
  onMessage,
  onComplete,
}: {
  batch: any;
  onBatchChange: (batch: any) => void;
  onMessage: (message: string, isError?: boolean) => void;
  onComplete: () => void;
}) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<Record<number, { demandLevel: DemandLevel; reason: string }>>(
    () => initialDrafts(batch.rows),
  );
  const [filter, setFilter] = useState('ALL');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [dirtyRowIds, setDirtyRowIds] = useState<Set<number>>(() => new Set());
  const [bulkLevel, setBulkLevel] = useState<DemandLevel>('STRONG');
  const [saving, setSaving] = useState(false);

  const rows = useMemo(() => batch.rows.filter((row: any) => {
    if (filter === 'ALL') return true;
    if (filter === 'INVALID') return !row.isValid;
    if (!row.isValid) return false;
    const level = drafts[row.id]?.demandLevel;
    if (filter === 'PENDING') return !level;
    return level === filter;
  }), [batch.rows, drafts, filter]);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const visibleRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const selectableVisibleRows = visibleRows.filter((row: any) => row.isValid && batch.status !== 'COMMITTED');
  const pendingScreeningRows = batch.rows.filter((row: any) => row.isValid && !drafts[row.id]?.demandLevel).length;
  const allVisibleSelected = selectableVisibleRows.length > 0
    && selectableVisibleRows.every((row: any) => selected.has(row.id));
  const canComplete = batch.status !== 'COMMITTED'
    && dirtyRowIds.size === 0 && pendingScreeningRows === 0;

  function changeFilter(nextFilter: string) {
    setFilter(nextFilter);
    setPage(1);
    setSelected(new Set());
  }

  function setDecision(rowId: number, demandLevel: DemandLevel) {
    setDrafts((current) => ({
      ...current,
      [rowId]: { demandLevel, reason: LEVEL_COPY[demandLevel].reason },
    }));
    setDirtyRowIds((current) => new Set(current).add(rowId));
  }

  function setReason(rowId: number, reason: string) {
    setDrafts((current) => ({
      ...current,
      [rowId]: { ...current[rowId], reason },
    }));
    setDirtyRowIds((current) => new Set(current).add(rowId));
  }

  function toggleRow(rowId: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }

  function toggleVisibleRows() {
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected) selectableVisibleRows.forEach((row: any) => next.delete(row.id));
      else selectableVisibleRows.forEach((row: any) => next.add(row.id));
      return next;
    });
  }

  function applyBulkLevel() {
    if (selected.size === 0) return;
    setDrafts((current) => {
      const next = { ...current };
      for (const rowId of selected) {
        next[rowId] = { demandLevel: bulkLevel, reason: LEVEL_COPY[bulkLevel].reason };
      }
      return next;
    });
    setDirtyRowIds((current) => new Set([...current, ...selected]));
    setSelected(new Set());
  }

  async function saveScreening() {
    const decisions = batch.rows
      .filter((row: any) => row.isValid && dirtyRowIds.has(row.id) && drafts[row.id]?.demandLevel)
      .map((row: any) => ({ rowId: row.id, ...drafts[row.id], reason: drafts[row.id].reason.trim() }));
    if (decisions.some((decision: any) => !decision.reason)) {
      onMessage('筛选失败：每条判定都需要填写简要理由。', true);
      return;
    }
    if (decisions.length === 0) {
      onMessage('筛选结果没有变化。');
      return;
    }
    setSaving(true);
    onMessage('');
    try {
      const result = await apiRequest<any>(`/api/import-batches/${batch.id}/screen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisions }),
      });
      onBatchChange(result);
      setDirtyRowIds(new Set());
      router.refresh();
      onMessage(result.pendingScreeningRows === 0
        ? `筛选已完成：保留 ${result.admittedRows} 条，废弃 ${result.discardedRows} 条。`
        : `筛选结果已保存，仍有 ${result.pendingScreeningRows} 条待判定。`);
    } catch (error) {
      onMessage(error instanceof Error ? `筛选失败：${error.message}` : '筛选失败', true);
    } finally {
      setSaving(false);
    }
  }

  const filters = [
    ['ALL', '全部'], ['PENDING', '待判定'], ['STRONG', '强需'], ['MEDIUM', '中需'],
    ['WEAK', '弱需'], ['NONE', '无需'], ['INVALID', '格式错误'],
  ];

  return <section className="panel screening-panel" aria-labelledby="demand-screening-title">
    <div className="panel-head">
      <div><h2 id="demand-screening-title">需求强度筛选与复核</h2><span className="subtle">模型或 Excel 判定会自动带入；管理员可在入队前修正。</span></div>
      <StatusPill value={pendingScreeningRows === 0 ? 'SCREENED' : 'PENDING_SCREENING'} />
    </div>

    <DemandScreeningRules />

    <div className="screening-toolbar">
      <div className="filter-tabs" aria-label="筛选结果过滤">
        {filters.map(([value, label]) => <button className="button small" type="button" aria-pressed={filter === value} key={value} onClick={() => changeFilter(value)}>{label}</button>)}
      </div>
      <div className="inline">
        <label className="subtle" htmlFor="bulk-demand-level">批量判定</label>
        <Select value={bulkLevel} onValueChange={(value) => setBulkLevel(value as DemandLevel)} disabled={batch.status === 'COMMITTED'}>
          <SelectTrigger className="compact-control select-compact" id="bulk-demand-level"><SelectValue /></SelectTrigger>
          <SelectContent>{LEVELS.map((level) => <SelectItem value={level} key={level}>{LEVEL_COPY[level].label}</SelectItem>)}</SelectContent>
        </Select>
        <button className="button small" type="button" disabled={selected.size === 0 || batch.status === 'COMMITTED'} onClick={applyBulkLevel}>应用到已选 {selected.size || ''}</button>
      </div>
    </div>

    <div className="table-wrap mobile-cards screening-table-wrap">
      <table>
        <thead><tr><th><span className="sr-only">选择</span><input type="checkbox" aria-label="选择本页可筛选行" checked={allVisibleSelected} onChange={toggleVisibleRows} disabled={selectableVisibleRows.length === 0} /></th><th>行</th><th>选题</th><th>结构校验</th><th>需求强度</th><th>来源</th><th>判定理由</th></tr></thead>
        <tbody>{visibleRows.map((row: any) => {
          const draft = drafts[row.id];
          return <tr key={row.id}>
            <td data-label="选择"><input type="checkbox" aria-label={`选择第 ${row.rowNumber} 行`} checked={selected.has(row.id)} onChange={() => toggleRow(row.id)} disabled={!row.isValid || batch.status === 'COMMITTED'} /></td>
            <td data-label="行">{row.rowNumber}</td>
            <td className="query-cell" data-label="选题">{row.query || '—'}</td>
            <td data-label="结构校验">{row.isValid ? <StatusPill value="APPROVED" /> : <span className="pill pill-failed">{row.errors.join('；')}</span>}</td>
            <td data-label="需求强度">{row.isValid ? batch.status === 'COMMITTED' && !draft ? <span className="pill">历史准入</span> : <Select value={draft?.demandLevel} onValueChange={(value) => setDecision(row.id, value as DemandLevel)} disabled={batch.status === 'COMMITTED'}>
              <SelectTrigger className="screening-select select-compact" aria-label={`第 ${row.rowNumber} 行需求强度`}><SelectValue placeholder="待判定" /></SelectTrigger>
              <SelectContent>{LEVELS.map((level) => <SelectItem value={level} key={level}>{LEVEL_COPY[level].label}</SelectItem>)}</SelectContent>
            </Select> : '—'}</td>
            <td data-label="来源"><span className="subtle">{row.isValid ? screeningSourceLabel(row) : '—'}</span></td>
            <td data-label="判定理由">{row.isValid && draft ? <input className="input screening-reason" aria-label={`第 ${row.rowNumber} 行判定理由`} value={draft.reason} maxLength={500} onChange={(event) => setReason(row.id, event.target.value)} disabled={batch.status === 'COMMITTED'} /> : <span className="subtle">{row.isValid ? batch.status === 'COMMITTED' ? '历史批次未记录需求档位' : '选择档位后自动填入，可修改' : '结构错误无需筛选'}</span>}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    {rows.length === 0 && <div className="empty-state">当前条件下没有选题。</div>}
    {totalPages > 1 && <nav className="pagination" aria-label="需求筛选分页"><span>第 {page} / {totalPages} 页 · 共 {rows.length} 条</span><div className="inline"><button className="button small" type="button" disabled={page === 1} onClick={() => setPage((current) => current - 1)}>上一页</button><button className="button small" type="button" disabled={page === totalPages} onClick={() => setPage((current) => current + 1)}>下一页</button></div></nav>}

    <div className="screening-savebar">
      <div><strong>{pendingScreeningRows === 0 ? '筛选已完成' : `筛选未完成：${pendingScreeningRows} 条待判定`}</strong><p className="subtle">保存后仍可在入队前修正；每页最多显示 {PAGE_SIZE} 条。</p></div>
      <button
        className="button primary"
        type="button"
        disabled={saving || batch.status === 'COMMITTED' || (dirtyRowIds.size === 0 && pendingScreeningRows > 0)}
        onClick={canComplete ? onComplete : saveScreening}
      >{saving ? '保存中…' : canComplete ? '确认复核，下一步' : batch.status === 'COMMITTED' ? '批次已入队' : '保存筛选结果'}</button>
    </div>
  </section>;
}
