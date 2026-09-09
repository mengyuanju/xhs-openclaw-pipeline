'use client';

import { Button } from '@/components/ui/button';
import { Input, Switch } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { useCallback, useState } from 'react';

import { apiRequest } from '../components/api-client';
import { HumanQualitySettingsPanel } from './human-quality-settings-panel';
import { LayoutCatalogSettings } from './layout-catalog-settings';
import { LayoutPresetsEditor, type LayoutPreset } from './layout-presets-settings';
import {
  ModelApiSettingsSection,
  type EffectiveModelApi,
  type ModelApiSettings,
} from './model-api-settings-section';
import { QualitySettingsOverview } from './quality-settings-overview';
import {
  SettingsWorkspace,
  type SettingsSectionId,
} from './settings-workspace';
import { WebSearchSettingsPanel } from './web-search-settings-panel';

type Settings = {
  layoutPresets: LayoutPreset[];
  qualityRepairEnabled: boolean;
  qualityRepairTriggerScore: number;
  qualityRepairTargetScore: number;
  qualityRepairMaxAttempts: number;
  aiDisclosureEnabled: boolean;
  aiDisclosureText: string;
  modelApi: ModelApiSettings;
};

const EMPTY_MODEL_API: ModelApiSettings = {
  agentProvider: null,
  copyGenerationProvider: null,
  copyGenerationThinking: null,
  dotsBaseUrl: null,
  dotsModel: null,
  textModel: null,
  capacityFallbackModel: null,
  modelCapacityCooldownMs: null,
  screeningModel: null,
  reviewModel: null,
  visionModel: null,
  qualityModel: null,
  imageModel: null,
  modelProxyUrl: null,
  imageProxyUrl: null,
  imageTimeoutMs: null,
};

const SECTION_SAVE_COPY: Record<SettingsSectionId, { title: string; button: string }> = {
  generation: { title: '模型生成配置', button: '保存模型配置' },
  quality: { title: '自动返修策略', button: '保存返修策略' },
  image: { title: '图片交付配置', button: '保存交付配置' },
  advanced: { title: '旧版兼容配置', button: '保存兼容配置' },
};

function modelApiPatch(settings: Settings) {
  return Object.fromEntries(Object.keys(EMPTY_MODEL_API).map((key) => [
    key,
    settings.modelApi[key as keyof ModelApiSettings],
  ]));
}

function sectionValue(settings: Settings, section: SettingsSectionId) {
  if (section === 'generation') return settings.modelApi;
  if (section === 'quality') return {
    qualityRepairEnabled: settings.qualityRepairEnabled,
    qualityRepairTriggerScore: settings.qualityRepairTriggerScore,
    qualityRepairTargetScore: settings.qualityRepairTargetScore,
    qualityRepairMaxAttempts: settings.qualityRepairMaxAttempts,
  };
  if (section === 'image') return {
    aiDisclosureEnabled: settings.aiDisclosureEnabled,
    aiDisclosureText: settings.aiDisclosureText,
  };
  return settings.layoutPresets;
}

function sectionPatch(settings: Settings, section: SettingsSectionId) {
  if (section === 'generation') return { modelApi: modelApiPatch(settings) };
  if (section === 'quality' || section === 'image') return sectionValue(settings, section);
  return { layoutPresets: settings.layoutPresets };
}

function mergeSection(current: Settings, saved: Settings, section: SettingsSectionId): Settings {
  if (section === 'generation') return { ...current, modelApi: saved.modelApi };
  if (section === 'quality') return {
    ...current,
    qualityRepairEnabled: saved.qualityRepairEnabled,
    qualityRepairTriggerScore: saved.qualityRepairTriggerScore,
    qualityRepairTargetScore: saved.qualityRepairTargetScore,
    qualityRepairMaxAttempts: saved.qualityRepairMaxAttempts,
  };
  if (section === 'image') return {
    ...current,
    aiDisclosureEnabled: saved.aiDisclosureEnabled,
    aiDisclosureText: saved.aiDisclosureText,
  };
  return { ...current, layoutPresets: saved.layoutPresets };
}

function sectionIsDirty(current: Settings, saved: Settings, section: SettingsSectionId) {
  return JSON.stringify(sectionValue(current, section)) !== JSON.stringify(sectionValue(saved, section));
}

