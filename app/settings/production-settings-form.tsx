'use client';

import { useState } from 'react';

import { apiRequest } from '../components/api-client';

type Settings = {
  qualityRepairEnabled: boolean;
  qualityRepairTriggerScore: number;
  qualityRepairTargetScore: number;
  qualityRepairMaxAttempts: number;
  aiDisclosureEnabled: boolean;
  aiDisclosureText: string;
};

export function ProductionSettingsForm({ initialRecord }: { initialRecord: { settings: Settings; updatedAt: string } }) {
  const [settings, setSettings] = useState<Settings>(initialRecord.settings);
  const [updatedAt, setUpdatedAt] = useState(initialRecord.updatedAt);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [messageIsError, setMessageIsError] = useState(false);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    setBusy(true);
    setMessage('');
    setMessageIsError(false);
    try {
      const record = await apiRequest<{ settings: Settings; updatedAt: string }>('/api/production-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      setSettings(record.settings);
      setUpdatedAt(record.updatedAt);
      setMessage('生产配置已保存；正在处理的任务继续使用领取时的配置。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '配置保存失败');
      setMessageIsError(true);
    } finally {
      setBusy(false);
    }
  }

  const targetOptions = [1, 2, 3].filter((score) => score > settings.qualityRepairTriggerScore);
  return <div className="settings-stack">
    <section className="panel settings-section" aria-labelledby="quality-repair-heading">
      <div className="panel-head">
        <div><h2 id="quality-repair-heading">整套图片质量修复</h2><p className="subtle">只有首次终审命中触发分数时才开始；达到目标分数立即停止。</p></div>
        <label className="switch-field"><input type="checkbox" checked={settings.qualityRepairEnabled} onChange={(event) => update('qualityRepairEnabled', event.target.checked)} /><span>启用自动修复</span></label>
      </div>
      <div className="form-grid compact-settings-grid">
        <div className="field"><label htmlFor="repair-trigger-score">触发分数</label><select id="repair-trigger-score" className="select" value={settings.qualityRepairTriggerScore} disabled={!settings.qualityRepairEnabled} onChange={(event) => {
          const trigger = Number(event.target.value);
          update('qualityRepairTriggerScore', trigger);
          if (settings.qualityRepairTargetScore <= trigger) update('qualityRepairTargetScore', Math.min(3, trigger + 1));
        }}>{[0, 1, 2].map((score) => <option key={score} value={score}>{score} 分</option>)}</select><small>默认仅首次 1 分触发。</small></div>
        <div className="field"><label htmlFor="repair-target-score">目标分数</label><select id="repair-target-score" className="select" value={settings.qualityRepairTargetScore} disabled={!settings.qualityRepairEnabled} onChange={(event) => update('qualityRepairTargetScore', Number(event.target.value))}>{targetOptions.map((score) => <option key={score} value={score}>{score} 分</option>)}</select><small>达到目标后回到现有质量门禁。</small></div>
        <div className="field"><label htmlFor="repair-max-attempts">最多修复次数</label><select id="repair-max-attempts" className="select" value={settings.qualityRepairMaxAttempts} disabled={!settings.qualityRepairEnabled} onChange={(event) => update('qualityRepairMaxAttempts', Number(event.target.value))}>{[0, 1, 2].map((count) => <option key={count} value={count}>{count} 次</option>)}</select><small>安全上限固定为 2 次。</small></div>
      </div>
    </section>

    <section className="panel settings-section" aria-labelledby="ai-disclosure-heading">
      <div className="panel-head">
        <div><h2 id="ai-disclosure-heading">AI生成标识</h2><p className="subtle">同时控制图片提示词、OCR 白名单、Mock 排版和人工 AI 编辑后的叠层。</p></div>
        <label className="switch-field"><input type="checkbox" checked={settings.aiDisclosureEnabled} onChange={(event) => update('aiDisclosureEnabled', event.target.checked)} /><span>显示标识</span></label>
      </div>
      <div className="field disclosure-field"><label htmlFor="ai-disclosure-text">标识文字</label><input id="ai-disclosure-text" className="input" value={settings.aiDisclosureText} maxLength={12} pattern="[\\p{L}\\p{N}_-]+" disabled={!settings.aiDisclosureEnabled} onChange={(event) => update('aiDisclosureText', event.target.value)} /><small>最多 12 个字符，仅限文字、数字、下划线或短横线；关闭后生成和验收都不再要求该标识。</small></div>
    </section>

    {message && <div className={messageIsError ? 'notice error' : 'notice success'} role={messageIsError ? 'alert' : 'status'} aria-live="polite">{message}</div>}
    <div className="settings-actions"><span className="subtle">上次保存：{new Date(updatedAt).toLocaleString('zh-CN')}</span><button className="button primary" type="button" disabled={busy || !settings.aiDisclosureText.trim()} onClick={save}>{busy ? '保存中…' : '保存生产配置'}</button></div>
  </div>;
}
