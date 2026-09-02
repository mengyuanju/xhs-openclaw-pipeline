'use client';

import { Files, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

import { parseBatchQueries, parseBatchReferenceUrls } from '../../src/batch-generation.mjs';
import { apiRequest } from '../components/api-client';
import type { CopyGenerationResult } from '../copy-generation/copy-generation-comparison';
import {
  BatchCopyGenerationResults,
  batchCopyResultMessage,
  type BatchCopyItem,
  type BatchCopySummary,
} from './batch-copy-generation-results';

function createItems(queries: string[]): BatchCopyItem[] {
  return queries.map((query) => ({ query, status: 'PENDING', copyResult: null, error: '', reviewError: '' }));
}

type CopyHistoryResponse = { data: CopyGenerationResult[] };

export function BatchCopyGenerationWorkbench() {
  const confirm = useConfirmDialog();
  const [imageCount, setImageCount] = useState('auto');
  const [items, setItems] = useState<BatchCopyItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [validationError, setValidationError] = useState('');
  const [historyLoadError, setHistoryLoadError] = useState('');
  const [summary, setSummary] = useState<BatchCopySummary | null>(null);
  const mountedRef = useRef(true);
  const stopRequestedRef = useRef(false);

  const loadReviewQueue = useCallback(async () => {
    try {
      const response = await apiRequest<CopyHistoryResponse>('/api/copy-generations?page=1&pageSize=50', { cache: 'no-store' });
      const unreviewed = response.data.filter((record) => record.manualReview === null);
      if (!mountedRef.current) return;
      setItems((current) => current.length > 0 ? current : unreviewed.map((copyResult) => ({
        query: copyResult.query,
        status: 'AWAITING_REVIEW',
        copyResult,
        error: '',
        reviewError: '',
      })));
      setHistoryLoadError('');
    } catch (error) {
      if (mountedRef.current) setHistoryLoadError(error instanceof Error ? error.message : '待质检文案读取失败');
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadReviewQueue();
    return () => { mountedRef.current = false; stopRequestedRef.current = true; };
  }, [loadReviewQueue]);

  function updateItem(index: number, patch: Partial<BatchCopyItem>) {
    if (!mountedRef.current) return;
    setItems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  }

  async function approveItem(index: number) {
    const item = items[index];
    if (!item?.copyResult || item.status !== 'AWAITING_REVIEW') return;
    if (!await confirm({
      title: '确认人工质检通过？',
      description: `请确认你已完整检查《${item.copyResult.copy.title}》的正文、事实依据、风险边界和配图策划。通过后该记录才可用于批量生图。`,
      confirmLabel: '确认人工质检通过',
    })) return;
    updateItem(index, { status: 'APPROVING', reviewError: '' });
    try {
      const approved = await apiRequest<CopyGenerationResult>(`/api/copy-generations/${item.copyResult.id}/manual-review`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'APPROVED' }),
      });
      updateItem(index, { status: 'APPROVED', copyResult: approved });
    } catch (error) {
      updateItem(index, {
        status: 'AWAITING_REVIEW',
        reviewError: error instanceof Error ? error.message : '人工质检结果保存失败，请重试。',
      });
    }
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    let queries: string[];
    let referenceUrls: string[];
    try {
      queries = parseBatchQueries(String(data.get('queries') ?? ''));
      referenceUrls = parseBatchReferenceUrls(String(data.get('referenceUrls') ?? ''));
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : '批量输入格式不正确');
      return;
    }
    if (!await confirm({
      title: '确认批量生成文案？',
      description: `将顺序处理 ${queries.length} 条选题，每条调用真实文案模型并联网研究。生成后停在人工质检，不会自动生成图片。`,
      confirmLabel: '确认费用并开始',
    })) return;

    const category = String(data.get('category') ?? '').trim();
    const targetAudience = String(data.get('targetAudience') ?? '').trim();
    const referenceText = String(data.get('referenceText') ?? '').trim();
    const nextSummary: BatchCopySummary = { generated: 0, failed: 0, stopped: 0 };
    setItems(createItems(queries));
    setSummary(null);
    setValidationError('');
    setStopRequested(false);
    stopRequestedRef.current = false;
    setBusy(true);

    for (const [index, query] of queries.entries()) {
      if (stopRequestedRef.current) {
        nextSummary.stopped += queries.length - index;
        if (mountedRef.current) {
          setItems((current) => current.map((item, itemIndex) => itemIndex >= index && item.status === 'PENDING' ? { ...item, status: 'STOPPED' } : item));
        }
        break;
      }
      updateItem(index, { status: 'COPYING' });
      try {
        const copyResult = await apiRequest<CopyGenerationResult>('/api/copy-generations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query,
            input: {
              ...(category ? { category } : {}),
              ...(targetAudience ? { targetAudience } : {}),
              ...(referenceText ? { referenceText } : {}),
              ...(referenceUrls.length > 0 ? { referenceUrls } : {}),
            },
            imageCount: imageCount === 'auto' ? 'auto' : Number(imageCount),
            confirmation: 'LIVE_MODEL_COST_ACCEPTED',
          }),
        });
        nextSummary.generated += 1;
        updateItem(index, {
          copyResult,
          status: copyResult.manualReview?.decision === 'APPROVED' ? 'APPROVED' : 'AWAITING_REVIEW',
        });
      } catch (error) {
        nextSummary.failed += 1;
        updateItem(index, { status: 'FAILED', error: error instanceof Error ? error.message : '文案生成失败' });
        continue;
      }
    }
    if (mountedRef.current) { setSummary(nextSummary); setBusy(false); }
  }

  return <div className="batch-generation-workspace">
    <div className="batch-generation-grid">
      <form className="panel batch-generation-form" onSubmit={generate}>
        <div className="panel-head"><div><span className="section-kicker">Batch copy input</span><h2>设置批量文案</h2></div><Files aria-hidden="true" size={20} /></div>
        <fieldset className="form-grid batch-generation-fields" disabled={busy}>
          <legend className="sr-only">批量文案参数</legend>
          <div className="field full">
            <label htmlFor="batch-copy-queries">选题列表</label>
            <textarea className="textarea batch-generation-queries" id="batch-copy-queries" name="queries" maxLength={10_019} required placeholder={'每行一个选题，2–20 条\n租房桌面怎么低成本整理？\n小户型玄关有哪些收纳误区？'} />
            <small>空行会自动忽略；重复选题会在提交前拦截。</small>
          </div>
          <div className="field"><label htmlFor="batch-copy-category">内容分类（可选）</label><input className="input" id="batch-copy-category" name="category" maxLength={100} /></div>
          <div className="field"><label htmlFor="batch-copy-audience">目标受众（可选）</label><input className="input" id="batch-copy-audience" name="targetAudience" maxLength={200} /></div>
          <div className="field full"><label htmlFor="batch-copy-reference-text">共享参考资料（可选）</label><textarea className="textarea compact" id="batch-copy-reference-text" name="referenceText" maxLength={12_000} /></div>
          <div className="field full"><label htmlFor="batch-copy-reference-urls">共享参考链接（可选）</label><textarea className="textarea compact" id="batch-copy-reference-urls" name="referenceUrls" maxLength={4_007} placeholder="每行一个 HTTP(S) 链接，最多 8 条" /></div>
          <div className="field full">
            <label htmlFor="batch-copy-image-count">每条配图策划页数</label>
            <Select value={imageCount} onValueChange={setImageCount}>
              <SelectTrigger id="batch-copy-image-count"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="auto">自动规划（3–5 页）</SelectItem><SelectItem value="3">固定 3 页</SelectItem><SelectItem value="4">固定 4 页</SelectItem><SelectItem value="5">固定 5 页</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="field full"><div className="notice">本批次只生成并保存文案。完成后必须人工质检通过，才会出现在批量生图页面。</div></div>
          <div className="field full inline batch-generation-actions"><button className="button primary" type="submit"><Sparkles aria-hidden="true" size={16} />开始批量生成文案</button><span className="subtle">严格顺序执行，不会并发调用模型。</span></div>
        </fieldset>
        {validationError && <div className="notice error batch-generation-message" role="alert">{validationError}</div>}
        {historyLoadError && <div className="notice error batch-generation-message" role="alert">待质检记录恢复失败：{historyLoadError}</div>}
      </form>
      <BatchCopyGenerationResults items={items} busy={busy} stopRequested={stopRequested} summary={summary} onStop={() => { stopRequestedRef.current = true; setStopRequested(true); }} onApprove={(index) => { void approveItem(index); }} />
    </div>
    {summary && <div className={summary.failed > 0 ? 'notice warning' : 'notice success'} role="status" aria-live="polite">{batchCopyResultMessage(summary)} 文案必须人工质检通过后才能批量生图。</div>}
  </div>;
}
