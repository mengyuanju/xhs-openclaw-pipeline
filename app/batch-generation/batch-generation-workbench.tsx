'use client';

import { Layers3, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { parseBatchQueries, parseBatchReferenceUrls } from '../../src/batch-generation.mjs';
import { apiRequest } from '../components/api-client';
import type { CopyGenerationResult } from '../copy-generation/copy-generation-comparison';
import { createRunId } from '../image-generation/run-id';
import type { ImageGenerationResult } from '../image-generation/use-image-generation-run';
import {
  BatchGenerationResults,
  batchResultMessage,
  type BatchItem,
  type BatchSummary,
} from './batch-generation-results';

function createBatchItems(queries: string[]): BatchItem[] {
  return queries.map((query) => ({
    query,
    status: 'PENDING',
    copyId: null,
    copyTitle: '',
    imageResult: null,
    failedStage: null,
    error: '',
  }));
}

export function BatchGenerationWorkbench() {
  const confirm = useConfirmDialog();
  const [imageCount, setImageCount] = useState('auto');
  const [imageMode, setImageMode] = useState<'MOCK' | 'LIVE'>('MOCK');
  const [items, setItems] = useState<BatchItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [validationError, setValidationError] = useState('');
  const [summary, setSummary] = useState<BatchSummary | null>(null);
  const mountedRef = useRef(true);
  const stopRequestedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopRequestedRef.current = true;
    };
  }, []);

  function updateItem(index: number, patch: Partial<BatchItem>) {
    if (!mountedRef.current) return;
    setItems((current) => current.map((item, itemIndex) => (
      itemIndex === index ? { ...item, ...patch } : item
    )));
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
    setValidationError('');

    const pageDescription = imageCount === 'auto' ? '每条 3–5 张' : `每条 ${imageCount} 张`;
    const accepted = await confirm({
      title: '确认批量生成？',
      description: imageMode === 'LIVE'
        ? `将顺序处理 ${queries.length} 条选题，每条调用文案模型并生成真实图片（${pageDescription}），同时执行视觉规划、OCR 对齐和质量检查。当前条开始后不能中途取消，会产生真实模型费用。`
        : `将顺序处理 ${queries.length} 条选题：文案调用真实模型，图片使用 Mock 占位图（${pageDescription}）。Mock 图片不能用于发布。`,
      confirmLabel: imageMode === 'LIVE' ? '确认费用并开始' : '确认并开始',
    });
    if (!accepted) return;

    const category = String(data.get('category') ?? '').trim();
    const targetAudience = String(data.get('targetAudience') ?? '').trim();
    const referenceText = String(data.get('referenceText') ?? '').trim();
    const nextItems = createBatchItems(queries);
    const nextSummary: BatchSummary = { completed: 0, failed: 0, stopped: 0 };
    setItems(nextItems);
    setSummary(null);
    setValidationError('');
    setStopRequested(false);
    stopRequestedRef.current = false;
    setBusy(true);

    for (const [index, query] of queries.entries()) {
      if (stopRequestedRef.current) {
        const stopped = queries.length - index;
        nextSummary.stopped += stopped;
        if (mountedRef.current) {
          setItems((current) => current.map((item, itemIndex) => (
            itemIndex >= index && item.status === 'PENDING'
              ? { ...item, status: 'STOPPED' }
              : item
          )));
        }
        break;
      }

      updateItem(index, { status: 'COPYING' });
      let generatedCopy: CopyGenerationResult;
      try {
        generatedCopy = await apiRequest<CopyGenerationResult>('/api/copy-generations', {
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
        updateItem(index, {
          copyId: generatedCopy.id,
          copyTitle: generatedCopy.copy.title,
          status: 'IMAGING',
        });
      } catch (error) {
        nextSummary.failed += 1;
        updateItem(index, {
          status: 'FAILED',
          failedStage: '文案',
          error: error instanceof Error ? error.message : '文案生成失败',
        });
        continue;
      }

      try {
        const imageResult = await apiRequest<ImageGenerationResult>('/api/image-generations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            runId: createRunId(),
            query,
            copy: generatedCopy.copy,
            imagePlan: generatedCopy.imagePlan,
            mode: imageMode,
            ...(imageMode === 'LIVE' ? { confirmation: 'LIVE_IMAGE_COST_ACCEPTED' } : {}),
          }),
        });
        nextSummary.completed += 1;
        updateItem(index, { status: 'COMPLETED', imageResult });
      } catch (error) {
        nextSummary.failed += 1;
        updateItem(index, {
          status: 'FAILED',
          failedStage: '图片',
          error: error instanceof Error ? error.message : '图片生成失败',
        });
        continue;
      }
    }

    if (mountedRef.current) {
      setSummary(nextSummary);
      setBusy(false);
    }
  }

  function requestStop() {
    stopRequestedRef.current = true;
    setStopRequested(true);
  }

  return <div className="batch-generation-workspace">
    <div className="batch-generation-grid">
      <form className="panel batch-generation-form" onSubmit={generate}>
        <div className="panel-head">
          <div>
            <span className="section-kicker">Batch input</span>
            <h2>设置批量任务</h2>
          </div>
          <Layers3 aria-hidden="true" size={20} />
        </div>
        <fieldset className="form-grid batch-generation-fields" disabled={busy}>
          <legend className="sr-only">批量生成参数</legend>
          <div className="field full">
            <label htmlFor="batch-queries">选题列表</label>
            <textarea
              className="textarea batch-generation-queries"
              id="batch-queries"
              name="queries"
              maxLength={10_019}
              required
              placeholder={'每行一个选题，2–20 条\n租房桌面怎么低成本整理？\n小户型玄关有哪些收纳误区？'}
            />
            <small>空行会自动忽略；重复选题会在提交前拦截，避免重复产生模型费用。</small>
          </div>
          <div className="field">
            <label htmlFor="batch-category">内容分类（可选）</label>
            <input className="input" id="batch-category" name="category" maxLength={100} placeholder="如：家居收纳" />
          </div>
          <div className="field">
            <label htmlFor="batch-audience">目标受众（可选）</label>
            <input className="input" id="batch-audience" name="targetAudience" maxLength={200} placeholder="如：一线城市租房上班族" />
          </div>
          <div className="field full">
            <label htmlFor="batch-reference-text">共享参考资料（可选）</label>
            <textarea className="textarea compact" id="batch-reference-text" name="referenceText" maxLength={12_000} placeholder="会作为每个选题的共同事实资料或表达参考。" />
          </div>
          <div className="field full">
            <label htmlFor="batch-reference-urls">共享参考链接（可选）</label>
            <textarea className="textarea compact" id="batch-reference-urls" name="referenceUrls" maxLength={4_007} placeholder={'每行一个 HTTP(S) 链接，最多 8 条\nhttps://example.com/reference'} />
          </div>
          <div className="field">
            <label htmlFor="batch-image-count">每条配图页数</label>
            <Select value={imageCount} onValueChange={setImageCount}>
              <SelectTrigger id="batch-image-count"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">自动规划（3–5 页）</SelectItem>
                <SelectItem value="3">固定 3 页</SelectItem>
                <SelectItem value="4">固定 4 页</SelectItem>
                <SelectItem value="5">固定 5 页</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="field">
            <label htmlFor="batch-image-mode">图片运行模式</label>
            <Select value={imageMode} onValueChange={(value) => setImageMode(value as 'MOCK' | 'LIVE')}>
              <SelectTrigger id="batch-image-mode"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="MOCK">Mock 验证（不调用图片模型）</SelectItem>
                <SelectItem value="LIVE">Live 生成（产生图片模型费用）</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="field full">
            <div className={imageMode === 'LIVE' ? 'notice warning' : 'notice'}>
              文案始终调用真实模型并进行联网研究。{imageMode === 'LIVE'
                ? '图片将逐条调用真实模型并执行 OCR 与质量检查，开始前会按整批再次确认费用。'
                : '图片使用确定性占位图验证完整链路，不能用于发布。'}
            </div>
          </div>
          <div className="field full inline batch-generation-actions">
            <button className="button primary" type="submit">
              <Sparkles aria-hidden="true" size={16} />开始批量生成
            </button>
            <span className="subtle">严格顺序执行，不会并发调用模型。</span>
          </div>
        </fieldset>
        {validationError && <div className="notice error batch-generation-message" role="alert">{validationError}</div>}
      </form>

      <BatchGenerationResults
        items={items}
        busy={busy}
        stopRequested={stopRequested}
        summary={summary}
        onStop={requestStop}
      />
    </div>

    {summary && <div className={summary.failed > 0 ? 'notice warning' : 'notice success'} role="status" aria-live="polite">
      {batchResultMessage(summary)} 已生成的文案和图片仍可在两个单次页面的历史记录中查看。
    </div>}
  </div>;
}
