'use client';

import { ImagePlus, LoaderCircle, WandSparkles } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';

import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { readImageGenerationDraft } from './image-generation-draft';
import { ImageGenerationHistory } from './image-generation-history';
import { ImageGenerationProgress } from './image-generation-progress';
import { ImageGenerationResultView } from './image-generation-result';
import { useImageGenerationHistory } from './use-image-generation-history';
import { useImageGenerationRun } from './use-image-generation-run';

type ImageGenerationForm = {
  query: string;
  title: string;
  body: string;
  tags: string;
  imagePlan: string;
};

const EMPTY_FORM: ImageGenerationForm = {
  query: '',
  title: '',
  body: '',
  tags: '',
  imagePlan: '',
};

function tagsFrom(value: string) {
  return [...new Set(value.split(/[\s,，;；]+/u).map((item) => item.trim()).filter(Boolean))]
    .map((tag) => tag.startsWith('#') ? tag : `#${tag}`);
}

function imagePlanFrom(value: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('图片策划必须是合法 JSON');
  }
  const plan = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && 'imagePlan' in parsed
      ? (parsed as { imagePlan?: unknown }).imagePlan
      : null;
  if (!Array.isArray(plan)) throw new Error('图片策划 JSON 必须是数组，或包含 imagePlan 数组');
  return plan;
}

