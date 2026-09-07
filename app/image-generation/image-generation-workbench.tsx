'use client';

import { Textarea, Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

import { ImagePlus, LoaderCircle, WandSparkles } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';

import { useConfirmDialog } from '@/components/ui/confirm-dialog';

import { readImageGenerationDraft } from './image-generation-draft';
import { ImageGenerationHistory } from './image-generation-history';
import { ImageGenerationProgress } from './image-generation-progress';
import { ImageGenerationResultView } from './image-generation-result';
import { useImageGenerationHistory } from './use-image-generation-history';
import { useImageGenerationRun } from './use-image-generation-run';
import { ImageSettingsEditor, defaultImageSettings } from '../components/image-controls';
import { apiRequest } from '../components/api-client';
import type { ImageGenerationResult } from './use-image-generation-run';

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
  const [imageSettings, setImageSettings] = useState(defaultImageSettings);
  const [converting, setConverting] = useState(false);
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
    cancellingRunId,
    progress,
    result,
    message,
    messageIsError,
    showMessage,
    cancelRun,
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
    if (draft.imageSettings) setImageSettings(draft.imageSettings);
  }, []);

  useEffect(() => {
    const requestedRunId = new URLSearchParams(window.location.search).get('runId');
    if (requestedRunId) void openRun(requestedRunId);
  }, [openRun]);

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
    if (!await confirm({
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
      imageSettings,
      mode: 'LIVE',
      confirmation: 'LIVE_IMAGE_COST_ACCEPTED',
    });
    await refreshHistory({ silent: true }).catch(() => {});
  }

  async function convertResult() {
    if (!result || busy || converting) return;
    setConverting(true);
    try {
      const next = await apiRequest<ImageGenerationResult>(`/api/image-generations/${result.runId}/convert`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageSettings }),
      });
      await openRun(next.runId);
      showMessage('已创建新的格式与背景版本，未调用模型。请检查成品。', false);
      await refreshHistory({ silent: true });
    } catch (error) { showMessage(error instanceof Error ? error.message : '图片转换失败', true); }
    finally { setConverting(false); }
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

  async function cancelCurrentRun() {
    if (progress?.status !== 'RUNNING' || cancellingRunId) return;
    if (!await confirm({
      title: '取消图片生成？',
      description: '系统会停止当前生成和后续页面。已经完成的模型调用可能已经产生费用，取消后无法撤回。',
      confirmLabel: '确认取消生成',
      tone: 'danger',
    })) return;
    await cancelRun(progress.runId);
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
              <Textarea className="textarea compact" id="image-query" name="query" value={form.query} onChange={(event) => updateForm('query', event.target.value)} maxLength={500} required placeholder="例如：租房桌面怎么低成本整理？" />
            </div>
            <div className="field full">
              <label htmlFor="image-title">标题</label>
              <Input className="input" id="image-title" name="title" value={form.title} onChange={(event) => updateForm('title', event.target.value)} maxLength={25} required placeholder="最多 25 字，不含感叹号或 Emoji" />
            </div>
            <div className="field full">
              <label htmlFor="image-body">正文</label>
              <Textarea className="textarea standalone-image-body" id="image-body" name="body" value={form.body} onChange={(event) => updateForm('body', event.target.value)} minLength={200} maxLength={700} required placeholder="粘贴 200–700 字已审核正文" />
            </div>
            <div className="field full">
              <label htmlFor="image-tags">标签</label>
              <Input className="input" id="image-tags" name="tags" value={form.tags} onChange={(event) => updateForm('tags', event.target.value)} required placeholder="#桌面整理 #租房生活 #低成本收纳" />
              <small>填写 3–8 个标签，用空格或逗号分隔；未写 # 时会自动补齐。</small>
            </div>
            <div className="field full">
              <label htmlFor="image-plan">图片策划 JSON</label>
              <Textarea className="textarea standalone-image-plan" id="image-plan" name="imagePlan" value={form.imagePlan} onChange={(event) => updateForm('imagePlan', event.target.value)} required placeholder={'粘贴 3–5 项 imagePlan 数组\n第一项 kind 必须为 hero'} />
              <small>每项包含 kind、headline、subtitle、bullets 和 prompt；也可粘贴包含 imagePlan 字段的对象。</small>
            </div>
            <div className="field full">
              <div className="notice warning">
                系统会按当前生产配置调用真实模型生成 3–5 张图片，并执行视觉规划、OCR 对齐和质量检查；提交前会再次确认费用。
              </div>
            </div>
            <div className="field full"><ImageSettingsEditor value={imageSettings} disabled={busy || converting} onChange={setImageSettings} /></div>
            <p className="field full subtle">布局按生产配置中的种类随机选择，可在配置模块新增布局种类。</p>
            {result && <div className="field full"><div className="image-revision-actions"><Button unstyled className="button" type="button" disabled={busy || converting} onClick={() => void convertResult()}>{converting ? '正在转换…' : '转换当前成品的格式 / 背景（不调用模型）'}</Button>{result.imageSettings && <Button unstyled className="button" type="button" disabled={busy || converting} onClick={() => { setImageSettings(result.imageSettings!); if (result.imagePlan) updateForm('imagePlan', JSON.stringify(result.imagePlan, null, 2)); }}>恢复当前查看版本的参数</Button>}</div><small>转换仅使用此版本图片和上方格式配置，不应用布局修改。旧图片保留在历史记录中。</small></div>}
            <div className="field full inline">
              <Button unstyled className="button primary" type="submit" disabled={busy || converting}>
                {busy
                  ? <><LoaderCircle aria-hidden="true" className="animate-spin" size={16} />正在生成图片…</>
                  : <><ImagePlus aria-hidden="true" size={16} />开始图片试验</>}
              </Button>
              <span className="subtle">不创建生产任务、不修改文案、不进入正式审核。</span>
            </div>
          </div>
        </form>

        {progress && <ImageGenerationProgress
          progress={progress}
          disabled={busy}
          cancelling={cancellingRunId === progress.runId}
          onCancel={() => { void cancelCurrentRun(); }}
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
