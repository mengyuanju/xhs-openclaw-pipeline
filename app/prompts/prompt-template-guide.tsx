'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureTrigger, DisclosureContent } from '@/components/ui/disclosure';
import { PROMPT_CATALOG } from '../../src/prompt-catalog.mjs';

export function PromptCatalogSearch({ onSelect }: { onSelect: (kind: string, group: string) => void }) {
  const [search, setSearch] = useState('');
  const matches = search.trim() ? PROMPT_CATALOG.filter(item =>
    `${item.label} ${item.group} ${item.description} ${item.kind}`.toLowerCase().includes(search.trim().toLowerCase())) : [];
  const editableCount = PROMPT_CATALOG.filter(item => item.editable !== false).length;
  return <section className="stack" aria-label="提示词完整目录">
    <p className="subtle">共 {PROMPT_CATALOG.length} 项：{editableCount} 项可编辑规则、{PROMPT_CATALOG.length - editableCount} 项只读执行协议。每项展示用途、调用位置和实际默认内容。</p>
    <label className="field">查找所有提示词<Input value={search} onChange={event => setSearch(event.target.value)} placeholder="按名称、用途或阶段查找，例如：重试、局部编辑、文案" /></label>
    {search.trim() && <div className="stack" role="region" aria-label="提示词搜索结果">
      {matches.length ? matches.map(item => <Button unstyled className="button" key={item.kind} type="button"
        onClick={() => { onSelect(item.kind, item.group); setSearch(''); }}>{item.group} · {item.label}{item.editable === false ? '（只读）' : ''}</Button>) : <p className="subtle">没有匹配的提示词。</p>}
    </div>}
    <p className="subtle">业务阶段规则和补充规则在发布后生效；草稿仅供编辑。只读协议与程序校验共同约束输出，不能通过修改业务提示词绕过。<a href="/knowledge">知识库中的人工分析要求和视觉配方</a>也会作为输入参与对应阶段。</p>
  </section>;
}

export function PromptTemplateGuide({ kind, candidate, published, managed = false }: {
  kind: string; candidate?: string; published?: { version: number; content: string }; managed?: boolean;
}) {
  const item: any = PROMPT_CATALOG.find(entry => entry.kind === kind);
  if (!item) return null;
  const readonly = item.editable === false;
  const optionalStage = ['LAYOUT_CATALOG_SYSTEM', 'IMAGE_SEARCH_SYSTEM', 'QUERY_REVIEW_SYSTEM', 'VISUAL_PLAN_SYSTEM'].includes(kind);
  const source = item.executionStatus === 'RESERVED' ? '预留，当前没有运行入口' : readonly ? '程序执行协议（只读）' : published ? `已发布 v${published.version}`
    : managed && item.layer === 'BUSINESS' && !optionalStage ? '缺少已发布版本：调用本阶段时将阻断' : '系统默认模板（未发布修改版）';
  return <section className="stack" aria-label="提示词用途与生效来源">
    <p><strong>用途与触发：</strong>{item.usage ?? item.description}</p>
    <p><strong>当前生效来源：</strong>{source}。已冻结的任务继续使用执行快照。</p>
    {!published && !readonly && <p className="subtle">编辑器中可能载入尚未发布的草稿；草稿不代表当前正在使用的内容。</p>}
    <Disclosure><DisclosureTrigger>查看实际默认内容、调用位置和变量</DisclosureTrigger><DisclosureContent>
      <p className="subtle">默认文件：{item.defaultPath ?? (['TEXT_SYSTEM', 'IMAGE_SYSTEM', 'IMAGE_EDIT_SYSTEM'].includes(kind)
        ? `server/prompts/${kind.toLowerCase().replace('_', '-').replace('_', '-')}.md` : `prompts/business/${kind.toLowerCase()}.md`)}</p>
      {item.callSites?.map((site: string) => <p className="mono" key={site}>{site}</p>)}
      {item.variables?.length > 0 && <><p className="subtle">下列占位符由程序传入，请保留；代码表达式用于说明具体取值来源。</p>
        {item.variables.map((variable: { name: string; description: string }) => <p key={variable.name}><code>{`{{${variable.name}}}`}</code>：{variable.description}</p>)}</>}
      <pre className="prompt-history-content">{candidate ?? '当前服务尚未提供此项默认内容'}</pre>
    </DisclosureContent></Disclosure>
  </section>;
}
