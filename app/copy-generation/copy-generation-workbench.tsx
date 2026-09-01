'use client';

import { Copy, FileText, LoaderCircle, RotateCcw, Sparkles } from 'lucide-react';
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

type CopyGenerationResult = {
  copy: { title: string; body: string; tags: string[] };
  imagePlan: unknown[];
  generation: { model: string; imageCount: number };
};

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

function copyText(result: CopyGenerationResult) {
  const tags = result.copy.tags
    .map((tag) => tag.startsWith('#') ? tag : `#${tag}`)
    .join(' ');
  return [result.copy.title, result.copy.body, tags].filter(Boolean).join('\n\n');
}

export function CopyGenerationWorkbench() {
  const confirm = useConfirmDialog();
  const [imageCount, setImageCount] = useState('auto');
  const [result, setResult] = useState<CopyGenerationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [messageIsError, setMessageIsError] = useState(false);

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
      title: '确认调用真实模型生成文案？',
      description: '会执行选题审核、联网研究、文案生成和文本审核，可能产生模型费用；不会生成图片或写入任务队列。',
      confirmLabel: '确认并生成',
    })) return;

    const category = String(data.get('category') ?? '').trim();
    const targetAudience = String(data.get('targetAudience') ?? '').trim();
    const referenceText = String(data.get('referenceText') ?? '').trim();
    setBusy(true);
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
          confirmation: 'LIVE_MODEL_COST_ACCEPTED',
        }),
      });
      setResult(generated);
      setMessage('文案生成并审核完成。结果仅保留在当前页面，请及时复制。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '文案生成失败');
      setMessageIsError(true);
    } finally {
      setBusy(false);
    }
  }

  async function copyResult() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(copyText(result));
      setMessage('标题、正文和标签已复制到剪贴板。');
      setMessageIsError(false);
    } catch {
      setMessage('复制失败，请手动选择结果内容。');
      setMessageIsError(true);
    }
  }

  function clearResult() {
    setResult(null);
    setMessage('结果已从当前页面清除。');
    setMessageIsError(false);
  }

  return <div className="stack">
    <div className="grid gap-4 xl:grid-cols-[minmax(360px,0.82fr)_minmax(0,1.18fr)] xl:items-start">
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
            <div className="notice">提交会调用真实模型并产生费用。单次只允许一个生成请求，结果不会自动保存。</div>
          </div>
          <div className="field full inline">
            <button className="button primary" type="submit" disabled={busy}>
              {busy ? <><LoaderCircle aria-hidden="true" className="animate-spin" size={16} />正在生成与审核…</> : <><Sparkles aria-hidden="true" size={16} />生成文案</>}
            </button>
            <span className="subtle">不会入队、发布或生成图片。</span>
          </div>
        </div>
      </form>

      <section className="panel xl:sticky xl:top-24" aria-labelledby="copy-result-heading" aria-live="polite">
        <div className="panel-head">
          <div><span className="section-kicker">Generated copy</span><h2 id="copy-result-heading">生成结果</h2></div>
          {result && <div className="inline">
            <button className="button small" type="button" onClick={copyResult}><Copy aria-hidden="true" size={14} />复制全文</button>
            <button className="button small" type="button" onClick={clearResult}><RotateCcw aria-hidden="true" size={14} />清除</button>
          </div>}
        </div>
        {!result ? <div className="empty-state">
          <FileText aria-hidden="true" size={32} />
          <h3>等待生成文案</h3>
          <p>提交左侧要求后，标题、正文和标签会显示在这里。</p>
        </div> : <div>
          <h3 className="review-task-copy-title">{result.copy.title}</h3>
          <div className="review-copy-body">{result.copy.body}</div>
          <div className="review-copy-tags" aria-label="文案标签">
            {result.copy.tags.map((tag) => <span className="pill" key={tag}>{tag.startsWith('#') ? tag : `#${tag}`}</span>)}
          </div>
          <div className="notice">
            已返回 {result.imagePlan.length} 页配图策划建议，但未调用图片模型。文案模型：<span className="mono">{result.generation.model}</span>
          </div>
        </div>}
      </section>
    </div>
    {message && <div className={messageIsError ? 'notice error' : 'notice success'} role={messageIsError ? 'alert' : 'status'} aria-live="polite">{message}</div>}
  </div>;
}
