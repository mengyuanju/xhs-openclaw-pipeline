'use client';

import { Button } from '@/components/ui/button';
import { Input, Switch } from '@/components/ui/input';
import { ClipboardCheck, RefreshCw, Save } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { apiRequest } from '../components/api-client';
import {
  normalizeWorkflowQualitySettings,
  type WorkflowQualitySettings,
} from '../query-packages/types';
import styles from './workflow-quality-settings.module.css';

const ENDPOINT = '/api/control-plane/v1/workflow-quality-settings';

function editableSettings(settings: WorkflowQualitySettings) {
  return {
    queryPackage: { ...settings.queryPackage },
    copySampling: { ...settings.copySampling },
  };
}

export function WorkflowQualitySettingsPanel() {
  const [saved, setSaved] = useState<WorkflowQualitySettings | null>(null);
  const [draft, setDraft] = useState<ReturnType<typeof editableSettings> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const payload = await apiRequest<unknown>(ENDPOINT);
      const next = normalizeWorkflowQualitySettings(payload);
      if (!next) throw new Error('中心返回的流程质检配置不完整');
      setSaved(next);
      setDraft(editableSettings(next));
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

  return <section className="panel settings-section" aria-labelledby="workflow-quality-settings-title" aria-busy={loading || busy}>
    <div className="panel-head">
      <div>
        <span className="section-kicker">Workflow quality</span>
        <h2 id="workflow-quality-settings-title">流程与文案抽检</h2>
        <p className="subtle">集中控制词包导入、抽检比例、独立盲评和质检员整批打回权限。</p>
      </div>
      <ClipboardCheck size={20} aria-hidden="true" />
    </div>

    {loading && <div className="empty-state" role="status">正在读取流程质检配置…</div>}
    {!loading && !draft && <div className="empty-state"><p>流程质检配置暂不可用，已停用编辑以避免覆盖真实数据。</p><Button unstyled className="button" type="button" onClick={() => { void load(); }}>重新读取</Button></div>}
    {draft && <>
      <div className={styles.modeSummary} aria-label="当前配置摘要">
        <span className="pill">词包导入：{draft.queryPackage.workerImportEnabled ? '作业员可用' : '仅管理员'}</span>
        <span className="pill">文案抽检：{draft.copySampling.enabled ? `${ratePercent}%` : '关闭'}</span>
        <span className="pill">质检视图：{draft.copySampling.blindReviewEnabled ? '盲评' : '非盲评'}</span>
        <span className="pill">质检员整批打回：{draft.copySampling.reviewerBatchReturnEnabled ? '允许' : '禁止'}</span>
      </div>
      <div className={styles.grid}>
        <div className={styles.card} data-wide="true">
          <div className={styles.cardText}>
            <label htmlFor="worker-query-package-import">允许作业人员导入 Query 词包</label>
            <p>只控制作业人员新建或导入词包。关闭后，他们仍可筛选已分配给自己的词包，并将通过项创建为正式作业；管理员始终可以导入。</p>
          </div>
          <Switch id="worker-query-package-import" checked={draft.queryPackage.workerImportEnabled} disabled={disabled}
            onChange={(event) => { setMessage(''); setDraft((current) => current ? { ...current, queryPackage: { workerImportEnabled: event.target.checked } } : current); }} />
        </div>
        <div className={styles.card}>
          <div className={styles.cardText}>
            <label htmlFor="copy-sampling-enabled">启用文案抽检</label>
            <p>文案人工审核通过后，以最终人工通过版本为样本候选；未抽中的作业继续后续流程。</p>
          </div>
          <Switch id="copy-sampling-enabled" checked={draft.copySampling.enabled} disabled={disabled}
            onChange={(event) => { setMessage(''); setDraft((current) => current ? { ...current, copySampling: { ...current.copySampling, enabled: event.target.checked } } : current); }} />
        </div>
        <div className={styles.card}>
          <div className={styles.cardText}>
            <label htmlFor="copy-sampling-blind">启用独立盲评</label>
            <p>开启后，质检页面不显示任务号、词包名称、上游人员身份、原评分和原因；此开关与抽检比例、打回权限彼此独立。</p>
          </div>
          <Switch id="copy-sampling-blind" checked={draft.copySampling.blindReviewEnabled} disabled={disabled}
            onChange={(event) => { setMessage(''); setDraft((current) => current ? { ...current, copySampling: { ...current.copySampling, blindReviewEnabled: event.target.checked } } : current); }} />
        </div>
        <div className={styles.card} data-wide="true">
          <div className={styles.cardText}>
            <label htmlFor="reviewer-batch-return">允许质检员整批打回</label>
            <p>质检员始终可以只打回当前错误项；开启后才可整批打回。管理员始终保留整批打回权限，且每次必须选中项目、二次确认、填写原因并留存审计。</p>
          </div>
          <Switch id="reviewer-batch-return" checked={draft.copySampling.reviewerBatchReturnEnabled} disabled={disabled}
            onChange={(event) => { setMessage(''); setDraft((current) => current ? { ...current, copySampling: { ...current.copySampling, reviewerBatchReturnEnabled: event.target.checked } } : current); }} />
        </div>
        <div className={styles.rate}>
          <div className={styles.rateText}>
            <label htmlFor="copy-sampling-rate">抽检比例</label>
            <p>按批次分层抽取，支持 0–100%，精确到 0.01%。比例调整只影响之后冻结的抽检批次。</p>
          </div>
          <div className={styles.rateControl}>
            <Input id="copy-sampling-rate" type="number" min={0} max={100} step={0.01} value={ratePercent} disabled={disabled || !draft.copySampling.enabled}
              onChange={(event) => {
                const percent = Math.min(100, Math.max(0, Number(event.target.value) || 0));
                setMessage('');
                setDraft((current) => current ? { ...current, copySampling: { ...current.copySampling, rateBps: Math.round(percent * 100) } } : current);
              }} />
            <span>{draft.copySampling.rateBps.toLocaleString('zh-CN')} / 10,000</span>
          </div>
        </div>
      </div>
      {changed && <div className="notice" role="status">有未保存的流程配置更改。</div>}
    </>}
    {error && <div className="notice error" role="alert">{error}</div>}
    {message && <div className="notice success" role="status">{message}</div>}
    {draft && <div className={styles.actions}>
      <Button unstyled className="button" type="button" disabled={disabled || !changed} onClick={() => { if (saved) setDraft(editableSettings(saved)); setMessage(''); }}>撤销更改</Button>
      <Button unstyled className="button" type="button" disabled={loading || busy} onClick={() => { void load(); }}><RefreshCw size={15} aria-hidden="true" />重新读取</Button>
      <Button unstyled className="button primary" type="button" disabled={disabled || !changed} onClick={() => { void save(); }}><Save size={15} aria-hidden="true" />{busy ? '保存中…' : '保存流程配置'}</Button>
    </div>}
  </section>;
}