function QualityRepairSettings({
  settings,
  busy,
  update,
}: {
  settings: Settings;
  busy: boolean;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}) {
  const targetOptions = [1, 2, 3].filter((score) => score > settings.qualityRepairTriggerScore);
  return <section className="panel settings-section" aria-labelledby="quality-repair-heading">
    <div className="panel-head">
      <div><h2 id="quality-repair-heading">自动返修策略</h2><p className="subtle">这里只控制自动质检后的重试，不改变 production-v2 的评分算法。</p></div>
      <label className="switch-field"><Switch checked={settings.qualityRepairEnabled} disabled={busy} onChange={(event) => update('qualityRepairEnabled', event.target.checked)} /><span>启用自动修复</span></label>
    </div>
    <div className="form-grid compact-settings-grid">
      <div className="field">
        <label htmlFor="repair-trigger-score">触发分数</label>
        <Select value={String(settings.qualityRepairTriggerScore)} disabled={busy || !settings.qualityRepairEnabled} onValueChange={(value) => {
          const trigger = Number(value);
          update('qualityRepairTriggerScore', trigger);
          if (settings.qualityRepairTargetScore <= trigger) update('qualityRepairTargetScore', Math.min(3, trigger + 1));
        }}>
          <SelectTrigger id="repair-trigger-score"><SelectValue /></SelectTrigger>
          <SelectContent>{[0, 1, 2].map((score) => <SelectItem key={score} value={String(score)}>{score} 分</SelectItem>)}</SelectContent>
        </Select>
        <small>默认仅首次 1 分触发。</small>
      </div>
      <div className="field">
        <label htmlFor="repair-target-score">目标分数</label>
        <Select value={String(settings.qualityRepairTargetScore)} disabled={busy || !settings.qualityRepairEnabled} onValueChange={(value) => update('qualityRepairTargetScore', Number(value))}>
          <SelectTrigger id="repair-target-score"><SelectValue /></SelectTrigger>
          <SelectContent>{targetOptions.map((score) => <SelectItem key={score} value={String(score)}>{score} 分</SelectItem>)}</SelectContent>
        </Select>
        <small>达到目标后回到现有质量门禁。</small>
      </div>
      <div className="field">
        <label htmlFor="repair-max-attempts">最多修复次数</label>
        <Select value={String(settings.qualityRepairMaxAttempts)} disabled={busy || !settings.qualityRepairEnabled} onValueChange={(value) => update('qualityRepairMaxAttempts', Number(value))}>
          <SelectTrigger id="repair-max-attempts"><SelectValue /></SelectTrigger>
          <SelectContent>{[0, 1, 2].map((count) => <SelectItem key={count} value={String(count)}>{count} 次</SelectItem>)}</SelectContent>
        </Select>
        <small>安全上限固定为 2 次。</small>
      </div>
    </div>
  </section>;
}

function AiDisclosureSettings({
  settings,
  busy,
  update,
}: {
  settings: Settings;
  busy: boolean;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}) {
  return <section className="panel settings-section" aria-labelledby="ai-disclosure-heading">
    <div className="panel-head">
      <div><h2 id="ai-disclosure-heading">AI生成标识</h2><p className="subtle">统一控制图片提示词、OCR 白名单、Mock 排版和人工 AI 编辑后的叠层。</p></div>
      <label className="switch-field"><Switch checked={settings.aiDisclosureEnabled} disabled={busy} onChange={(event) => update('aiDisclosureEnabled', event.target.checked)} /><span>显示标识</span></label>
    </div>
    <div className="field disclosure-field"><label htmlFor="ai-disclosure-text">标识文字</label><Input id="ai-disclosure-text" className="input" value={settings.aiDisclosureText} maxLength={12} pattern="[\\p{L}\\p{N}_-]+" disabled={busy || !settings.aiDisclosureEnabled} onChange={(event) => update('aiDisclosureText', event.target.value)} /><small>最多 12 个字符，仅限文字、数字、下划线或短横线；关闭后生成和验收都不再要求该标识。</small></div>
  </section>;
}

