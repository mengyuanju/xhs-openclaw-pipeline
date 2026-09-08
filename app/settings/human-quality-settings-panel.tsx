'use client';

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';

import { apiRequest } from '../components/api-client';
import type {
  HumanQualityReasonOption,
  HumanQualitySettings,
} from '../workbench/human-quality-settings';

function lines(options: HumanQualityReasonOption[]) {
  return options.map((option) => option.label).join('\n');
}

function optionsFrom(text: string, current: HumanQualityReasonOption[]) {
  const codeByLabel = new Map(current.map((option) => [option.label, option.code]));
  return text.split(/\r?\n/u)
    .map((label) => label.trim())
    .filter(Boolean)
    .map((label) => ({ code: codeByLabel.get(label) ?? label, label }));
}

export function HumanQualitySettingsPanel() {
  const [current, setCurrent] = useState<HumanQualitySettings | null>(null);
  const [copyText, setCopyText] = useState('');
  const [imageText, setImageText] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  function applySettings(settings: HumanQualitySettings) {
    setCurrent(settings);
    setCopyText(lines(settings.copyReasons));
    setImageText(lines(settings.imageReasons));
  }

  useEffect(() => {
    let active = true;
    void apiRequest<HumanQualitySettings>('/api/human-quality-settings')
      .then((settings) => { if (active) applySettings(settings); })
      .catch((readError) => { if (active) setError(readError instanceof Error ? readError.message : '扣分原因读取失败'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function save() {
    if (!current) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const settings = await apiRequest<HumanQualitySettings>('/api/human-quality-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          copyReasons: optionsFrom(copyText, current.copyReasons),
          imageReasons: optionsFrom(imageText, current.imageReasons),
        }),
      });
      applySettings(settings);
      setMessage('扣分原因已保存；新打开的审核页面将使用最新选项。');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '扣分原因保存失败');
    } finally {
      setBusy(false);
    }
  }

  return <section className="panel settings-section" aria-labelledby="human-quality-settings-heading">
    <div className="panel-head">
      <div>
        <h2 id="human-quality-settings-heading">人工评分扣分原因</h2>
        <p className="subtle">每行一个原因，最多 10 项、每项最多 50 字；删除或改名不会改变历史评分记录。</p>
      </div>
    </div>
    {loading ? <div className="empty-state">正在读取扣分原因…</div> : <div className="form-grid">
      <div className="field">
        <label htmlFor="copy-quality-reasons">文案扣分原因</label>
        <Textarea id="copy-quality-reasons" className="textarea" rows={10} value={copyText} disabled={busy || !current} onChange={(event) => setCopyText(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="image-quality-reasons">图片扣分原因</label>
        <Textarea id="image-quality-reasons" className="textarea" rows={10} value={imageText} disabled={busy || !current} onChange={(event) => setImageText(event.target.value)} />
      </div>
    </div>}
    {message && <div className="notice success" role="status">{message}</div>}
    {error && <div className="notice error" role="alert">{error}</div>}
    <div className="settings-actions">
      <span className="subtle">空行会自动忽略；保存时由服务端再次校验重复项和长度。</span>
      <Button unstyled className="button primary" type="button" disabled={loading || busy || !current} onClick={() => { void save(); }}>{busy ? '保存中…' : '保存扣分原因'}</Button>
    </div>
  </section>;
}
