'use client';

import { Button } from '@/components/ui/button';
import { Input, Textarea, Switch } from '@/components/ui/input';
import type { PlanningIdentity } from './planning-catalog-types';

export function CatalogIdentityFields({ id, value, label, onChange }: {
  id: string; value: PlanningIdentity; label: string; onChange: (patch: Partial<PlanningIdentity>) => void;
}) {
  return <>
    <div className="field"><label htmlFor={`${id}-name`}>{label}名称</label><Input className="input" id={`${id}-name`} value={value.name} maxLength={60} required onChange={event => onChange({ name: event.target.value })} /></div>
    <div className="field"><label htmlFor={`${id}-description`}>{label}描述</label><Textarea className="textarea compact" id={`${id}-description`} value={value.description} maxLength={1000} required onChange={event => onChange({ description: event.target.value })} placeholder={label === '页面类型' ? '例如：列出常见错误，并给出对应建议。' : '例如：主体在左侧，右侧分组展示要点。'} /><small>描述会参与规划与生成，请说明适用内容或画面安排。</small></div>
  </>;
}

export function CatalogRowActions({ name, enabled, first, last, canDelete = true, onEnabled, onMove, onDelete }: {
  name: string; enabled: boolean; first: boolean; last: boolean; canDelete?: boolean;
  onEnabled: (value: boolean) => void; onMove: (direction: number) => void; onDelete: () => void;
}) {
  return <div className="planning-row-actions">
    <label className="switch-field"><Switch aria-label={`启用${name}`} checked={enabled} onChange={event => onEnabled(event.target.checked)} /><span>{enabled ? '已启用' : '已停用'}</span></label>
    <div className="inline">
      <Button unstyled type="button" className="button small" aria-label={`上移${name}`} disabled={first} onClick={() => onMove(-1)}>上移</Button>
      <Button unstyled type="button" className="button small" aria-label={`下移${name}`} disabled={last} onClick={() => onMove(1)}>下移</Button>
      <Button unstyled type="button" className="button small danger" disabled={!canDelete} title={canDelete ? undefined : '请先调整该类型关联的布局'} onClick={onDelete}>删除</Button>
    </div>
  </div>;
}

export function moveCatalogItem<T>(items: T[], index: number, direction: number): T[] {
  const target = index + direction;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
