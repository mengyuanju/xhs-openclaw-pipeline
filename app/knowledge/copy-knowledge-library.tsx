'use client';

import { Eye, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';

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

function normalizedSearch(value: string) {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

function CopyKnowledgeEditor({ item }: { item: CopyKnowledgeItem }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CopyKnowledgeEditDraft | null>(null);
  const [labelText, setLabelText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  function updateDraft<K extends keyof CopyKnowledgeEditDraft>(key: K, value: CopyKnowledgeEditDraft[K]) {
    setDraft((current) => current ? { ...current, [key]: value } : current);
    setMessage('');
  }

  function changeOpen(nextOpen: boolean) {
    if (busy) return;
    setOpen(nextOpen);
    setMessage('');
    if (nextOpen) {
      setDraft(draftFromItem(item));
      setLabelText(item.labels.join('，'));
    } else {
      setDraft(null);
      setLabelText('');
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    setBusy(true);
    setMessage('');
    try {
      await apiRequest<CopyKnowledgeItem>(`/api/copy-knowledge-items/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft, labels: labelsFromText(labelText) }),
      });
      setOpen(false);
      setDraft(null);
      setLabelText('');
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

  return <>
    <button className="button small" type="button" onClick={() => changeOpen(true)}><Pencil aria-hidden="true" size={13} />编辑</button>
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="copy-knowledge-edit-dialog">
        <div className="copy-knowledge-dialog-head">
          <DialogTitle>编辑文案分析</DialogTitle>
          <DialogDescription>修改已保存的标题、文案、分析内容和分类标签。</DialogDescription>
        </div>
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
          {message && <div className="notice error copy-knowledge-edit-message" role="alert" aria-live="polite">{message}</div>}
          <div className="field full copy-knowledge-edit-actions">
            <button className="button" type="button" disabled={busy} onClick={() => changeOpen(false)}>取消</button>
            <button className="button primary" type="submit" disabled={busy || !canSave}>{busy ? '保存中…' : '保存修改'}</button>
          </div>
        </form>}
      </DialogContent>
    </Dialog>
  </>;
}

export function CopyKnowledgeLibrary({
  items,
  labels,
  selectedLabel,
  onSelectLabel,
  onAddAnalysis,
}: {
  items: CopyKnowledgeItem[];
  labels: LabelSummary[];
  selectedLabel: string;
  onSelectLabel: (label: string) => void;
  onAddAnalysis: () => void;
}) {
  const router = useRouter();
  const confirm = useConfirmDialog();
  const [searchQuery, setSearchQuery] = useState('');
  const [viewedItem, setViewedItem] = useState<CopyKnowledgeItem | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [removedIds, setRemovedIds] = useState<Set<number>>(() => new Set());
  const [message, setMessage] = useState('');

  const availableItems = items.filter((item) => !removedIds.has(item.id));
  const labelItems = selectedLabel === 'ALL'
    ? availableItems
    : availableItems.filter((item) => item.labels.includes(selectedLabel));
  const query = normalizedSearch(searchQuery);
  const visibleItems = query
    ? labelItems.filter((item) => normalizedSearch(item.title).includes(query))
    : labelItems;

  async function deleteItem(item: CopyKnowledgeItem) {
    if (!await confirm({
      title: '删除这条文案分析？',
      description: `“${item.title}”将从文案知识库中移除，之后不会再参与内容生成匹配。`,
      confirmLabel: '删除分析',
      tone: 'danger',
    })) return;
    setDeletingId(item.id);
    setMessage('');
    try {
      await apiRequest(`/api/copy-knowledge-items/${item.id}`, { method: 'DELETE' });
      setRemovedIds((current) => new Set(current).add(item.id));
      if (viewedItem?.id === item.id) setViewedItem(null);
      setMessage(`“${item.title}”已删除。`);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? `删除失败：${error.message}` : '删除失败');
    } finally {
      setDeletingId(null);
    }
  }

  const messageIsError = message.includes('失败');
  const emptyMessage = availableItems.length === 0
    ? '还没有文案分析。点击“新增分析”，生成第一条分类知识。'
    : query
      ? `没有找到标题包含“${searchQuery.trim()}”的分析。`
      : '这个标签下还没有文案分析。';

  return <section className="panel copy-knowledge-library" aria-labelledby="copy-knowledge-library-heading">
    <div className="panel-head">
      <div><span className="eyebrow">Classified library</span><h2 id="copy-knowledge-library-heading">文案知识库</h2></div>
      <div className="copy-knowledge-library-actions">
        <span className="subtle">{availableItems.length} 条</span>
        <button className="button primary" type="button" onClick={onAddAnalysis}><Plus aria-hidden="true" size={15} />新增分析</button>
      </div>
    </div>
    <div className="copy-label-filter-block">
      <span className="subtle" id="copy-label-filter-label">按标签查看</span>
      <div className="copy-label-filters" role="group" aria-labelledby="copy-label-filter-label">
        <button className="button small" type="button" aria-pressed={selectedLabel === 'ALL'} onClick={() => onSelectLabel('ALL')}>全部 {availableItems.length}</button>
        {labels.map((label) => <button className="button small" type="button" key={label.name} aria-pressed={selectedLabel === label.name} onClick={() => onSelectLabel(label.name)}>{label.name} {label.itemCount}</button>)}
      </div>
    </div>
    <label className="copy-knowledge-search">
      <span className="sr-only">根据分析标题搜索</span>
      <Search aria-hidden="true" size={16} />
      <input className="input" type="search" value={searchQuery} maxLength={200} placeholder="搜索分析标题" onChange={(event) => setSearchQuery(event.target.value)} />
    </label>
    {message && <div className={messageIsError ? 'notice error copy-knowledge-library-message' : 'notice success copy-knowledge-library-message'} role={messageIsError ? 'alert' : 'status'} aria-live="polite">{message}</div>}
    {visibleItems.length === 0 ? <div className="empty-state">{emptyMessage}</div> : <ul className="copy-knowledge-list">
      {visibleItems.map((item) => <li key={item.id}>
        <div className="copy-knowledge-item-head">
          <div><h3>{item.title}</h3><p>{item.summary}</p></div>
          <div className="copy-knowledge-item-side">
            <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('zh-CN')}</time>
            <div className="copy-knowledge-item-actions">
              <button className="button small" type="button" onClick={() => setViewedItem(item)}><Eye aria-hidden="true" size={13} />查看</button>
              <CopyKnowledgeEditor item={item} />
              <button className="button small danger" type="button" disabled={deletingId !== null} onClick={() => { void deleteItem(item); }}><Trash2 aria-hidden="true" size={13} />{deletingId === item.id ? '删除中…' : '删除'}</button>
            </div>
          </div>
        </div>
        <div className="copy-knowledge-labels" aria-label="分类标签">{item.labels.map((label: string) => <span className="pill" key={label}>{label}</span>)}</div>
      </li>)}
    </ul>}

    <Dialog open={Boolean(viewedItem)} onOpenChange={(open) => { if (!open) setViewedItem(null); }}>
      <DialogContent className="copy-knowledge-view-dialog">
        {viewedItem && <>
          <div className="copy-knowledge-dialog-head">
            <DialogTitle>{viewedItem.title}</DialogTitle>
            <DialogDescription>{viewedItem.summary}</DialogDescription>
          </div>
          <div className="copy-knowledge-labels" aria-label="分类标签">{viewedItem.labels.map((label) => <span className="pill" key={label}>{label}</span>)}</div>
          <div className="copy-knowledge-view-content">
            <section><h3>优秀文案</h3><p>{viewedItem.sourceCopy}</p></section>
            <section><h3>分析 Prompt</h3><p>{viewedItem.analysisPrompt}</p></section>
            <section><h3>完整分析</h3><p>{viewedItem.analysis}</p></section>
          </div>
          <div className="copy-knowledge-dialog-actions">
            <DialogClose asChild><button className="button primary" type="button">关闭</button></DialogClose>
          </div>
        </>}
      </DialogContent>
    </Dialog>
  </section>;
}
