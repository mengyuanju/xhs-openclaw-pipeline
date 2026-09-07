'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { BaseKind, PageType, PlanningMetadata } from '../settings/planning-catalog-types';
import { LAYOUT_KIND_LABELS } from '../../server/src/layout-library.mjs';

export function PlanningPageTypeSelect({ id, page, index, pageTypes, disabled, onChange }: {
  id: string; page: PlanningMetadata & { kind: BaseKind }; index: number; pageTypes: PageType[] | null; disabled: boolean;
  onChange: (type: PageType) => void;
}) {
  const currentId = page.pageTypeId ?? page.kind;
  const choices = (pageTypes ?? []).filter(type => type.enabled && (index === 0 ? type.baseKind === 'hero' : type.baseKind !== 'hero'));
  return <Select value={currentId} disabled={disabled || pageTypes === null} onValueChange={id => {
    const type = choices.find(type => type.id === id);
    if (type) onChange(type);
  }}>
    <SelectTrigger id={id}><SelectValue /></SelectTrigger>
    <SelectContent>
      {!choices.some(type => type.id === currentId) && <SelectItem value={currentId}>{page.pageType?.name ?? LAYOUT_KIND_LABELS[page.kind]}（当前版本）</SelectItem>}
      {choices.map(type => <SelectItem key={type.id} value={type.id}>{type.name}</SelectItem>)}
    </SelectContent>
  </Select>;
}
