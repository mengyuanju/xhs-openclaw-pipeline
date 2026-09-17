'use client';

import { Button } from '@/components/ui/button';
import { ToastFeedback } from '@/components/ui/sonner';
import { Input, Switch } from '@/components/ui/input';
import { ClipboardCheck, RefreshCw, Save } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { apiRequest } from '../components/api-client';
import {
  normalizeWorkflowQualitySettings,
  type WorkflowQualitySettings,
} from '../query-packages/types';
import { samplingRateBpsFromInput, samplingRateInputValue } from './sampling-rate-input';
import styles from './workflow-quality-settings.module.css';

const ENDPOINT = '/api/control-plane/v1/workflow-quality-settings';

function editableSettings(settings: WorkflowQualitySettings) {
  return {
    queryPackage: { ...settings.queryPackage },
    copySampling: { ...settings.copySampling },
    imageSampling: { ...settings.imageSampling },
  };
}

export function WorkflowQualitySettingsPanel() {
  const [saved, setSaved] = useState<WorkflowQualitySettings | null>(null);
  const [draft, setDraft] = useState<ReturnType<typeof editableSettings> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [copyRateInput, setCopyRateInput] = useState<string | null>(null);
  const [imageRateInput, setImageRateInput] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const payload = await apiRequest<unknown>(ENDPOINT);
      const next = normalizeWorkflowQualitySettings(payload);
      if (!next) throw new Error('中心返回的流程质检配置不完整');
      setSaved(next);
      setDraft(editableSettings(next));
      setCopyRateInput(null);
      setImageRateInput(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '流程质检配置读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!saved || !draft || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const payload = await apiRequest<unknown>(ENDPOINT, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: saved.version, ...draft }),
      });
      const next = normalizeWorkflowQualitySettings(payload);
      if (!next) throw new Error('配置已提交，但中心没有返回有效的新版本');
      setSaved(next);
      setDraft(editableSettings(next));
      setCopyRateInput(null);
      setImageRateInput(null);
      setMessage('流程与抽检配置已保存；后续进入对应环节的作业使用新配置。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '流程质检配置保存失败');
    } finally {
      setBusy(false);
    }
  }

  const disabled = loading || busy || !draft;
  const changed = Boolean(saved && draft
    && JSON.stringify(editableSettings(saved)) !== JSON.stringify(draft));
  const ratePercent = (draft?.copySampling.rateBps ?? 0) / 100;
  const imageRatePercent = (draft?.imageSampling.rateBps ?? 0) / 100;

  return <section className="panel settings-section" aria-labelledby="workflow-quality-settings-title" aria-busy={loading || busy}>
    <div className="panel-head">
      <div>
        <span className="section-kicker">Workflow quality</span>
        <h2 id="workflow-quality-settings-title">流程与图文抽检</h2>
        <p className="subtle">文案与图片使用独立抽检比例。图片初审始终由任务作业员完成，图片质检权限在用户管理中设置。</p>
      </div>
      <ClipboardCheck size={20} aria-hidden="true" />
    </div>

    {loading && <div className="empty-state" role="status">正在读取流程质检配置…</div>}
    {!loading && !draft && <div className="empty-state"><p>流程质检配置暂不可用，已停用编辑以避免覆盖真实数据。</p><Button unstyled className="button" type="button" onClick={() => { void load(); }}>重新读取</Button></div>}
    {draft && <>
      <div className={styles.modeSummary} aria-label="当前配置摘要">
        <span className="pill">文案抽检：{draft.copySampling.enabled ? `${ratePercent}%` : '关闭'}</span>
        <span className="pill">审核员视图：{draft.copySampling.blindReviewEnabled ? '盲评' : '非盲评'}</span>
        <span className="pill">质检权限包含单条和整批打回</span>
        <span className="pill">图片抽检：{draft.imageSampling.enabled ? `${imageRatePercent}%` : '关闭'}</span>
      </div>
      <div className={styles.grid}>
        <div className={styles.card}>
          <div className={styles.cardText}>
            <label htmlFor="copy-sampling-enabled">启用文案抽检</label>
            <p>文案人工审核结果提交后，以最终达标版本为候选；同批任务等待抽检结论后再继续。关闭普通抽检不影响返工稿的强制复检。</p>
          </div>
          <Switch id="copy-sampling-enabled" checked={draft.copySampling.enabled} disabled={disabled}
            onChange={(event) => { setMessage(''); setDraft((current) => current ? { ...current, copySampling: { ...current.copySampling, enabled: event.target.checked } } : current); }} />
        </div>
        <div className={styles.card}>
          <div className={styles.cardText}>
            <label htmlFor="copy-sampling-blind">启用独立盲评</label>
            <p>开启后，非管理员质检员看不到任务号、词包名称、上游人员身份、原评分和原因；管理员始终使用完整信息视图。此开关与抽检比例、打回权限彼此独立。</p>
          </div>
          <Switch id="copy-sampling-blind" checked={draft.copySampling.blindReviewEnabled} disabled={disabled}
            onChange={(event) => { setMessage(''); setDraft((current) => current ? { ...current, copySampling: { ...current.copySampling, blindReviewEnabled: event.target.checked } } : current); }} />
        </div>
        <div className={styles.rate}>
          <div className={styles.rateText}>
            <label htmlFor="copy-sampling-rate">抽检比例</label>
            <p>按最终审核人独立累计：20% 每满 5 条抽 1 条，100% 全检。结批或等待 30 分钟后，非空余量保底抽 1 条。开启抽检时 0% 仅在结批时保底抽检；关闭抽检不影响强制复检。比例修改只影响后续冻结。</p>
          </div>
          <div className={styles.rateControl}>
            <Input id="copy-sampling-rate" type="number" min={0} max={100} step={0.01} value={samplingRateInputValue(draft.copySampling.rateBps, copyRateInput)} disabled={disabled || !draft.copySampling.enabled}
              onFocus={(event) => { setCopyRateInput(event.currentTarget.value); }}
              onChange={(event) => {
                const input = event.target.value;
                setCopyRateInput(input);
                setMessage('');
                setDraft((current) => current ? { ...current, copySampling: { ...current.copySampling, rateBps: samplingRateBpsFromInput(input) } } : current);
              }}
              onBlur={() => { setCopyRateInput(null); }} />
            <span>{draft.copySampling.rateBps.toLocaleString('zh-CN')} / 10,000</span>
          </div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardText}>
            <label htmlFor="image-sampling-enabled">启用图片抽检</label>
            <p>作业员完成图片初审后进入图片抽检池；关闭时直接进入交付池。质检打回后的图片仍强制 100% 复检。</p>
          </div>
          <Switch id="image-sampling-enabled" checked={draft.imageSampling.enabled} disabled={disabled}
            onChange={(event) => { setMessage(''); setDraft((current) => current ? { ...current, imageSampling: { ...current.imageSampling, enabled: event.target.checked } } : current); }} />
        </div>
        <div className={styles.card}>
          <div className={styles.cardText}>
            <label htmlFor="image-sampling-blind">图片质检盲评</label>
            <p>非管理员质检员看不到任务号、词包和图片提交人；管理员仍可查看完整追溯信息。</p>
          </div>
          <Switch id="image-sampling-blind" checked={draft.imageSampling.blindReviewEnabled} disabled={disabled || !draft.imageSampling.enabled}
            onChange={(event) => { setMessage(''); setDraft((current) => current ? { ...current, imageSampling: { ...current.imageSampling, blindReviewEnabled: event.target.checked } } : current); }} />
        </div>
        <div className={styles.card}>
          <div className={styles.cardText}>
            <label htmlFor="image-batch-return-enabled">允许质检员整批打回</label>
            <p>只影响审核员；管理员始终可以处理任何图片质检项。关闭后审核员只能单条打回。</p>
          </div>
          <Switch id="image-batch-return-enabled" checked={draft.imageSampling.reviewerBatchReturnEnabled} disabled={disabled || !draft.imageSampling.enabled}
            onChange={(event) => { setMessage(''); setDraft((current) => current ? { ...current, imageSampling: { ...current.imageSampling, reviewerBatchReturnEnabled: event.target.checked } } : current); }} />
        </div>
        <div className={styles.rate}>
          <div className={styles.rateText}>
            <label htmlFor="image-sampling-rate">图片抽检比例</label>
            <p>按生产批次和图片提交人独立累计整数余数；满块立即冻结，不足块等待 30 分钟。返修复检不受此比例影响，固定全检。</p>
          </div>
          <div className={styles.rateControl}>
            <Input id="image-sampling-rate" type="number" min={0} max={100} step={0.01} value={samplingRateInputValue(draft.imageSampling.rateBps, imageRateInput)} disabled={disabled || !draft.imageSampling.enabled}
              onFocus={(event) => { setImageRateInput(event.currentTarget.value); }}
              onChange={(event) => {
                const input = event.target.value;
                setImageRateInput(input);
                setMessage('');
                setDraft((current) => current ? { ...current, imageSampling: { ...current.imageSampling, rateBps: samplingRateBpsFromInput(input) } } : current);
              }}
              onBlur={() => { setImageRateInput(null); }} />
            <span>{draft.imageSampling.rateBps.toLocaleString('zh-CN')} / 10,000</span>
          </div>
        </div>
      </div>
      {changed && <div className="notice" role="status">有未保存的流程配置更改。</div>}
    </>}
    {error && <div className="notice error" role="alert">{error}</div>}
    <ToastFeedback id="workflow-quality-settings-feedback" message={message} />
    {draft && <div className={styles.actions}>
      <Button unstyled className="button" type="button" disabled={disabled || !changed} onClick={() => { if (saved) setDraft(editableSettings(saved)); setCopyRateInput(null); setImageRateInput(null); setMessage(''); }}>撤销更改</Button>
      <Button unstyled className="button" type="button" disabled={loading || busy} onClick={() => { void load(); }}><RefreshCw size={15} aria-hidden="true" />重新读取</Button>
      <Button unstyled className="button primary" type="button" disabled={disabled || !changed} onClick={() => { void save(); }}><Save size={15} aria-hidden="true" />{busy ? '保存中…' : '保存流程配置'}</Button>
    </div>}
  </section>;
}