export function ImageGenerationWorkbench() {
  const confirm = useConfirmDialog();
  const [form, setForm] = useState(EMPTY_FORM);
  const [importedDraft, setImportedDraft] = useState(false);
  const [mode, setMode] = useState<'MOCK' | 'LIVE'>('MOCK');
  const {
    records,
    total,
    loading: historyLoading,
    error: historyError,
    refreshHistory,
  } = useImageGenerationHistory();
  const {
    runId,
    busy,
    openingRunId,
    progress,
    result,
    message,
    messageIsError,
    showMessage,
    openRun,
    retryRun,
    startRun,
  } = useImageGenerationRun();

  useEffect(() => {
    const draft = readImageGenerationDraft(window.sessionStorage);
    if (!draft) return;
    setForm({
      query: draft.query,
      title: draft.copy.title,
      body: draft.copy.body,
      tags: draft.copy.tags.map((tag) => tag.startsWith('#') ? tag : `#${tag}`).join(' '),
      imagePlan: JSON.stringify(draft.imagePlan, null, 2),
    });
    setImportedDraft(true);
  }, []);

  function updateForm(field: keyof ImageGenerationForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    let imagePlan: unknown[];
    try {
      imagePlan = imagePlanFrom(String(data.get('imagePlan') ?? ''));
    } catch (error) {
      showMessage(error instanceof Error ? error.message : '图片策划格式不正确', true);
      return;
    }
    if (mode === 'LIVE' && !await confirm({
      title: '确认调用真实图片模型？',
      description: `本次会执行视觉规划、生成 ${imagePlan.length} 张图片、逐页 OCR 对齐和整套质量检查，会产生真实模型费用。`,
      confirmLabel: '确认费用并生成',
    })) return;

    await startRun({
      query: String(data.get('query') ?? '').trim(),
      copy: {
        title: String(data.get('title') ?? '').trim(),
        body: String(data.get('body') ?? '').trim(),
        tags: tagsFrom(String(data.get('tags') ?? '')),
      },
      imagePlan,
      mode,
      ...(mode === 'LIVE' ? { confirmation: 'LIVE_IMAGE_COST_ACCEPTED' as const } : {}),
    });
    await refreshHistory({ silent: true }).catch(() => {});
  }

  async function resumeRun() {
    if (!progress?.canResume || busy) return;
    if (!await confirm({
      title: '确认重新验收并继续？',
      description: `将复用已生成图片，重新执行 OCR 与图文对齐；未生成或验收不通过的页面会继续调用图片模型，仍会产生真实模型费用。当前已生成 ${progress.generatedImages}/${progress.totalImages} 张。`,
      confirmLabel: '确认费用并继续',
    })) return;
    await retryRun(progress.runId);
    await refreshHistory({ silent: true }).catch(() => {});
  }

  return <div className="standalone-image-workspace">
    {importedDraft && <div className="notice success" role="status" aria-live="polite">
      已从“单独生成文案”导入当前版本，标题、正文、标签和图片策划均已回填，可继续修改后生成。
    </div>}
    <div className="standalone-image-workspace-grid">
      <div className="standalone-image-main">
        <form className="panel" onSubmit={generate}>
          <div className="panel-head">
            <div><span className="section-kicker">Image input</span><h2>输入已完成文案</h2></div>
            <WandSparkles aria-hidden="true" size={20} />
          </div>
          <div className="form-grid">
            <div className="field full">
              <label htmlFor="image-query">Query</label>
              <textarea className="textarea compact" id="image-query" name="query" value={form.query} onChange={(event) => updateForm('query', event.target.value)} maxLength={500} required placeholder="例如：租房桌面怎么低成本整理？" />
            </div>
            <div className="field full">
              <label htmlFor="image-title">标题</label>
              <input className="input" id="image-title" name="title" value={form.title} onChange={(event) => updateForm('title', event.target.value)} maxLength={25} required placeholder="最多 25 字，不含感叹号或 Emoji" />
            </div>
            <div className="field full">
              <label htmlFor="image-body">正文</label>
              <textarea className="textarea standalone-image-body" id="image-body" name="body" value={form.body} onChange={(event) => updateForm('body', event.target.value)} minLength={200} maxLength={700} required placeholder="粘贴 200–700 字已审核正文" />
            </div>
            <div className="field full">
              <label htmlFor="image-tags">标签</label>
              <input className="input" id="image-tags" name="tags" value={form.tags} onChange={(event) => updateForm('tags', event.target.value)} required placeholder="#桌面整理 #租房生活 #低成本收纳" />
              <small>填写 3–8 个标签，用空格或逗号分隔；未写 # 时会自动补齐。</small>
            </div>
            <div className="field full">
              <label htmlFor="image-plan">图片策划 JSON</label>
              <textarea className="textarea standalone-image-plan" id="image-plan" name="imagePlan" value={form.imagePlan} onChange={(event) => updateForm('imagePlan', event.target.value)} required placeholder={'粘贴 3–5 项 imagePlan 数组\n第一项 kind 必须为 hero'} />
              <small>每项包含 kind、headline、subtitle、bullets 和 prompt；也可粘贴包含 imagePlan 字段的对象。</small>
            </div>
            <div className="field full">
              <label htmlFor="image-mode">运行模式</label>
              <Select value={mode} onValueChange={(value) => setMode(value as 'MOCK' | 'LIVE')}>
                <SelectTrigger id="image-mode"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="MOCK">Mock 验证（不调用模型）</SelectItem>
                  <SelectItem value="LIVE">Live 生成（产生模型费用）</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="field full">
              <div className={mode === 'LIVE' ? 'notice warning' : 'notice'}>
                {mode === 'LIVE'
                  ? 'Live 会按当前生产配置生成 3–5 张图片，并执行视觉规划、OCR 对齐和质量检查；提交前会再次确认费用。'
                  : 'Mock 使用确定性占位图验证分页、尺寸、文件和预览，不会调用任何外部模型。'}
              </div>
            </div>
            <div className="field full inline">
              <button className="button primary" type="submit" disabled={busy}>
                {busy
                  ? <><LoaderCircle aria-hidden="true" className="animate-spin" size={16} />正在生成图片…</>
                  : <><ImagePlus aria-hidden="true" size={16} />开始图片试验</>}
              </button>
              <span className="subtle">不创建生产任务、不修改文案、不进入正式审核。</span>
            </div>
          </div>
        </form>

        {progress && <ImageGenerationProgress
          progress={progress}
          disabled={busy}
          onResume={() => { void resumeRun(); }}
        />}

        {result && <ImageGenerationResultView result={result} />}

        {message && <div className={messageIsError ? 'notice error' : 'notice success'} role={messageIsError ? 'alert' : 'status'} aria-live="polite">{message}</div>}
      </div>
      <ImageGenerationHistory
        records={records}
        total={total}
        selectedRunId={runId}
        openingRunId={openingRunId}
        loading={historyLoading}
        error={historyError}
        disabled={busy || openingRunId !== null}
        onSelect={(record) => { void openRun(record.runId); }}
        onRefresh={() => { void refreshHistory().catch(() => {}); }}
      />
    </div>
  </div>;
}
