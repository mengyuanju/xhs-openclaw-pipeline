'use client';

import { Images, LoaderCircle, RefreshCw, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

import { parseBatchCopyGenerationIds, selectApprovedCopyGenerations } from '../../src/batch-generation.mjs';
import { apiRequest } from '../components/api-client';
import type { CopyGenerationResult } from '../copy-generation/copy-generation-comparison';
import { createRunId } from '../image-generation/run-id';
import type { ImageGenerationResult } from '../image-generation/use-image-generation-run';
import {
  BatchImageGenerationResults,
  batchImageResultMessage,
  type BatchImageItem,
  type BatchImageSummary,
} from './batch-image-generation-results';

type CopyHistoryResponse = {
  data: CopyGenerationResult[];
  pagination: { totalItems: number };
};

export function BatchImageGenerationWorkbench() {
  const confirm = useConfirmDialog();
  const [approvedCopies, setApprovedCopies] = useState<CopyGenerationResult[]>([]);
  const [totalCopies, setTotalCopies] = useState(0);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [mode, setMode] = useState<'MOCK' | 'LIVE'>('MOCK');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [validationError, setValidationError] = useState('');
  const [items, setItems] = useState<BatchImageItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [summary, setSummary] = useState<BatchImageSummary | null>(null);
  const mountedRef = useRef(true);
  const stopRequestedRef = useRef(false);

  const loadApprovedCopies = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiRequest<CopyHistoryResponse>('/api/copy-generations?page=1&pageSize=50', { cache: 'no-store' });
      const approved = selectApprovedCopyGenerations(response.data) as CopyGenerationResult[];
      if (!mountedRef.current) return;
      setApprovedCopies(approved);
      setTotalCopies(response.pagination.totalItems);
      setSelectedIds((current) => current.filter((id) => approved.some((record) => record.id === id)));
      setLoadError('');
    } catch (error) {
      if (mountedRef.current) setLoadError(error instanceof Error ? error.message : '已质检文案读取失败');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadApprovedCopies();
    return () => { mountedRef.current = false; stopRequestedRef.current = true; };
  }, [loadApprovedCopies]);

  function toggleCopy(id: number) {
    setValidationError('');
    if (!selectedIds.includes(id) && selectedIds.length >= 20) {
      setValidationError('每批最多选择 20 条已质检文案');
      return;
    }
    setSelectedIds((current) => current.includes(id)
      ? current.filter((candidate) => candidate !== id)
      : [...current, id]);
  }

  function selectAll() {
    setValidationError('');
    setSelectedIds(approvedCopies.slice(0, 20).map((record) => record.id));
  }

  function updateItem(index: number, patch: Partial<BatchImageItem>) {
    if (!mountedRef.current) return;
    setItems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    let ids: number[];
    try {
      ids = parseBatchCopyGenerationIds(selectedIds);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : '请选择已质检文案');
      return;
    }
    const selectedCopies = ids.map((id) => approvedCopies.find((record) => record.id === id)).filter((record): record is CopyGenerationResult => Boolean(record));
    if (selectedCopies.length !== ids.length) {
      setValidationError('部分文案的质检状态已变化，请刷新后重新选择');
      return;
    }
    const imageTotal = selectedCopies.reduce((total, record) => total + record.imagePlan.length, 0);
    if (!await confirm({
      title: '确认批量生成图片？',
      description: mode === 'LIVE'
        ? `将使用 ${selectedCopies.length} 条人工质检通过的文案，顺序生成约 ${imageTotal} 张真实图片，并执行 OCR 与质量检查。当前条开始后不能中途取消。`
        : `将使用 ${selectedCopies.length} 条人工质检通过的文案，生成 ${imageTotal} 张 Mock 占位图验证流程。Mock 图片不能用于发布。`,
      confirmLabel: mode === 'LIVE' ? '确认费用并开始' : '确认并开始',
    })) return;

    const nextSummary: BatchImageSummary = { completed: 0, failed: 0, stopped: 0 };
    setItems(selectedCopies.map((copyResult) => ({ copyResult, status: 'PENDING', imageResult: null, error: '' })));
    setSummary(null);
    setValidationError('');
    setStopRequested(false);
    stopRequestedRef.current = false;
    setBusy(true);

    for (const [index, copyResult] of selectedCopies.entries()) {
      if (stopRequestedRef.current) {
        nextSummary.stopped += selectedCopies.length - index;
        if (mountedRef.current) {
          setItems((current) => current.map((item, itemIndex) => itemIndex >= index && item.status === 'PENDING' ? { ...item, status: 'STOPPED' } : item));
        }
        break;
      }
      updateItem(index, { status: 'IMAGING' });
      try {
        const imageResult = await apiRequest<ImageGenerationResult>('/api/image-generations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            runId: createRunId(),
            query: copyResult.query,
            copy: copyResult.copy,
            imagePlan: copyResult.imagePlan,
            mode,
            ...(mode === 'LIVE' ? { confirmation: 'LIVE_IMAGE_COST_ACCEPTED' } : {}),
          }),
        });
        nextSummary.completed += 1;
        updateItem(index, { status: 'COMPLETED', imageResult });
      } catch (error) {
        nextSummary.failed += 1;
        updateItem(index, { status: 'FAILED', error: error instanceof Error ? error.message : '图片生成失败' });
        continue;
      }
    }
    if (mountedRef.current) { setSummary(nextSummary); setBusy(false); }
  }

  const allSelected = approvedCopies.length > 0 && approvedCopies.slice(0, 20).every((record) => selectedIds.includes(record.id));
  return <div className="batch-generation-workspace">
    <div className="batch-generation-grid">
      <form className="panel batch-generation-form" onSubmit={generate}>
        <div className="panel-head"><div><span className="section-kicker">Approved copy input</span><h2>选择已质检文案</h2></div><Images aria-hidden="true" size={20} /></div>
        <div className="notice">仅显示人工质检通过的文案；未确认的文案必须先回到批量生文完成质检。</div>
        <div className="batch-approved-toolbar">
          <label className="batch-select-all"><input type="checkbox" aria-label="选择全部已质检文案" checked={allSelected} disabled={busy || approvedCopies.length === 0} onChange={(event) => event.target.checked ? selectAll() : setSelectedIds([])} /><span>选择当前列表（最多 20 条）</span></label>
          <button className="button small" type="button" disabled={busy || loading} onClick={() => { void loadApprovedCopies(); }}><RefreshCw aria-hidden="true" className={loading ? 'animate-spin' : undefined} size={14} />刷新</button>
        </div>
        {loading ? <div className="empty-state" role="status"><LoaderCircle aria-hidden="true" className="animate-spin" size={18} />正在读取已质检文案…</div>
          : loadError ? <div className="notice error" role="alert">{loadError}</div>
          : approvedCopies.length === 0 ? <div className="batch-generation-empty"><Images aria-hidden="true" size={26} /><strong>暂无已质检文案</strong><span>当前 {totalCopies} 条文案记录中没有人工质检通过的记录。</span><Link className="button small" href="/batch-copy-generation">返回批量生文质检</Link></div>
          : <ul className="batch-approved-list">
              {approvedCopies.map((record) => <li key={record.id}>
                <label><input type="checkbox" checked={selectedIds.includes(record.id)} disabled={busy} onChange={() => toggleCopy(record.id)} /><span><strong>{record.copy.title}</strong><small>{record.query} · {record.imagePlan.length} 页 · #{record.id}</small></span></label>
              </li>)}
            </ul>}
        <div className="form-grid batch-image-options">
          <div className="field full"><label htmlFor="batch-image-mode">图片运行模式</label><Select value={mode} onValueChange={(value) => setMode(value as 'MOCK' | 'LIVE')} disabled={busy}><SelectTrigger id="batch-image-mode"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="MOCK">Mock 验证（不调用图片模型）</SelectItem><SelectItem value="LIVE">Live 生成（产生图片模型费用）</SelectItem></SelectContent></Select></div>
          <div className="field full"><div className={mode === 'LIVE' ? 'notice warning' : 'notice'}>{mode === 'LIVE' ? 'Live 会逐条生成真实图片并执行 OCR 与质量检查，开始前会确认整批费用。' : 'Mock 使用占位图验证流程，不能用于发布。'}</div></div>
          <div className="field full inline batch-generation-actions"><button className="button primary" type="submit" disabled={busy || loading}><Sparkles aria-hidden="true" size={16} />开始批量生成图片（{selectedIds.length}）</button><span className="subtle">只使用人工质检通过的当前文案。</span></div>
        </div>
        {validationError && <div className="notice error batch-generation-message" role="alert">{validationError}</div>}
      </form>
      <BatchImageGenerationResults items={items} busy={busy} stopRequested={stopRequested} summary={summary} onStop={() => { stopRequestedRef.current = true; setStopRequested(true); }} />
    </div>
    {summary && <div className={summary.failed > 0 ? 'notice warning' : 'notice success'} role="status" aria-live="polite">{batchImageResultMessage(summary)} 结果仍会保存在图片生成历史中。</div>}
  </div>;
}
