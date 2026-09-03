'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent, type SyntheticEvent } from 'react';

import { apiRequest } from '../components/api-client';

type LabelSummary = { name: string; itemCount: number };

export type CopyKnowledgeItem = {
  id: number;
  title: string;
  sourceCopy: string;
  analysisPrompt: string;
  summary: string;
  analysis: string;
  labels: string[];
  createdAt: string;
};

type CopyKnowledgeEditDraft = Pick<
  CopyKnowledgeItem,
  'title' | 'sourceCopy' | 'analysisPrompt' | 'summary' | 'analysis'
>;

function draftFromItem(item: CopyKnowledgeItem): CopyKnowledgeEditDraft {
  return {
    title: item.title,
    sourceCopy: item.sourceCopy,
    analysisPrompt: item.analysisPrompt,
    summary: item.summary,
    analysis: item.analysis,
  };
}

function labelsFromText(value: string) {
  return value.split(/[，,\n]/u).map((label) => label.trim()).filter(Boolean);
}

function CopyKnowledgeEditor({ item }: { item: CopyKnowledgeItem }) {
  const router = useRouter();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [draft, setDraft] = useState<CopyKnowledgeEditDraft | null>(null);
  const [labelText, setLabelText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  function updateDraft<K extends keyof CopyKnowledgeEditDraft>(key: K, value: CopyKnowledgeEditDraft[K]) {
    setDraft((current) => current ? { ...current, [key]: value } : current);
    setMessage('');
  }

  function toggleEditor(event: SyntheticEvent<HTMLDetailsElement>) {
    if (event.currentTarget.open) {
      setDraft(draftFromItem(item));
      setLabelText(item.labels.join('，'));
      setMessage('');
    } else if (!busy) {
      setDraft(null);
      setLabelText('');
    }
  }

  function cancel() {
    setDraft(null);
    setLabelText('');
    setMessage('');
    if (detailsRef.current) detailsRef.current.open = false;
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    setBusy(true);
    setMessage('');
    try {
      const updated = await apiRequest<CopyKnowledgeItem>(`/api/copy-knowledge-items/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft, labels: labelsFromText(labelText) }),
      });
      setDraft(draftFromItem(updated));
      setLabelText(updated.labels.join('，'));
      setMessage('修改已保存。');
      if (detailsRef.current) detailsRef.current.open = false;
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? `保存失败：${error.message}` : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  const parsedLabels = labelsFromText(labelText);
  const canSave = Boolean(
    draft
    && draft.title.trim()
    && draft.sourceCopy.trim()
    && draft.analysisPrompt.trim()
    && draft.summary.trim()
    && draft.analysis.trim()
    && parsedLabels.length > 0
    && parsedLabels.length <= 12,
  );
  const fieldId = (name: string) => `copy-knowledge-${item.id}-${name}`;

  return <div className="copy-knowledge-edit-block">
    <details className="copy-knowledge-editor" ref={detailsRef} onToggle={toggleEditor}>
      <summary>编辑已保存内容</summary>
      {draft && <form className="form-grid copy-knowledge-edit-form" onSubmit={save}>
        <div className="field full">
          <label htmlFor={fieldId('title')}>分析标题</label>
          <input className="input" id={fieldId('title')} value={draft.title} maxLength={200} onChange={(event) => updateDraft('title', event.target.value)} required />
        </div>
        <div className="field full">
          <label htmlFor={fieldId('source')}>优秀文案</label>
          <textarea className="textarea" id={fieldId('source')} value={draft.sourceCopy} maxLength={20_000} onChange={(event) => updateDraft('sourceCopy', event.target.value)} required />
        </div>
        <div className="field full">
          <label htmlFor={fieldId('prompt')}>分析 Prompt</label>
          <textarea className="textarea compact" id={fieldId('prompt')} value={draft.analysisPrompt} maxLength={8_000} onChange={(event) => updateDraft('analysisPrompt', event.target.value)} required />
        </div>
        <div className="field full">
          <label htmlFor={fieldId('summary')}>分析摘要</label>
          <textarea className="textarea compact" id={fieldId('summary')} value={draft.summary} maxLength={2_000} onChange={(event) => updateDraft('summary', event.target.value)} required />
        </div>
        <div className="field full">
          <label htmlFor={fieldId('analysis')}>完整分析</label>
          <textarea className="textarea" id={fieldId('analysis')} value={draft.analysis} maxLength={15_000} onChange={(event) => updateDraft('analysis', event.target.value)} required />
        </div>
        <div className="field full">
          <label htmlFor={fieldId('labels')}>分类标签（逗号或换行分隔）</label>
          <input className="input" id={fieldId('labels')} value={labelText} maxLength={620} aria-describedby={fieldId('labels-help')} onChange={(event) => { setLabelText(event.target.value); setMessage(''); }} required />
          <small id={fieldId('labels-help')}>至少 1 个、最多 12 个标签；重复标签会自动合并。</small>
        </div>
        <div className="field full inline copy-knowledge-edit-actions">
          <button className="button primary" type="submit" disabled={busy || !canSave}>{busy ? '保存中…' : '保存修改'}</button>
          <button className="button" type="button" disabled={busy} onClick={cancel}>取消</button>
        </div>
      </form>}
    </details>
    {message && <div className={message.includes('失败') ? 'notice error copy-knowledge-edit-message' : 'notice success copy-knowledge-edit-message'} role={message.includes('失败') ? 'alert' : 'status'} aria-live="polite">{message}</div>}
  </div>;
}

export function CopyKnowledgeLibrary({
  items,
  labels,
  selectedLabel,
  onSelectLabel,
}: {
  items: CopyKnowledgeItem[];
  labels: LabelSummary[];
  selectedLabel: string;
  onSelectLabel: (label: string) => void;
}) {
  const visibleItems = selectedLabel === 'ALL'
    ? items
    : items.filter((item) => item.labels.includes(selectedLabel));

  return <section className="panel copy-knowledge-library" aria-labelledby="copy-knowledge-library-heading">
    <div className="panel-head">
      <div><span className="eyebrow">Classified library</span><h2 id="copy-knowledge-library-heading">文案知识库</h2></div>
      <span className="subtle">{items.length} 条</span>
    </div>
    <div className="copy-label-filter-block">
      <span className="subtle" id="copy-label-filter-label">按标签查看</span>
      <div className="copy-label-filters" role="group" aria-labelledby="copy-label-filter-label">
        <button className="button small" type="button" aria-pressed={selectedLabel === 'ALL'} onClick={() => onSelectLabel('ALL')}>全部 {items.length}</button>
        {labels.map((label) => <button className="button small" type="button" key={label.name} aria-pressed={selectedLabel === label.name} onClick={() => onSelectLabel(label.name)}>{label.name} {label.itemCount}</button>)}
      </div>
    </div>
    {visibleItems.length === 0 ? <div className="empty-state">{items.length === 0 ? '还没有文案分析。填写上方两个字段，生成第一条分类知识。' : '这个标签下还没有文案分析。'}</div> : <ul className="copy-knowledge-list">
      {visibleItems.map((item) => <li key={item.id}>
        <div className="copy-knowledge-item-head">
          <div><h3>{item.title}</h3><p>{item.summary}</p></div>
          <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('zh-CN')}</time>
        </div>
        <div className="copy-knowledge-labels" aria-label="分类标签">{item.labels.map((label: string) => <span className="pill" key={label}>{label}</span>)}</div>
        <details className="copy-knowledge-details">
          <summary>查看文案、分析 Prompt 与完整结果</summary>
          <div><h4>优秀文案</h4><p>{item.sourceCopy}</p><h4>分析 Prompt</h4><p>{item.analysisPrompt}</p><h4>分析结果</h4><p>{item.analysis}</p></div>
        </details>
        <CopyKnowledgeEditor item={item} />
      </li>)}
    </ul>}
  </section>;
}
