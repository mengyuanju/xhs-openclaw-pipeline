'use client';

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input, Switch, Textarea } from '@/components/ui/input';

import { apiRequest } from '../components/api-client';
import type {
  HumanQualityReasonOption,
  HumanQualitySettings,
  HumanScore,
  HumanScoreDefinition,
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

function editableSignature(settings: HumanQualitySettings, copyText: string, imageText: string) {
  return JSON.stringify({
    scoreDefinitions: settings.scoreDefinitions,
    copyLabels: copyText.split(/\r?\n/u).map((label) => label.trim()).filter(Boolean),
    imageLabels: imageText.split(/\r?\n/u).map((label) => label.trim()).filter(Boolean),
    noteGuidance: settings.noteGuidance,
    copyReviewDisplay: settings.copyReviewDisplay,
    imageReviewDisplay: settings.imageReviewDisplay,
  });
}

export function HumanQualitySettingsPanel({
  onDirtyChange,
}: {
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [current, setCurrent] = useState<HumanQualitySettings | null>(null);
  const [copyText, setCopyText] = useState('');
  const [imageText, setImageText] = useState('');
  const [savedSignature, setSavedSignature] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  function applySettings(settings: HumanQualitySettings) {
    const nextCopyText = lines(settings.copyReasons);
    const nextImageText = lines(settings.imageReasons);
    setCurrent({
      ...settings,
      scoreDefinitions: settings.scoreDefinitions.map((definition) => ({ ...definition })),
      noteGuidance: { ...settings.noteGuidance },
      copyReviewDisplay: { ...settings.copyReviewDisplay },
      imageReviewDisplay: { ...settings.imageReviewDisplay },
    });
    setCopyText(nextCopyText);
    setImageText(nextImageText);
    setSavedSignature(editableSignature(settings, nextCopyText, nextImageText));
  }

  function beginEdit() {
    setMessage('');
    setError('');
  }

  function updateScoreDefinition(
    score: HumanScore,
    field: keyof Pick<HumanScoreDefinition, 'title' | 'description'>,
    value: string,
  ) {
    beginEdit();
    setCurrent((settings) => settings ? {
      ...settings,
      scoreDefinitions: settings.scoreDefinitions.map((definition) => definition.score === score
        ? { ...definition, [field]: value }
        : definition),
    } : settings);
  }

  function updateNoteGuidance(field: keyof HumanQualitySettings['noteGuidance'], value: string) {
    beginEdit();
    setCurrent((settings) => settings ? {
      ...settings,
      noteGuidance: { ...settings.noteGuidance, [field]: value },
    } : settings);
  }

  function updateCopyReviewDisplay(
    field: keyof HumanQualitySettings['copyReviewDisplay'],
    value: boolean,
  ) {
    beginEdit();
    setCurrent((settings) => settings ? {
      ...settings,
      copyReviewDisplay: { ...settings.copyReviewDisplay, [field]: value },
    } : settings);
  }

  function updateImageReviewDisplay(
    field: keyof HumanQualitySettings['imageReviewDisplay'],
    value: boolean,
  ) {
    beginEdit();
    setCurrent((settings) => settings ? {
      ...settings,
      imageReviewDisplay: { ...settings.imageReviewDisplay, [field]: value },
    } : settings);
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
          scoreDefinitions: current.scoreDefinitions,
          copyReasons: optionsFrom(copyText, current.copyReasons),
          imageReasons: optionsFrom(imageText, current.imageReasons),
          noteGuidance: current.noteGuidance,
          copyReviewDisplay: current.copyReviewDisplay,
          imageReviewDisplay: current.imageReviewDisplay,
        }),
      });
      applySettings(settings);
      setMessage('人工评分标准已保存；新打开的审核页面将使用最新说明与原因。');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '扣分原因保存失败');
    } finally {
      setBusy(false);
    }
  }

  const complete = Boolean(current
    && current.scoreDefinitions.every((definition) => definition.title.trim() && definition.description.trim())
    && current.noteGuidance.copyPlaceholder.trim()
    && current.noteGuidance.imagePlaceholder.trim());
  const hasChanges = Boolean(current
    && editableSignature(current, copyText, imageText) !== savedSignature);
  useEffect(() => {
    onDirtyChange?.(hasChanges);
    return () => { onDirtyChange?.(false); };
  }, [hasChanges, onDirtyChange]);

  return <section className="panel settings-section human-quality-settings" aria-labelledby="human-quality-settings-heading">
    <div className="panel-head">
      <div>
        <h2 id="human-quality-settings-heading">人工评分标准与反馈</h2>
        <p className="subtle">统一维护审核页的档位说明、扣分原因和评分说明提示。分值、2.5 分放行线和工作流动作仍由系统固定。</p>
      </div>
    </div>
    {loading ? <div className="empty-state">正在读取人工评分标准…</div> : current && <>
      <div className="human-quality-config-block">
        <div className="human-quality-config-heading">
          <div><span>01</span><div><h3>评分档位说明</h3><p>只能修改审核页展示的名称和说明，不能增加档位或改变数值。</p></div></div>
          <small>固定档位：1 / 2 / 2.5 / 3</small>
        </div>
        <label className="switch-field">
          <Switch
            aria-label="文案审核中显示评分档位说明"
            checked={current.copyReviewDisplay.showScoreDescriptions}
            disabled={busy}
            onChange={(event) => updateCopyReviewDisplay('showScoreDescriptions', event.target.checked)}
          />
          <span>文案审核中显示评分档位说明</span>
        </label>
        <div className="human-score-definition-grid">
          {current.scoreDefinitions.map((definition) => <fieldset key={definition.score} className="human-score-definition" data-score={definition.score}>
            <legend className="sr-only">{definition.score} 分评分档位</legend>
            <header>
              <strong>{definition.score}<small>分</small></strong>
              <span data-passing={definition.score > 2}>{definition.score > 2 ? '可放行' : '需处理'}</span>
            </header>
            <div className="field">
              <label htmlFor={`human-score-title-${definition.score}`}>档位名称</label>
              <Input aria-label={`${definition.score} 分档位名称`} id={`human-score-title-${definition.score}`} className="input" value={definition.title} maxLength={20} disabled={busy} onChange={(event) => updateScoreDefinition(definition.score, 'title', event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor={`human-score-description-${definition.score}`}>档位说明</label>
              <Textarea aria-label={`${definition.score} 分档位说明`} id={`human-score-description-${definition.score}`} className="textarea" rows={2} value={definition.description} maxLength={80} disabled={busy} onChange={(event) => updateScoreDefinition(definition.score, 'description', event.target.value)} />
            </div>
          </fieldset>)}
        </div>
      </div>

      <div className="human-quality-config-block">
        <div className="human-quality-config-heading">
          <div><span>02</span><div><h3>扣分原因</h3><p>每行一个原因，最多 10 项、每项最多 50 字；文案审核和图文终审可分别关闭展示。</p></div></div>
        </div>
        <div className="human-quality-display-switches">
          <label className="switch-field">
            <Switch
              aria-label="文案审核中显示扣分原因"
              checked={current.copyReviewDisplay.showDeductionReasons}
              disabled={busy}
              onChange={(event) => updateCopyReviewDisplay('showDeductionReasons', event.target.checked)}
            />
            <span>文案审核中显示扣分原因</span>
          </label>
          <label className="switch-field">
            <Switch
              aria-label="图文终审中显示扣分原因"
              checked={current.imageReviewDisplay.showDeductionReasons}
              disabled={busy}
              onChange={(event) => updateImageReviewDisplay('showDeductionReasons', event.target.checked)}
            />
            <span>图文终审中显示扣分原因</span>
          </label>
        </div>
        <div className="form-grid human-reason-config-grid">
          <div className="field">
            <label htmlFor="copy-quality-reasons">文案扣分原因</label>
            <Textarea id="copy-quality-reasons" className="textarea" rows={8} value={copyText} disabled={busy} onChange={(event) => { beginEdit(); setCopyText(event.target.value); }} />
          </div>
          <div className="field">
            <label htmlFor="image-quality-reasons">图片扣分原因</label>
            <Textarea id="image-quality-reasons" className="textarea" rows={8} value={imageText} disabled={busy} onChange={(event) => { beginEdit(); setImageText(event.target.value); }} />
          </div>
        </div>
      </div>

      <div className="human-quality-config-block">
        <div className="human-quality-config-heading">
          <div><span>03</span><div><h3>评分说明提示</h3><p>只设置空白输入框的引导语，不会预填或代替审核人提交的真实说明。</p></div></div>
        </div>
        <div className="form-grid human-note-guidance-grid">
          <div className="field">
            <label htmlFor="copy-quality-note-placeholder">文案评分说明提示</label>
            <Input id="copy-quality-note-placeholder" className="input" value={current.noteGuidance.copyPlaceholder} maxLength={100} disabled={busy} onChange={(event) => updateNoteGuidance('copyPlaceholder', event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="image-quality-note-placeholder">图片评分说明提示</label>
            <Input id="image-quality-note-placeholder" className="input" value={current.noteGuidance.imagePlaceholder} maxLength={100} disabled={busy} onChange={(event) => updateNoteGuidance('imagePlaceholder', event.target.value)} />
          </div>
        </div>
      </div>
    </>}
    {message && <div className="notice success" role="status">{message}</div>}
    {error && <div className="notice error" role="alert">{error}</div>}
    <div className="settings-actions">
      <span className="subtle">原因中的空行会自动忽略；所有展示文本保存时都会再次校验。</span>
      <Button unstyled className="button primary" type="button" disabled={loading || busy || !complete || !hasChanges} onClick={() => { void save(); }}>{busy ? '保存中…' : '保存人工评分标准'}</Button>
    </div>
  </section>;
}
