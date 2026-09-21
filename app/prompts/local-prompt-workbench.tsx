'use client';

import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Button } from '@/components/ui/button';

import { useState } from 'react';
import { PROMPT_CATALOG } from '../../src/prompt-catalog.mjs';
import { PromptEditor } from './prompt-editor';
import { PromptCatalogSearch } from './prompt-template-guide';

export function LocalPromptWorkbench({ templates, managed = false }: { templates: any[]; managed?: boolean }) {
  const [group, setGroup] = useState('生成与规划');
  const [kind, setKind] = useState('TEXT_SYSTEM');
  const entries = PROMPT_CATALOG.filter((item) => item.group === group);
  return <section className="stack prompt-template-list">
    <PromptCatalogSearch onSelect={(nextKind, nextGroup) => { setKind(nextKind); setGroup(nextGroup); }} />
    <div><Button unstyled className="button small" type="button" onClick={() => {
      setGroup('审核与修复'); setKind('QUERY_REVIEW_SYSTEM');
    }}>编辑 Query 筛选提示词</Button></div>
    <div className="inline"><label className="field">提示词分组<Select value={group} onValueChange={(nextValue) => {
      setGroup(nextValue); setKind(PROMPT_CATALOG.find((item) => item.group === nextValue)!.kind);
    }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{[...new Set(PROMPT_CATALOG.map((item) => item.group))].map((value) => <SelectItem key={value} value={String(value)}>{value}</SelectItem>)}</SelectContent></Select></label>
      <label className="field">业务阶段<Select value={kind} onValueChange={(nextValue) => setKind(nextValue)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{entries.map((item) => <SelectItem key={item.kind} value={String(item.kind)}>{item.label}</SelectItem>)}</SelectContent></Select></label></div>
    {templates.map((template) => <div key={template.kind} hidden={template.kind !== kind}><PromptEditor template={template} managed={managed} /></div>)}
  </section>;
}
