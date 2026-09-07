'use client';

import { Disclosure, DisclosureTrigger, DisclosureContent } from '@/components/ui/disclosure';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

import { useEffect, useState } from 'react';
import { apiRequest } from '../components/api-client';

export function PromptPreview({ kind, content, published }: { kind: string; content: string; published?: string }) {
  const [query, setQuery] = useState('预览示例');
  const [result, setResult] = useState<{ prompt: string; issues: string[]; note: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setResult(null); setError(''); }, [kind, content, query]);
  async function preview() {
    setBusy(true); setError(''); setResult(null);
    try { setResult(await apiRequest('/api/prompt-runtime/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, content, query }) })); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '预检失败'); }
    finally { setBusy(false); }
  }
  return <Disclosure className="stack"><DisclosureTrigger>对照发布版本与预检草稿</DisclosureTrigger><DisclosureContent>
    <div className="grid gap-4 md:grid-cols-2"><div><h3>当前发布内容</h3><pre className="prompt-history-content">{published ?? '尚未发布'}</pre></div>
      <div><h3>当前编辑内容{content === published ? '（一致）' : '（有差异）'}</h3><pre className="prompt-history-content">{content}</pre></div></div>
    <label className="field">示例选题<Input className="input" value={query} maxLength={500} onChange={(event) => setQuery(event.target.value)} /></label>
    <div><Button unstyled type="button" className="button" disabled={busy || !content.trim()} onClick={() => void preview()}>{busy ? '正在预检…' : '预检并预览变量展开（不调用模型）'}</Button></div>
    {error && <p className="notice error" role="alert">{error}</p>}
    {result && <div className="stack"><p className="subtle">{result.note}</p>{result.issues.map((issue) => <p className="notice warning" key={issue}>{issue}</p>)}<pre className="prompt-history-content">{result.prompt}</pre></div>}
  </DisclosureContent></Disclosure>;
}
