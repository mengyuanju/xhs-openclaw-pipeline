'use client';

import { Textarea } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { Save } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { apiRequest } from './api-client';
import { WebSearchSettingsPanel } from '../settings/web-search-settings-panel';
import { RemoteLayoutPresetsSettings } from '../settings/layout-presets-settings';
import { LayoutCatalogSettings } from '../settings/layout-catalog-settings';
import { HumanQualitySettingsPanel } from '../settings/human-quality-settings-panel';
import { QualitySettingsOverview } from '../settings/quality-settings-overview';
import { WorkflowQualitySettingsPanel } from '../settings/workflow-quality-settings-panel';
import { SettingsWorkspace, type SettingsSectionId } from '../settings/settings-workspace';
import { XhsQuerySearchSettingsPanel } from '../settings/xhs-query-search-settings-panel';
import { normalizeWebSearchSettings } from '../../src/web-search-config.mjs';

const endpoint = (path: string) => `/api/control-plane${path}`;
const imageEditRepairLimit = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 2
  ? Number(value)
  : 2;

export function CentralDataWorkbench() {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [imageEditRepairMaxAttempts, setImageEditRepairMaxAttempts] = useState(2);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('generation');
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const records = await apiRequest<any[]>(endpoint('/v1/settings'));
      setData(records);
      setImageEditRepairMaxAttempts(imageEditRepairLimit(
        records.find((item) => item.key === 'production')?.value?.imageEditRepairMaxAttempts,
      ));
      setError('');
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : '中心数据读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function updateProduction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    let value;
    try {
      value = JSON.parse(String(form.get('value') ?? '{}'));
      value = { ...value, modelApi: { ...value.modelApi, agentProvider: 'CODEX' } };
    } catch {
      setError('生产配置必须是合法 JSON。');
      return;
    }
    setBusy(true);
    try {
      const latest = await apiRequest<any[]>(endpoint('/v1/settings'));
      const latestProduction = latest.find(item => item.key === 'production')?.value ?? {};
      value.layoutPresets = latestProduction.layoutPresets ?? [];
      value.imageEditRepairMaxAttempts = imageEditRepairLimit(latestProduction.imageEditRepairMaxAttempts);
      value.modelApi = {
        ...value.modelApi,
        ...normalizeWebSearchSettings(latestProduction.modelApi ?? {}),
      };
      await apiRequest(endpoint('/v1/settings/production'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      setMessage('生产配置已保存到中心服务，新的执行快照会使用该版本。');
      await refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '生产配置保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function updateImageEditRepair() {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const latest = await apiRequest<any[]>(endpoint('/v1/settings'));
      const latestProduction = latest.find(item => item.key === 'production')?.value ?? {};
      await apiRequest(endpoint('/v1/settings/production'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: {
          ...latestProduction,
          imageEditRepairMaxAttempts,
        } }),
      });
      setMessage('图片文字编辑自动修复次数已保存；新建编辑请求使用新值，已有请求保持原值。');
      await refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '图片文字编辑自动修复次数保存失败');
    } finally {
      setBusy(false);
    }
  }

  const production = data.find((item) => item.key === 'production');

  return <div className="central-data-stack">
    <SettingsWorkspace
      activeSection={activeSection}
      onSectionChange={setActiveSection}
      sections={[
        {
          id: 'generation',
          title: '生成与模型',
          description: '联网检索与中心生成策略',
          children: <>
            <WebSearchSettingsPanel onSaved={refresh} />
            <XhsQuerySearchSettingsPanel onSaved={refresh} />
          </>,
        },
        {
          id: 'quality',
          title: '质量与审核',
          description: '评分标准、扣分原因与说明',
          children: <><WorkflowQualitySettingsPanel /><QualitySettingsOverview /><HumanQualitySettingsPanel /></>,
        },
        {
          id: 'image',
          title: '图片与输出',
          description: '布局模板与图片策略',
          children: <>
            <LayoutCatalogSettings remote />
            <section className="panel settings-section" aria-labelledby="central-image-edit-repair-heading">
              <div className="panel-head"><div><h2 id="central-image-edit-repair-heading">图片文字编辑自动修复</h2><p className="subtle">控制单页“添加文字”未通过视觉质检后，自动打回图片模型重做的次数。</p></div></div>
              <div className="form-grid compact-settings-grid">
                <div className="field">
                  <label htmlFor="central-image-edit-repair-max-attempts">质检失败后最多自动修复</label>
                  <Select value={String(imageEditRepairMaxAttempts)} disabled={busy || loading || !production} onValueChange={(value) => setImageEditRepairMaxAttempts(Number(value))}>
                    <SelectTrigger id="central-image-edit-repair-max-attempts"><SelectValue /></SelectTrigger>
                    <SelectContent>{[0, 1, 2].map((count) => <SelectItem key={count} value={String(count)}>{count} 次</SelectItem>)}</SelectContent>
                  </Select>
                  <small>首次生成不计入修复次数；设置在创建编辑请求时冻结。</small>
                </div>
              </div>
              <div className="inline"><Button unstyled className="button primary" type="button" disabled={busy || loading || !production} onClick={() => { void updateImageEditRepair(); }}>保存文字修复次数</Button></div>
            </section>
          </>,
        },
        {
          id: 'advanced',
          title: '兼容与高级',
          description: '旧版布局与原始配置',
          children: <>
            <div className="notice settings-scope-notice">结构化模块会独立保存，且不会被下方原始 JSON 覆盖；原始 JSON 只保留尚未提供专用编辑器的中心配置。</div>
            {loading ? <div className="panel empty-state" role="status">正在读取中心生产配置…</div>
              : !production ? <div className="panel empty-state"><p>中心生产配置尚未成功读取，编辑器已停用以避免覆盖真实数据。</p><Button type="button" variant="outline" onClick={() => { void refresh(); }}>重新读取</Button></div>
                : <>
            <RemoteLayoutPresetsSettings initialPresets={production.value?.layoutPresets ?? []} onSaved={async () => { await refresh(); setMessage('旧版自定义布局已保存。新版布局请在布局模板库中维护。'); }} />
            <form className="panel settings-section" onSubmit={updateProduction}>
              <div className="panel-head"><div><span className="section-kicker">Remote settings</span><h2>其他生产配置 JSON</h2><p className="subtle">面向高级维护；布局目录、旧版布局和人工评分标准不会在这里重复出现。</p></div><Save size={18} /></div>
              <div className="field"><label htmlFor="central-production-settings">未结构化配置</label><Textarea className="textarea central-json-editor" id="central-production-settings" name="value" required defaultValue={JSON.stringify(Object.fromEntries(Object.entries(production?.value ?? {}).filter(([key]) => !['layoutCatalog', 'layoutPresets', 'humanQualityReasons', 'imageEditRepairMaxAttempts'].includes(key))), null, 2)} /></div>
              <div className="inline"><Button unstyled className="button primary" disabled={busy || loading}>保存新版本</Button><small>模型 API 密钥仍只通过执行机环境变量提供，不要写入这里。</small></div>
            </form>
            </>}
          </>,
        },
      ]}
    />

    {message && <div className="notice success" role="status">{message}</div>}
    {error && <div className="notice error" role="alert">{error}</div>}
  </div>;
}
