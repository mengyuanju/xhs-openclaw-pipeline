'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CatalogTemplate } from './layout-catalog-settings';

export function LayoutCatalogEditor({ template, nextVersion, busy, onSave, onClose }: {
  template: CatalogTemplate; nextVersion: number; busy: boolean;
  onSave: (template: CatalogTemplate) => Promise<void>; onClose: () => void;
}) {
  const [draft, setDraft] = useState({ ...template, templateVersion: nextVersion, source: 'MANUAL' });
  const update = (key: keyof CatalogTemplate, value: unknown) => setDraft(current => ({ ...current, [key]: value }));
  return <form className="panel settings-section" onSubmit={event => { event.preventDefault(); void onSave(draft); }}>
    <div className="panel-head"><div><h3>编辑 {template.layoutTemplate}</h3><p className="subtle">保存为版本 {nextVersion}，旧任务继续使用原版设计。</p></div><Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消编辑</Button></div>
    <fieldset disabled={busy} className="form-grid">
      {([['name', '模板名称', 60], ['description', '排版含义', 300], ['suitableContent', '适合内容', 300], ['subjectRegion', '主体区域', 300], ['textRegion', '文字区域', 300], ['readingOrder', '阅读顺序', 300]] as const).map(([key, label, max]) =>
        <label className="field" key={key}>{label}<Input value={draft[key]} maxLength={max} required onChange={event => update(key, event.target.value)} /></label>)}
      <label className="field">最少内容条目<Input type="number" min={1} max={6} value={draft.minItems} onChange={event => update('minItems', Number(event.target.value))} /></label>
      <label className="field">最多内容条目<Input type="number" min={draft.minItems} max={6} value={draft.maxItems} onChange={event => update('maxItems', Number(event.target.value))} /></label>
      <label className="field">视觉规则（每行一条）<textarea className="textarea" rows={4} value={draft.rules.join('\n')} onChange={event => update('rules', event.target.value.split('\n'))} /></label>
    </fieldset>
    <Button type="submit" disabled={busy}>保存新版本</Button>
  </form>;
}
