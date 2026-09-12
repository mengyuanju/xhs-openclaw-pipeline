'use client';

import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Disclosure, DisclosureTrigger, DisclosureContent } from '@/components/ui/disclosure';

import { LoaderCircle, RefreshCw, Save } from 'lucide-react';
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';

import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { PROMPT_CATALOG, promptTemplatesForEditing } from '../../src/prompt-catalog.mjs';
import { missingPromptOptimizationGuards } from '../../src/prompt-optimization-guards.mjs';
import { PromptOptimizationGuard } from './prompt-optimization-guard';
import { PromptRuntimeSettings } from './prompt-runtime-settings';
import { PromptPreview } from './prompt-preview';
import { apiRequest } from '../components/api-client';

type Version = {
  id: number;
  version: number;
  content: string;
  status: string;
  createdAt: string;
  publishedAt: string | null;
};
type Template = { id: number | null; kind: string; name: string; versions: Version[]; candidate?: string };
type Candidate = { kind: string; label: string; candidate: string };
type Draft = { content: string; baseId: number | null };
const TYPES: Record<string, { label: string; description: string; group: string }> = Object.fromEntries(PROMPT_CATALOG.map((item) => [item.kind, item]));
const STATUS_LABELS: Record<string, string> = { PUBLISHED: '当前已发布', DRAFT: '未发布草稿', ARCHIVED: '历史版本' };
const endpoint = (path: string) => `/api/control-plane${path}`;
const publishedVersion = (template: Template) => template.versions.find((version) => version.status === 'PUBLISHED');
const dateTime = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';