export function ProductionSettingsForm({
  initialRecord,
  effectiveModelApi,
}: {
  initialRecord: { settings: Settings; updatedAt: string };
  effectiveModelApi: EffectiveModelApi;
}) {
  const [settings, setSettings] = useState<Settings>(initialRecord.settings);
  const [savedSettings, setSavedSettings] = useState<Settings>(initialRecord.settings);
  const [updatedAt, setUpdatedAt] = useState(initialRecord.updatedAt);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('generation');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [messageIsError, setMessageIsError] = useState(false);
  const [independentDirty, setIndependentDirty] = useState({
    search: false,
    humanQuality: false,
    layoutCatalog: false,
  });

  const reportSearchDirty = useCallback((dirty: boolean) => {
    setIndependentDirty((current) => current.search === dirty ? current : { ...current, search: dirty });
  }, []);
  const reportHumanQualityDirty = useCallback((dirty: boolean) => {
    setIndependentDirty((current) => current.humanQuality === dirty ? current : { ...current, humanQuality: dirty });
  }, []);
  const reportLayoutCatalogDirty = useCallback((dirty: boolean) => {
    setIndependentDirty((current) => current.layoutCatalog === dirty ? current : { ...current, layoutCatalog: dirty });
  }, []);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
    setMessage('');
  }

  function updateModelApi<K extends keyof ModelApiSettings>(key: K, value: ModelApiSettings[K]) {
    setSettings((current) => ({
      ...current,
      modelApi: { ...current.modelApi, [key]: value },
    }));
    setMessage('');
  }

  const sectionIds: SettingsSectionId[] = ['generation', 'quality', 'image', 'advanced'];
  const managedDirtyBySection = Object.fromEntries(sectionIds.map((section) => [
    section,
    sectionIsDirty(settings, savedSettings, section),
  ])) as Record<SettingsSectionId, boolean>;
  const independentDirtyBySection: Record<SettingsSectionId, boolean> = {
    generation: independentDirty.search,
    quality: independentDirty.humanQuality,
    image: independentDirty.layoutCatalog,
    advanced: false,
  };
  const dirtyBySection = Object.fromEntries(sectionIds.map((section) => [
    section,
    managedDirtyBySection[section] || independentDirtyBySection[section],
  ])) as Record<SettingsSectionId, boolean>;
  const activeManagedDirty = managedDirtyBySection[activeSection];
  const activeIndependentDirty = independentDirtyBySection[activeSection];
  const dirtyCount = Object.values(dirtyBySection).filter(Boolean).length;
  const activeInvalid = activeSection === 'image'
    ? settings.aiDisclosureEnabled && !settings.aiDisclosureText.trim()
    : activeSection === 'advanced'
      ? settings.layoutPresets.some((preset) => !preset.name.trim())
      : false;

  async function saveActiveSection() {
    const section = activeSection;
    setBusy(true);
    setMessage('');
    setMessageIsError(false);
    try {
      const record = await apiRequest<{ settings: Settings; updatedAt: string }>('/api/production-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sectionPatch(settings, section)),
      });
      setSettings((current) => mergeSection(current, record.settings, section));
      setSavedSettings((current) => mergeSection(current, record.settings, section));
      setUpdatedAt(record.updatedAt);
      setMessage(`${SECTION_SAVE_COPY[section].title}已保存；正在处理的任务继续使用领取时的配置。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '配置保存失败');
      setMessageIsError(true);
    } finally {
      setBusy(false);
    }
  }

  const sections = [
    {
      id: 'generation' as const,
      title: '生成与模型',
      description: '联网检索、提供方与阶段模型',
      dirty: dirtyBySection.generation,
      children: <>
        <WebSearchSettingsPanel onDirtyChange={reportSearchDirty} />
        <ModelApiSettingsSection
          value={settings.modelApi}
          effective={effectiveModelApi}
          busy={busy}
          onChange={updateModelApi}
          onReset={() => update('modelApi', { ...EMPTY_MODEL_API })}
        />
      </>,
    },
    {
      id: 'quality' as const,
      title: '质量与审核',
      description: '评分标准、扣分反馈与返修',
      dirty: dirtyBySection.quality,
      children: <>
        <QualitySettingsOverview />
        <HumanQualitySettingsPanel onDirtyChange={reportHumanQualityDirty} />
        <QualityRepairSettings settings={settings} busy={busy} update={update} />
      </>,
    },
    {
      id: 'image' as const,
      title: '图片与输出',
      description: '布局模板与交付标识',
      dirty: dirtyBySection.image,
      children: <>
        <LayoutCatalogSettings onDirtyChange={reportLayoutCatalogDirty} />
        <AiDisclosureSettings settings={settings} busy={busy} update={update} />
      </>,
    },
    {
      id: 'advanced' as const,
      title: '兼容与高级',
      description: '旧版任务保留配置',
      dirty: dirtyBySection.advanced,
      children: <>
        <div className="notice settings-scope-notice">这里仅保留旧版任务依赖的兼容项。新任务的版式请在“图片与输出”的布局模板库中维护。</div>
        <LayoutPresetsEditor value={settings.layoutPresets ?? []} onChange={(value) => update('layoutPresets', value)} disabled={busy} />
      </>,
    },
  ];

  return <div className="settings-stack">
    <SettingsWorkspace sections={sections} activeSection={activeSection} onSectionChange={setActiveSection} />
    {message && <div className={messageIsError ? 'notice error' : 'notice success'} role={messageIsError ? 'alert' : 'status'} aria-live="polite">{message}</div>}
    <div className="settings-save-bar" data-dirty={dirtyBySection[activeSection] || undefined}>
      <div>
        <strong>{SECTION_SAVE_COPY[activeSection].title}</strong>
        <span>
          {activeManagedDirty ? '这组配置有未保存修改' : '这组配置已保存'}
          {activeIndependentDirty ? ' · 本分区还有独立模块待保存' : ''}
          {dirtyCount > Number(dirtyBySection[activeSection]) ? ` · 另有 ${dirtyCount - Number(dirtyBySection[activeSection])} 个分区待处理` : ''}
        </span>
      </div>
      <small>最近保存：{new Date(updatedAt).toLocaleString('zh-CN')}</small>
      <Button unstyled className="button primary" type="button" disabled={busy || !activeManagedDirty || activeInvalid} onClick={() => { void saveActiveSection(); }}>
        {busy ? '保存中…' : SECTION_SAVE_COPY[activeSection].button}
      </Button>
    </div>
  </div>;
}
