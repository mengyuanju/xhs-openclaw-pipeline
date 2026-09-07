'use client';

import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureTrigger, DisclosureContent } from '@/components/ui/disclosure';
import { Input, Switch } from '@/components/ui/input';

import { useId, useState } from 'react';
import { PageLayoutEditor, type PageLayout } from '../components/image-controls';
import { apiRequest } from '../components/api-client';
import { LAYOUT_KIND_LABELS, normalizeLayoutPresets } from '../../server/src/layout-library.mjs';

export type LayoutPreset = { id: string; name: string; kind: string; enabled: boolean; layout: PageLayout };

export function LayoutPresetsEditor({ value, onChange, disabled = false }: {
  value: LayoutPreset[]; onChange: (value: LayoutPreset[]) => void; disabled?: boolean;
}) {
  const id = useId();
  const [newId, setNewId] = useState('');
  function update(index: number, patch: Partial<LayoutPreset>) {
    onChange(value.map((item, position) => position === index ? { ...item, ...patch } : item));
  }
  return <section className="panel settings-section" aria-labelledby={`${id}-heading`}>
    <div className="panel-head">
      <div><h2 id={`${id}-heading`}>布局种类</h2><p className="subtle">生成时按页面类型，从内置布局和已启用的自定义布局中随机选择。作业详情无需单独指定。</p></div>
      <Button unstyled className="button" type="button" disabled={disabled || value.length >= 50} onClick={() => {
        const presetId = crypto.randomUUID();
        setNewId(presetId);
        onChange([...value, { id: presetId, name: '新布局', kind: 'all', enabled: true, layout: { mode: 'CUSTOM' } }]);
      }}>新增布局种类</Button>
    </div>
    {value.length === 0 && <p className="subtle">尚未添加自定义布局，当前使用内置布局随机生成。</p>}
    <div className="settings-stack">{value.map((preset, index) => <Disclosure className="layout-preset" key={preset.id} defaultOpen={preset.id === newId ? true : undefined}>
      <DisclosureTrigger>{preset.name || '未命名布局'} · {LAYOUT_KIND_LABELS[preset.kind as keyof typeof LAYOUT_KIND_LABELS]} · {preset.enabled ? '已启用' : '已停用'}</DisclosureTrigger><DisclosureContent>
      <fieldset className="layout-preset-fields" disabled={disabled}>
        <div className="form-grid">
          <div className="field"><label htmlFor={`${id}-name-${preset.id}`}>布局名称</label><Input id={`${id}-name-${preset.id}`} className="input" value={preset.name} maxLength={60} required onChange={event => update(index, { name: event.target.value })} /></div>
          <div className="field"><label htmlFor={`${id}-kind-${preset.id}`}>适用页面</label><Select value={preset.kind} onValueChange={(nextValue) => update(index, { kind: nextValue })}><SelectTrigger id={`${id}-kind-${preset.id}`}><SelectValue /></SelectTrigger><SelectContent>{Object.entries(LAYOUT_KIND_LABELS).map(([kind, label]) => <SelectItem key={kind} value={String(kind)}>{label}</SelectItem>)}</SelectContent></Select></div>
        </div>
        <PageLayoutEditor kind={preset.kind} value={preset.layout} disabled={disabled} onChange={layout => update(index, { layout })} />
        <div className="inline"><label className="switch-field"><Switch  checked={preset.enabled} onChange={event => update(index, { enabled: event.target.checked })} /><span>参与随机选择</span></label><Button unstyled className="button small danger" type="button" onClick={() => onChange(value.filter(item => item.id !== preset.id))}>删除布局种类</Button></div>
      </fieldset>
    </DisclosureContent></Disclosure>)}</div>
    <p className="subtle">修改后保存配置即可生效；同一次生成的续跑会保留已选布局。</p>
  </section>;
}

export function RemoteLayoutPresetsSettings({ initialPresets, onSaved }: {
  initialPresets: LayoutPreset[]; onSaved: () => Promise<void>;
}) {
  const [presets, setPresets] = useState(initialPresets);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  async function save() {
    setBusy(true); setError(''); setMessage('');
    try {
      const layoutPresets = normalizeLayoutPresets(presets);
      const records = await apiRequest<Array<{ key: string; value: Record<string, unknown> }>>('/api/control-plane/v1/settings');
      const current = records.find(record => record.key === 'production')?.value ?? {};
      await apiRequest('/api/control-plane/v1/settings/production', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: { ...current, layoutPresets } }) });
      setPresets(layoutPresets);
      setMessage('布局种类已保存，后续新任务会自动随机选择。');
      await onSaved();
    } catch (caught) { setError(caught instanceof Error ? caught.message : '布局种类保存失败'); }
    finally { setBusy(false); }
  }
  return <div className="settings-stack">
    <LayoutPresetsEditor value={presets} onChange={setPresets} disabled={busy} />
    {error && <p className="notice error" role="alert">{error}</p>}
    {message && <p className="notice success" role="status">{message}</p>}
    <div className="settings-actions"><Button unstyled className="button primary" type="button" disabled={busy || presets.some(preset => !preset.name.trim())} onClick={() => void save()}>{busy ? '保存中…' : '保存布局种类'}</Button></div>
  </div>;
}
