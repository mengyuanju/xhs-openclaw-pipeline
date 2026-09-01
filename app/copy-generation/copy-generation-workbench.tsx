'use client';

import { LoaderCircle, Sparkles } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { apiRequest } from '../components/api-client';
import {
  CopyGenerationComparison,
  type CopyGenerationResult,
} from './copy-generation-comparison';
import { CopyGenerationHistory } from './copy-generation-history';
import { useCopyGenerationHistory } from './use-copy-generation-history';

function referenceUrlsFrom(value: string) {
  const urls = [...new Set(value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean))];
  if (urls.length > 8) throw new Error('参考链接最多填写 8 条');
  for (const value of urls) {
    if (value.length > 500) throw new Error('单条参考链接最多 500 个字符');
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`参考链接格式不正确：${value}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error(`参考链接必须是无账号密码的 HTTP(S) 地址：${value}`);
    }
  }
  return urls;
}

export function CopyGenerationWorkbench() {
  const confirm = useConfirmDialog();
  const [imageCount, setImageCount] = useState('auto');
  const [autoReviseOnReject, setAutoReviseOnReject] = useState(false);
  const {
    result,
    setResult,
    history,
    jobs,
    timingStatistics,
    historyLoading,
    historyError,
    hasRunningJobs,
    refreshHistory,
  } = useCopyGenerationHistory();
  const [requestBusy, setRequestBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [messageIsError, setMessageIsError] = useState(false);

  function showMessage(nextMessage: string, isError: boolean) {
    setMessage(nextMessage);
    setMessageIsError(isError);
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    let referenceUrls: string[];
    try {
      referenceUrls = referenceUrlsFrom(String(data.get('referenceUrls') ?? ''));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '参考链接格式不正确');
      setMessageIsError(true);
      return;
    }

    if (!await confirm({
      title: '确认调用真实模型生成并审核文案？',
      description: autoReviseOnReject
        ? '会执行选题审核、联网研究、首稿生成与质检；存在阻断问题时还会自动重写并复检，因此耗时和模型费用会增加。'
        : '会执行选题审核、联网研究、首稿生成与质检；首稿未通过时直接保留并进入人工复核，不调用自动重写与复检。',
      confirmLabel: '确认并生成',
    })) return;

    const category = String(data.get('category') ?? '').trim();
    const targetAudience = String(data.get('targetAudience') ?? '').trim();
    const referenceText = String(data.get('referenceText') ?? '').trim();
    setRequestBusy(true);
    setMessage('');
    setMessageIsError(false);
    try {
      const generated = await apiRequest<CopyGenerationResult>('/api/copy-generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: String(data.get('query') ?? '').trim(),
          input: {
            ...(category ? { category } : {}),
            ...(targetAudience ? { targetAudience } : {}),
            ...(referenceText ? { referenceText } : {}),
            ...(referenceUrls.length > 0 ? { referenceUrls } : {}),
          },
          imageCount: imageCount === 'auto' ? 'auto' : Number(imageCount),
          autoReviseOnReject,
          confirmation: 'LIVE_MODEL_COST_ACCEPTED',
        }),
      });
      setResult(generated);
      if (generated.reviewed.review.decision !== 'PASS') {
        showMessage(generated.generation.revisionAttempted
          ? '自动重写后的文案质检仍未通过；请查看具体错误，并进行人工二次质检。'
          : '首稿质检仍未通过，已跳过自动重写并保留；请查看具体错误，并进行人工二次质检。', true);
      } else {
        showMessage(generated.original.review.decision === 'PASS'
          ? '首稿已通过质检并直接保存，无需二次改写。'
          : '首稿及针对阻断问题修订后的版本已分别保存，可在历史记录中对比。', false);
      }
      void refreshHistory({ silent: true })
        .catch(() => {
          showMessage('文案已保存，但耗时统计刷新失败；刷新页面可重试。', true);
        });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '文案生成失败');
      setMessageIsError(true);
      void refreshHistory({ silent: true }).catch(() => {});
    } finally {
      setRequestBusy(false);
    }
  }

  return <div className="stack">
    <div className="copy-generation-workspace">
      <form className="panel" onSubmit={generate}>
        <div className="panel-head">
          <div><span className="section-kicker">Generation input</span><h2>输入生成要求</h2></div>
          <Sparkles aria-hidden="true" size={20} />
        </div>
        <div className="form-grid">
          <div className="field full">
            <label htmlFor="copy-query">选题或文案目标</label>
            <textarea className="textarea compact" id="copy-query" name="query" maxLength={500} required placeholder="例如：租房桌面怎么低成本整理？" />
            <small>必填，最多 500 字。系统会先审核选题是否适合继续生成。</small>
          </div>
          <div className="field">
            <label htmlFor="copy-category">内容分类（可选）</label>
            <input className="input" id="copy-category" name="category" maxLength={100} placeholder="如：家居收纳" />
          </div>
          <div className="field">
            <label htmlFor="copy-audience">目标受众（可选）</label>
            <input className="input" id="copy-audience" name="targetAudience" maxLength={200} placeholder="如：一线城市租房上班族" />
          </div>
          <div className="field full">
            <label htmlFor="copy-reference-text">参考资料（可选）</label>
            <textarea className="textarea compact" id="copy-reference-text" name="referenceText" maxLength={12_000} placeholder="粘贴可核验的产品参数、事实资料或表达参考。" />
            <small>最多 12,000 字；参考内容会被当作不可信数据处理，不会覆盖系统规则。</small>
          </div>
          <div className="field full">
            <label htmlFor="copy-reference-urls">参考链接（可选）</label>
            <textarea className="textarea compact" id="copy-reference-urls" name="referenceUrls" placeholder={'每行一个 HTTP(S) 链接，最多 8 条\nhttps://example.com/reference'} />
          </div>
          <div className="field full">
            <label htmlFor="copy-image-count">配图策划页数</label>
            <Select value={imageCount} onValueChange={setImageCount}>
              <SelectTrigger id="copy-image-count"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">自动规划（3–5 页）</SelectItem>
                <SelectItem value="3">固定 3 页</SelectItem>
                <SelectItem value="4">固定 4 页</SelectItem>
                <SelectItem value="5">固定 5 页</SelectItem>
              </SelectContent>
            </Select>
            <small>只影响返回的图片策划建议，本次不会调用图片模型。</small>
          </div>
          <div className="field full">
            <label className="switch-field" htmlFor="copy-auto-revise">
              <input
                id="copy-auto-revise"
                type="checkbox"
                checked={autoReviseOnReject}
                aria-describedby="copy-auto-revise-help"
                onChange={(event) => setAutoReviseOnReject(event.target.checked)}
              />
              <span>首次质检不通过时自动重写</span>
            </label>
            <small id="copy-auto-revise-help">默认关闭；关闭时保留首稿和具体错误，交由人工复核，可省去一次重写与复检。</small>
          </div>
          <div className="field full">
            <div className="notice">提交后会先保存生成任务，刷新或切换页面后仍可查看状态。{autoReviseOnReject
              ? '若首稿存在阻断问题，系统会额外执行一次自动重写和复检。'
              : '若首稿存在阻断问题，系统会保留正文和错误，等待人工二次质检。'}</div>
          </div>
          <div className="field full inline">
            <button className="button primary" type="submit" disabled={historyLoading || requestBusy || hasRunningJobs}>
              {requestBusy
                ? <><LoaderCircle aria-hidden="true" className="animate-spin" size={16} />正在生成与审核…</>
                : hasRunningJobs
                  ? <><LoaderCircle aria-hidden="true" className="animate-spin" size={16} />已有任务生成中…</>
                  : historyLoading
                    ? <><LoaderCircle aria-hidden="true" className="animate-spin" size={16} />正在读取任务…</>
                    : <><Sparkles aria-hidden="true" size={16} />生成文案</>}
            </button>
            <span className="subtle">不会入队、发布或生成图片。</span>
          </div>
        </div>
      </form>
      <CopyGenerationHistory
        records={history}
        jobs={jobs}
        statistics={timingStatistics}
        selectedId={result?.id ?? null}
        loading={historyLoading}
        error={historyError}
        onSelect={setResult}
      />
    </div>
    {result && <CopyGenerationComparison
      result={result}
      onClose={() => setResult(null)}
      onMessage={showMessage}
    />}
    {message && <div className={messageIsError ? 'notice error' : 'notice success'} role={messageIsError ? 'alert' : 'status'} aria-live="polite">{message}</div>}
  </div>;
}