export function CentralPromptWorkbench({ catalog }: { catalog: Candidate[] }) {
  const confirm = useConfirmDialog();
  const [group, setGroup] = useState('生成与规划');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [activeKind, setActiveKind] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const saved = await apiRequest<Template[]>(endpoint('/v1/prompts'), { cache: 'no-store' });
      const next: Template[] = promptTemplatesForEditing(saved, catalog);
      const order = Object.keys(TYPES);
      next.sort((a, b) => (order.indexOf(a.kind) < 0 ? 99 : order.indexOf(a.kind))
        - (order.indexOf(b.kind) < 0 ? 99 : order.indexOf(b.kind)));
      setTemplates(next);
      setActiveKind((current) => next.some((item) => item.kind === current) ? current : next[0]?.kind ?? '');
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '中心提示词读取失败');
      return false;
    } finally {
      setLoading(false);
    }
  }, [catalog]);

  useEffect(() => { void refresh(); }, [refresh]);

  function discardDraft(kind: string) {
    setDrafts((current) => {
      const next = { ...current };
      delete next[kind];
      return next;
    });
  }

  async function save(template: Template, content: string, baseId: number | null, publish = true) {
    const missingGuards = missingPromptOptimizationGuards(template.kind, content);
    if (missingGuards.length > 0 && !await confirm({
      title: '关键优化规则可能被删除',
      description: `缺少“${missingGuards.map((item: { title: string }) => item.title).join('、')}”的保护标识或有效内容。继续操作可能让后续文案重新出现重复、超长等问题。`,
      confirmLabel: publish ? '仍然提交更新' : '仍然保存草稿',
    })) return;
    if (publish && !await confirm({
      title: `更新${TYPES[template.kind]?.label ?? template.name}提示词？`,
      description: '将保存并发布一个新版本，历史内容不会被覆盖。已冻结的任务配置不变。',
      confirmLabel: '提交更新',
    })) return;
    setBusy(true);
    setMessage('');
    setError('');
    let created: Version | undefined;
    try {
      const latest = await apiRequest<Template[]>(endpoint('/v1/prompts'), { cache: 'no-store' });
      const current = latest.find((item) => item.kind === template.kind);
      if ((!current && template.id !== null) || (current ? publishedVersion(current)?.id ?? null : null) !== baseId) {
        await refresh();
        throw new Error('中心已发布版本发生变化。你的修改已保留，请先核对最新版本，再放弃旧修改或复制内容重新编辑。');
      }
      created = await apiRequest<Version>(endpoint('/v1/prompts/versions'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: template.kind, name: template.name, content }),
      });
      if (publish) await apiRequest(endpoint(`/v1/prompt-versions/${created.id}/publish`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      discardDraft(template.kind);
      setMessage(`${template.name} v${created.version} 已${publish ? '更新并发布' : '保存为草稿'}。`);
      await refresh();
    } catch (caught) {
      setError(`${created ? `v${created.version} 草稿已保存，但发布未确认成功；请在历史版本中核对。` : ''}${caught instanceof Error ? caught.message : '提示词更新失败'}`);
      if (created) await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function useHistory(template: Template, version: Version) {
    if (drafts[template.kind] && !await confirm({
      title: '用历史内容替换当前编辑内容？',
      description: '当前未提交的修改将被替换。此操作不会发布或更改中心数据。',
      confirmLabel: '替换编辑内容',
    })) return;
    setDrafts((current) => ({ ...current, [template.kind]: {
      content: version.content, baseId: publishedVersion(template)?.id ?? null,
    } }));
    setMessage(`已载入 v${version.version}，可继续修改；点击“提交更新”后才会发布。`);
    setError('');
  }

  const visibleTemplates = templates.filter((template) => (TYPES[template.kind]?.group ?? '生成与规划') === group);

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % visibleTemplates.length;
    else if (event.key === 'ArrowLeft') next = (index + visibleTemplates.length - 1) % visibleTemplates.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = visibleTemplates.length - 1;
    else return;
    event.preventDefault();
    setActiveKind(visibleTemplates[next].kind);
    document.getElementById(`prompt-tab-${visibleTemplates[next].kind}`)?.focus();
  }

  return <div className="central-data-stack">
    <PromptRuntimeSettings onPrepared={() => { void refresh(); }} />
    <div className="prompt-manager-toolbar">
      <div><strong>提示词管理</strong><p className="subtle">按类型管理当前规则；提交更新会创建并发布新版本。</p></div>
      <Button unstyled className="button small" type="button" disabled={loading || busy} onClick={() => {
        setGroup('审核与修复'); setActiveKind('QUERY_REVIEW_SYSTEM');
      }}>编辑 Query 筛选提示词</Button>
      <Button unstyled className="button small" type="button" disabled={loading || busy} onClick={() => { setError(''); void refresh(); }}>
        <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />刷新中心数据
      </Button>
    </div>
    {message && <div className="notice success" role="status">{message}</div>}
    {error && <div className="notice error" role="alert">{error}</div>}
    {loading && templates.length === 0 ? <div className="panel empty-state"><LoaderCircle className="animate-spin" size={20} />正在读取中心提示词…</div>
      : templates.length === 0 ? <div className="panel empty-state">{error ? '暂时无法读取提示词，请重试刷新。' : '中心暂无提示词，请先初始化中心服务的默认提示词。'}</div>
        : <section className="prompt-manager">
          <label className="field">提示词分组<Select value={group} disabled={busy} onValueChange={(nextValue) => {
            const value = nextValue; setGroup(value); setActiveKind(templates.find((item) => TYPES[item.kind]?.group === value)?.kind ?? '');
          }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{[...new Set(PROMPT_CATALOG.map((item) => item.group))].map((item) => <SelectItem key={item} value={String(item)}>{item}</SelectItem>)}</SelectContent></Select></label>
          <div className="prompt-type-tabs" role="tablist" aria-label="提示词类型">
            {visibleTemplates.map((template, index) => <Button unstyled key={template.kind} id={`prompt-tab-${template.kind}`} type="button"
              className="prompt-type-tab" role="tab" aria-selected={activeKind === template.kind}
              aria-controls={`prompt-panel-${template.kind}`} tabIndex={activeKind === template.kind ? 0 : -1}
              disabled={busy} onKeyDown={(event) => navigateTabs(event, index)} onClick={() => setActiveKind(template.kind)}>
              {TYPES[template.kind]?.label ?? template.name}{drafts[template.kind] && <small>未提交</small>}
            </Button>)}
          </div>
          {templates.map((template) => {
            const published = publishedVersion(template);
            const draft = drafts[template.kind];
            const content = draft?.content ?? published?.content ?? template.versions.find((item) => item.status === 'DRAFT')?.content ?? template.candidate ?? '';
            const changed = content !== (published?.content ?? '');
            const stale = Boolean(draft && draft.baseId !== (published?.id ?? null));
            return <div key={template.kind} id={`prompt-panel-${template.kind}`} role="tabpanel"
              aria-labelledby={`prompt-tab-${template.kind}`} hidden={activeKind !== template.kind}>
              <div className="prompt-manager-content">
                <form className="panel prompt-card" onSubmit={(event) => { event.preventDefault(); void save(template, content, draft?.baseId ?? published?.id ?? null); }}>
                  <div className="panel-head"><div><h2>{template.name}</h2><p className="subtle">{TYPES[template.kind]?.description}</p></div>
                    <span className="pill">{published ? `当前发布 v${published.version}` : '尚未发布'}</span></div>
                  <div className="prompt-version-meta"><span>发布时间：{dateTime(published?.publishedAt ?? null)}</span><span>历史版本：{template.versions.length} 个</span></div>
                  {template.id === null && <p className="notice">中心尚未创建此模板。下方默认内容可直接编辑；保存草稿或提交更新后创建首个版本。</p>}
                  {stale && <div className="notice warning">中心已发布版本已变化，当前保留的是你的旧版本修改。请核对历史版本后重新编辑。</div>}
                  <PromptOptimizationGuard kind={template.kind} content={content} />
                  <div className="field"><label htmlFor={`central-prompt-content-${template.kind}`}>提示词内容</label>
                    <Textarea id={`central-prompt-content-${template.kind}`} className="textarea mono prompt-manager-editor"
                      value={content} required disabled={busy} spellCheck={false} onChange={(event) => {
                        const value = event.target.value;
                        if (value === (published?.content ?? '')) discardDraft(template.kind);
                        else setDrafts((current) => ({ ...current, [template.kind]: { content: value, baseId: draft ? draft.baseId : published?.id ?? null } }));
                      }} />
                  </div>
                  <div className="prompt-manager-actions"><small>{[...content].length} 字符 · {changed ? '有未提交修改' : '与当前发布内容一致'} · 切换页签会保留编辑内容</small>
                    <div className="inline">
                      <Button unstyled className="button" type="button" disabled={busy || loading || stale || !content.trim()} onClick={() => void save(template, content, draft?.baseId ?? published?.id ?? null, false)}>保存草稿</Button>
                      {draft && <Button unstyled className="button" type="button" disabled={busy || loading} onClick={async () => {
                        if (await confirm({ title: '放弃未提交的修改？', description: '编辑器将恢复为中心当前发布的内容。', confirmLabel: '放弃修改' })) discardDraft(template.kind);
                      }}>放弃修改</Button>}
                      <Button unstyled className="button primary" type="submit" disabled={busy || loading || stale || !changed || !content.trim()}>
                        {busy ? <LoaderCircle className="animate-spin" size={15} /> : <Save size={15} />}{busy ? '正在提交…' : '提交更新'}
                      </Button>
                    </div>
                  </div>
                  <PromptPreview kind={template.kind} content={content} published={published?.content} />
                </form>
                <section className="panel prompt-card" aria-label={`${template.name}历史版本`}>
                  <div><h3>历史版本</h3><p className="subtle">展开查看完整内容。历史内容只读，可载入编辑器后提交为新版本。</p></div>
                  {[...template.versions].sort((a, b) => b.version - a.version).map((version) => <Disclosure className="prompt-history-version" key={version.id}>
                    <DisclosureTrigger><strong>v{version.version}</strong><span className="pill">{STATUS_LABELS[version.status] ?? '未知状态'}</span><span>创建于 {dateTime(version.createdAt)}</span></DisclosureTrigger><DisclosureContent>
                    <div className="prompt-history-body">
                      <div className="prompt-manager-actions"><small>发布时间：{dateTime(version.publishedAt)}</small>
                        <Button unstyled type="button" className="button small" disabled={busy || loading} onClick={() => { void useHistory(template, version); }}>载入此版本编辑</Button></div>
                      <pre className="prompt-history-content">{version.content}</pre>
                    </div>
                  </DisclosureContent></Disclosure>)}
                </section>
              </div>
            </div>;
          })}
        </section>}
  </div>;
}
