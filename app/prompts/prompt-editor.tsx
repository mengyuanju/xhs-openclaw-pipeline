'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { apiRequest } from '../components/api-client';
import { StatusPill } from '../components/status-pill';

const KIND_DESCRIPTIONS: Record<string, string> = {
  TEXT_SYSTEM: '控制标题、正文、标签和配图方案的生成口径。',
  IMAGE_SYSTEM: '控制首图和内容卡片的视觉风格与构图。',
  IMAGE_EDIT_SYSTEM: '控制参考图驱动的图片修改边界与保真要求。',
};

export function PromptEditor({ template }: { template: any }) {
  const router = useRouter();
  const published = template.versions.find((item: any) => item.status === 'PUBLISHED');
  const [content, setContent] = useState(published?.content || '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function saveAndPublish() {
    if (!window.confirm('将创建一个不可覆盖的新版本，并用于之后入队的任务。确认发布？')) return;
    setBusy(true); setMessage('');
    try {
      const draft = await apiRequest<any>(`/api/prompts/${template.id}/versions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }),
      });
      await apiRequest(`/api/prompt-versions/${draft.id}/publish`, { method: 'POST' });
      setMessage(`版本 v${draft.version} 已发布；既有任务仍使用原固定版本。`);
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : '发布失败'); }
    finally { setBusy(false); }
  }

  async function rollback(versionId: number, version: number) {
    if (!window.confirm(`确认重新发布历史版本 v${version}？`)) return;
    setBusy(true); setMessage('');
    try {
      await apiRequest(`/api/prompt-versions/${versionId}/publish`, { method: 'POST' });
      setMessage(`已切换到 v${version}。`); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : '切换失败'); }
    finally { setBusy(false); }
  }

  return <article className="panel prompt-card">
    <div className="panel-head"><div><span className="eyebrow">{template.kind}</span><h2 style={{marginTop: 5}}>{template.name}</h2></div><StatusPill value="PUBLISHED" /></div>
    <p className="subtle">{KIND_DESCRIPTIONS[template.kind]}</p>
    <div className="field"><label htmlFor={`prompt-${template.id}`}>系统提示词</label><textarea id={`prompt-${template.id}`} className="textarea mono" value={content} onChange={(event) => setContent(event.target.value)} maxLength={20_000} /></div>
    <div className="code-hint">可用变量由系统白名单校验；未知变量会被拒绝。当前 v{published?.version} · {published?.contentSha256?.slice(0, 10)}…</div>
    {message && <div className={message.includes('失败') || message.includes('无效') ? 'notice error' : 'notice success'}>{message}</div>}
    <div className="inline"><button className="button primary" disabled={busy || content.trim() === published?.content} onClick={saveAndPublish}>{busy ? '处理中…' : '创建新版本并发布'}</button></div>
    <details><summary className="subtle" style={{cursor: 'pointer'}}>查看 {template.versions.length} 个历史版本</summary><div className="history" style={{marginTop: 12}}>{template.versions.map((version: any) => <div className="history-item" key={version.id}><div className="inline"><strong>v{version.version}</strong><StatusPill value={version.status} /><span className="mono">{version.contentSha256.slice(0, 10)}…</span>{version.status !== 'PUBLISHED' && <button className="button small" disabled={busy} onClick={() => rollback(version.id, version.version)}>重新发布</button>}</div></div>)}</div></details>
  </article>;
}
