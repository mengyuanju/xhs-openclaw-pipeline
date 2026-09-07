'use client';

import './planning-catalog.css';

import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageLayoutEditor } from '../components/image-controls';
import { createRunId as createCatalogId } from '../image-generation/run-id';
import { LAYOUT_KIND_LABELS } from '../../server/src/layout-library.mjs';
import { PAGE_TEMPLATES } from '../../server/src/image-options.mjs';
import { CatalogIdentityFields, CatalogRowActions, moveCatalogItem } from './planning-catalog-fields';
import type { BaseKind, CatalogLayout, PageType, PlanningCatalog } from './planning-catalog-types';

export function PlanningCatalogEditor({ value, onChange, disabled = false }: {
  value: PlanningCatalog; onChange: (catalog: PlanningCatalog) => void; disabled?: boolean;
}) {
  const id = useId();
  const [tab, setTab] = useState<'types' | 'layouts'>('types');
  const [newId, setNewId] = useState('');
  function updateType(index: number, patch: Partial<PageType>) {
    onChange({ ...value, pageTypes: value.pageTypes.map((item, position) => position === index ? { ...item, ...patch } : item) });
  }
  function updateLayout(index: number, patch: Partial<CatalogLayout>) {
    onChange({ ...value, layouts: value.layouts.map((item, position) => position === index ? { ...item, ...patch } : item) });
  }
  function add() {
    const nextId = createCatalogId();
    setNewId(nextId);
    if (tab === 'types') onChange({ ...value, pageTypes: [...value.pageTypes, { id: nextId, name: '新页面类型', description: '', baseKind: 'detail', enabled: false }] });
    else onChange({ ...value, layouts: [...value.layouts, { id: nextId, name: '新布局', description: '', kind: 'all', enabled: true, layout: { mode: 'CUSTOM' } }] });
  }
  return <section className="panel settings-section planning-catalog" aria-labelledby={`${id}-heading`}>
    <div className="panel-head"><div><h2 id={`${id}-heading`}>图片规划配置</h2><p className="subtle">页面类型决定这一页讲什么，视觉布局决定画面怎么摆。修改用于后续生成，历史结果保留当时的名称与描述。</p></div>
      <Button unstyled type="button" className="button" disabled={disabled || (tab === 'types' ? value.pageTypes.length >= 50 : value.layouts.length >= 100)} onClick={add}>{tab === 'types' ? '新增页面类型' : '新增视觉布局'}</Button>
    </div>
    <div className="planning-tabs" role="tablist" aria-label="图片规划配置分类">
      {(['types', 'layouts'] as const).map(current => <button key={current} id={`${id}-tab-${current}`} type="button" role="tab" aria-selected={tab === current} aria-controls={`${id}-panel-${current}`} tabIndex={tab === current ? 0 : -1} onClick={() => setTab(current)} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 'types' : event.key === 'End' ? 'layouts' : current === 'types' ? 'layouts' : 'types';
        setTab(next); document.getElementById(`${id}-tab-${next}`)?.focus();
      }}>{current === 'types' ? `页面类型 · ${value.pageTypes.length}` : `视觉布局 · ${value.layouts.length}`}</button>)}
    </div>
    <div id={`${id}-panel-types`} role="tabpanel" aria-labelledby={`${id}-tab-types`} hidden={tab !== 'types'}>
      <p className="subtle">模型根据正文选择启用的类型。新增类型先补充描述，再添加适用布局并启用。</p>
      <div className="settings-stack">{value.pageTypes.map((type, index) => <Disclosure key={type.id} className="layout-preset" defaultOpen={type.id === newId}>
        <DisclosureTrigger>{type.name || '未命名类型'} · {type.enabled ? '已启用' : '已停用'}</DisclosureTrigger>
        <DisclosureContent><fieldset className="layout-preset-fields" disabled={disabled}>
          <CatalogIdentityFields id={`${id}-${type.id}`} label="页面类型" value={type} onChange={patch => updateType(index, patch)} />
          <Disclosure><DisclosureTrigger>高级设置</DisclosureTrigger><DisclosureContent>
            <div className="field"><label htmlFor={`${id}-base-${type.id}`}>基础结构</label><Select value={type.baseKind} disabled={disabled || Object.hasOwn(PAGE_TEMPLATES, type.id)} onValueChange={baseKind => updateType(index, { baseKind: baseKind as BaseKind })}><SelectTrigger id={`${id}-base-${type.id}`}><SelectValue /></SelectTrigger><SelectContent>{Object.entries(LAYOUT_KIND_LABELS).filter(([kind]) => kind !== 'all').map(([kind, label]) => <SelectItem key={kind} value={kind}>{label}</SelectItem>)}</SelectContent></Select><small>封面类型用于第一张图片；其他类型用于内容页。</small></div>
          </DisclosureContent></Disclosure>
          <CatalogRowActions name={type.name} enabled={type.enabled} first={index === 0} last={index === value.pageTypes.length - 1} canDelete={!value.layouts.some(layout => layout.kind === type.id)} onEnabled={enabled => updateType(index, { enabled })} onMove={direction => onChange({ ...value, pageTypes: moveCatalogItem(value.pageTypes, index, direction) })} onDelete={() => onChange({ ...value, pageTypes: value.pageTypes.filter(item => item.id !== type.id) })} />
        </fieldset></DisclosureContent>
      </Disclosure>)}</div>
    </div>
    <div id={`${id}-panel-layouts`} role="tabpanel" aria-labelledby={`${id}-tab-layouts`} hidden={tab !== 'layouts'}>
      <p className="subtle">每页从适用且已启用的布局中随机选择。名称与描述随结果保存，续跑沿用已选布局。</p>
      <div className="settings-stack">{value.layouts.map((layout, index) => <Disclosure key={layout.id} className="layout-preset" defaultOpen={layout.id === newId}>
        <DisclosureTrigger>{layout.name || '未命名布局'} · {layout.kind === 'all' ? '所有页面' : value.pageTypes.find(type => type.id === layout.kind)?.name || '类型已移除'} · {layout.enabled ? '已启用' : '已停用'}</DisclosureTrigger>
        <DisclosureContent><fieldset className="layout-preset-fields" disabled={disabled}>
          <CatalogIdentityFields id={`${id}-${layout.id}`} label="布局" value={layout} onChange={patch => updateLayout(index, patch)} />
          <div className="field"><label htmlFor={`${id}-kind-${layout.id}`}>适用页面类型</label><Select value={layout.kind} disabled={disabled} onValueChange={kind => updateLayout(index, { kind, ...(layout.layout.mode === 'TEMPLATE' ? { layout: { mode: 'CUSTOM' } } : {}) })}><SelectTrigger id={`${id}-kind-${layout.id}`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">所有页面</SelectItem>{value.pageTypes.map(type => <SelectItem key={type.id} value={type.id}>{type.name}{type.enabled ? '' : '（已停用）'}</SelectItem>)}</SelectContent></Select></div>
          <Disclosure><DisclosureTrigger>高级设置 · 布局区域</DisclosureTrigger><DisclosureContent>
            {layout.layout.mode === 'TEMPLATE' ? <><p className="subtle">当前沿用内置区域结构，名称与描述仍会用于规划。</p><Button unstyled type="button" className="button small" onClick={() => updateLayout(index, { layout: { mode: 'CUSTOM' } })}>自定义区域</Button></> : <PageLayoutEditor kind={value.pageTypes.find(type => type.id === layout.kind)?.baseKind ?? 'all'} value={layout.layout} disabled={disabled} onChange={next => updateLayout(index, { layout: next })} />}
          </DisclosureContent></Disclosure>
          <CatalogRowActions name={layout.name} enabled={layout.enabled} first={index === 0} last={index === value.layouts.length - 1} onEnabled={enabled => updateLayout(index, { enabled })} onMove={direction => onChange({ ...value, layouts: moveCatalogItem(value.layouts, index, direction) })} onDelete={() => onChange({ ...value, layouts: value.layouts.filter(item => item.id !== layout.id) })} />
        </fieldset></DisclosureContent>
      </Disclosure>)}</div>
    </div>
  </section>;
}
