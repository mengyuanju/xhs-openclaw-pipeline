'use client';

import { Textarea } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureTrigger, DisclosureContent } from '@/components/ui/disclosure';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { useConfirmDialog } from '@/components/ui/confirm-dialog';

import { apiRequest } from '../components/api-client';
import { PROMPT_CATALOG } from '../../src/prompt-catalog.mjs';
import { missingPromptOptimizationGuards } from '../../src/prompt-optimization-guards.mjs';
import { StatusPill } from '../components/status-pill';
import { PromptOptimizationGuard } from './prompt-optimization-guard';
import { PromptPreview } from './prompt-preview';

const KIND_DESCRIPTIONS: Record<string, string> = Object.fromEntries(PROMPT_CATALOG.map((item) => [item.kind, item.description]));

export function PromptEditor({ template }: { template: any }) {
  const router = useRouter();
  const confirm = useConfirmDialog();
  const published = template.versions.find((item: any) => item.status === 'PUBLISHED');
  const [content, setContent] = useState(published?.content || template.versions.find((item: any) => item.status === 'DRAFT')?.content || '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  async function saveAndPublish(publish = true) {
    const missingGuards = missingPromptOptimizationGuards(template.kind, content);
    if (missingGuards.length > 0 && !await confirm({
      title: '关键优化规则可能被删除',
      description: `缺少“${missingGuards.map((item: { title: string }) => item.title).join('、')}”的保护标识或有效内容。继续操作可能让后续文案重新出现重复、超长等问题。`,
      confirmLabel: publish ? '仍然创建并发布' : '仍然保存草稿',
    })) return;
    if (publish && !await confirm({
      title: '发布新的提示词版本？',
      description: '系统会创建一个不可覆盖的新版本，并用于之后取得新快照的执行；已冻结的执行保持原版本。',
      confirmLabel: '创建并发布',
    })) return;
    setBusy(true); setMessage(''); setFailed(false);
    try {
      const draft = await apiRequest<any>(`/api/prompts/${template.id}/versions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }),
      });
      if (publish) await apiRequest(`/api/prompt-versions/${draft.id}/publish`, { method: 'POST' });
      setMessage(`版本 v${draft.version} 已${publish ? '发布' : '保存为草稿'}；已经冻结的执行保持原版本。`);
      router.refresh();
    } catch (error) { setFailed(true); setMessage(error instanceof Error ? error.message : '发布失败'); }
    finally { setBusy(false); }
  }

  async function rollback(versionId: number, version: number) {
    if (!await confirm({
      title: `重新发布 v${version}？`,
      description: `历史版本 v${version} 将成为后续取得新快照的执行使用的提示词版本。`,
      confirmLabel: `发布 v${version}`,
    })) return;
    setBusy(true); setMessage(''); setFailed(false);
    try {
      await apiRequest(`/api/prompt-versions/${versionId}/publish`, { method: 'POST' });
      setMessage(`已切换到 v${version}。`); router.refresh();
    } catch (error) { setFailed(true); setMessage(error instanceof Error ? error.message : '切换失败'); }
    finally { setBusy(false); }
  }

  const messageIsError = failed || message.includes('失败') || message.includes('无效');

  return <article className="panel prompt-card">
    <div className="panel-head"><div><span className="eyebrow">{template.kind}</span><h2 style={{marginTop: 5}}>{template.name}</h2></div><StatusPill value={published ? "PUBLISHED" : "DRAFT"} /></div>
    <p className="subtle">{KIND_DESCRIPTIONS[template.kind]}</p>
    <PromptOptimizationGuard kind={template.kind} content={content} />
    <div className="field"><label htmlFor={`prompt-${template.id}`}>系统提示词</label><Textarea id={`prompt-${template.id}`} className="textarea mono" value={content} onChange={(event) => setContent(event.target.value)} maxLength={20_000} /></div>
    <div className="code-hint">可用变量由系统白名单校验；未知变量会被拒绝。{published ? `当前 v${published.version} · ${published.contentSha256?.slice(0, 10)}…` : '尚未发布'}</div>
    <PromptPreview kind={template.kind} content={content} published={published?.content} />
    {message && <div className={messageIsError ? 'notice error' : 'notice success'} role={messageIsError ? 'alert' : 'status'} aria-live="polite">{message}</div>}
    <div className="inline"><Button unstyled className="button" type="button" disabled={busy || !content.trim()} onClick={() => void saveAndPublish(false)}>保存草稿</Button><Button unstyled className="button primary" type="button" disabled={busy || !content.trim()} onClick={() => void saveAndPublish(true)}>{busy ? '处理中…' : '创建新版本并发布'}</Button></div>
    <Disclosure><DisclosureTrigger className="subtle" style={{cursor: 'pointer'}}>查看 {template.versions.length} 个历史版本</DisclosureTrigger><DisclosureContent><div className="history" style={{marginTop: 12}}>{template.versions.map((version: any) => <Disclosure className="history-item" key={version.id}><DisclosureTrigger>v{version.version} · {version.status} · {version.contentSha256.slice(0, 10)}…</DisclosureTrigger><DisclosureContent><pre className="prompt-history-content">{version.content}</pre><div className="inline"><Button unstyled className="button small" type="button" disabled={busy} onClick={() => setContent(version.content)}>载入此版本编辑</Button>{version.status !== 'PUBLISHED' && <Button unstyled className="button small" type="button" disabled={busy} onClick={() => rollback(version.id, version.version)}>重新发布</Button>}</div></DisclosureContent></Disclosure>)}</div></DisclosureContent></Disclosure>
  </article>;
}
