'use client';

import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

import { ChevronLeft, ChevronRight, Eye, Pencil, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, useTransition, type FormEvent } from 'react';

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

const VISIBLE_LABEL_FILTER_COUNT = 8;
const COPY_KNOWLEDGE_PAGE_SIZES = [10, 20, 50];

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

export type CopyKnowledgePagination = {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
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
    <Button unstyled className="button small" type="button" onClick={() => changeOpen(true)}><Pencil aria-hidden="true" size={13} />编辑</Button>
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="copy-knowledge-edit-dialog">
        <div className="copy-knowledge-dialog-head">
          <DialogTitle>编辑文案分析</DialogTitle>
          <DialogDescription>修改已保存的标题、文案、分析内容和分类标签。</DialogDescription>
        </div>
        {draft && <form className="form-grid copy-knowledge-edit-form" onSubmit={save}>
          <div className="field full">
            <label htmlFor={fieldId('title')}>分析标题</label>
            <Input className="input" id={fieldId('title')} value={draft.title} maxLength={200} onChange={(event) => updateDraft('title', event.target.value)} required />
          </div>
          <div className="field full">
            <label htmlFor={fieldId('source')}>优秀文案</label>
            <Textarea className="textarea" id={fieldId('source')} value={draft.sourceCopy} maxLength={20_000} onChange={(event) => updateDraft('sourceCopy', event.target.value)} required />
          </div>
          <div className="field full">
            <label htmlFor={fieldId('prompt')}>分析 Prompt</label>
            <Textarea className="textarea compact" id={fieldId('prompt')} value={draft.analysisPrompt} maxLength={8_000} onChange={(event) => updateDraft('analysisPrompt', event.target.value)} required />
          </div>
          <div className="field full">
            <label htmlFor={fieldId('summary')}>分析摘要</label>
            <Textarea className="textarea compact" id={fieldId('summary')} value={draft.summary} maxLength={2_000} onChange={(event) => updateDraft('summary', event.target.value)} required />
          </div>
          <div className="field full">
            <label htmlFor={fieldId('analysis')}>完整分析</label>
            <Textarea className="textarea" id={fieldId('analysis')} value={draft.analysis} maxLength={15_000} onChange={(event) => updateDraft('analysis', event.target.value)} required />
          </div>
          <div className="field full">
            <label htmlFor={fieldId('labels')}>分类标签（逗号或换行分隔）</label>
            <Input className="input" id={fieldId('labels')} value={labelText} maxLength={620} aria-describedby={fieldId('labels-help')} onChange={(event) => { setLabelText(event.target.value); setMessage(''); }} required />
            <small id={fieldId('labels-help')}>至少 1 个、最多 12 个标签；重复标签会自动合并。</small>
          </div>
          {message && <div className="notice error copy-knowledge-edit-message" role="alert" aria-live="polite">{message}</div>}
          <div className="field full copy-knowledge-edit-actions">
            <Button unstyled className="button" type="button" disabled={busy} onClick={() => changeOpen(false)}>取消</Button>
            <Button unstyled className="button primary" type="submit" disabled={busy || !canSave}>{busy ? '保存中…' : '保存修改'}</Button>
          </div>
        </form>}
      </DialogContent>
    </Dialog>
  </>;
}

export function CopyKnowledgeLibrary({
  items,
  pagination,
  labels,
  selectedLabel,
  searchQuery,
  onAddAnalysis,
}: {
  items: CopyKnowledgeItem[];
  pagination: CopyKnowledgePagination;
  labels: LabelSummary[];
  selectedLabel: string;
  searchQuery: string;
  onAddAnalysis: () => void;
}) {
  const router = useRouter();
  const confirm = useConfirmDialog();
  const [searchValue, setSearchValue] = useState(searchQuery);
  const [viewedItem, setViewedItem] = useState<CopyKnowledgeItem | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [removedIds, setRemovedIds] = useState<Set<number>>(() => new Set());
  const [message, setMessage] = useState('');
  const [showAllLabels, setShowAllLabels] = useState(false);
  const [isPending, startTransition] = useTransition();

  const availableItems = items.filter((item) => !removedIds.has(item.id));
  const selectedLabelSummary = labels.find((label) => label.name === selectedLabel);
  const visibleLabelFilters = showAllLabels
    ? labels
    : [
      ...(selectedLabelSummary ? [selectedLabelSummary] : []),
      ...labels.filter((label) => label.name !== selectedLabel).slice(0, VISIBLE_LABEL_FILTER_COUNT - (selectedLabelSummary ? 1 : 0)),
    ];
  const hasHiddenLabelFilters = labels.length > VISIBLE_LABEL_FILTER_COUNT;
  const currentTotal = Math.max(0, pagination.totalItems - removedIds.size);
  const itemStart = availableItems.length > 0 ? (pagination.page - 1) * pagination.pageSize + 1 : 0;
  const itemEnd = availableItems.length > 0 ? itemStart + availableItems.length - 1 : 0;

  const replaceView = useCallback((updates: Record<string, string | null>) => {
    const params = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(updates)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const query = params.toString();
    startTransition(() => router.replace(query ? `/knowledge?${query}` : '/knowledge', { scroll: false }));
  }, [router]);

  useEffect(() => {
    setSearchValue(searchQuery);
  }, [searchQuery]);

  useEffect(() => {
    if (normalizedSearch(searchValue) === normalizedSearch(searchQuery)) return;
    const timer = window.setTimeout(() => {
      replaceView({ copyQuery: searchValue.trim() || null, copyPage: null });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [replaceView, searchQuery, searchValue]);

  useEffect(() => {
    const visibleIds = new Set(items.map((item) => item.id));
    setRemovedIds((current) => new Set([...current].filter((id) => visibleIds.has(id))));
  }, [items]);

  function selectLabel(label: string) {
    replaceView({ copyLabel: label === 'ALL' ? null : label, copyPage: null });
  }

  function selectPage(page: number) {
    replaceView({ copyPage: page > 1 ? String(page) : null });
  }

  function selectPageSize(pageSize: number) {
    replaceView({ copyPageSize: pageSize === 10 ? null : String(pageSize), copyPage: null });
  }

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
  const emptyMessage = pagination.totalItems === 0 && selectedLabel === 'ALL' && !searchQuery
    ? '还没有文案分析。点击“新增分析”，生成第一条分类知识。'
    : searchQuery
      ? `没有找到标题包含“${searchQuery.trim()}”的分析。`
      : '这个标签下还没有文案分析。';

  return <section className="panel copy-knowledge-library" aria-labelledby="copy-knowledge-library-heading">
    <div className="panel-head">
      <div><span className="eyebrow">Classified library</span><h2 id="copy-knowledge-library-heading">文案知识库</h2></div>
      <div className="copy-knowledge-library-actions">
        <span className="subtle">{currentTotal} 条</span>
        <Button unstyled className="button primary" type="button" onClick={onAddAnalysis}><Plus aria-hidden="true" size={15} />新增分析</Button>
      </div>
    </div>
    <div className="copy-label-filter-block">
      <span className="subtle" id="copy-label-filter-label">按标签查看</span>
      <div className="copy-label-filters" role="group" aria-labelledby="copy-label-filter-label">
        <Button unstyled className="button small" type="button" disabled={isPending} aria-pressed={selectedLabel === 'ALL'} onClick={() => selectLabel('ALL')}>全部</Button>
        {visibleLabelFilters.map((label) => <Button unstyled className="button small" type="button" disabled={isPending} key={label.name} aria-pressed={selectedLabel === label.name} onClick={() => selectLabel(label.name)}>{label.name} {label.itemCount}</Button>)}
        {hasHiddenLabelFilters && <Button unstyled className="button small copy-label-filter-toggle" type="button" aria-expanded={showAllLabels} onClick={() => setShowAllLabels((current) => !current)}>
          {showAllLabels ? '收起标签' : `展开全部（${labels.length}）`}
        </Button>}
      </div>
    </div>
    <div className="copy-knowledge-search">
      <span className="sr-only">根据分析标题搜索</span>
      <SearchInput className="input" value={searchValue} maxLength={200} placeholder="搜索分析标题" onValueChange={setSearchValue} />
    </div>
    {message && <div className={messageIsError ? 'notice error copy-knowledge-library-message' : 'notice success copy-knowledge-library-message'} role={messageIsError ? 'alert' : 'status'} aria-live="polite">{message}</div>}
    {availableItems.length === 0 ? <div className="empty-state">{emptyMessage}</div> : <ul className="copy-knowledge-list" aria-busy={isPending}>
      {availableItems.map((item) => <li key={item.id}>
        <div className="copy-knowledge-item-head">
          <div><h3>{item.title}</h3><p>{item.summary}</p></div>
          <div className="copy-knowledge-item-side">
            <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('zh-CN')}</time>
            <div className="copy-knowledge-item-actions">
              <Button unstyled className="button small" type="button" onClick={() => setViewedItem(item)}><Eye aria-hidden="true" size={13} />查看</Button>
              <CopyKnowledgeEditor item={item} />
              <Button unstyled className="button small danger" type="button" disabled={deletingId !== null} onClick={() => { void deleteItem(item); }}><Trash2 aria-hidden="true" size={13} />{deletingId === item.id ? '删除中…' : '删除'}</Button>
            </div>
          </div>
        </div>
        <div className="copy-knowledge-labels" aria-label="分类标签">{item.labels.map((label: string) => <span className="pill" key={label}>{label}</span>)}</div>
      </li>)}
    </ul>}

    <nav className="copy-knowledge-pagination" aria-label="文案知识库分页">
      <div className="copy-knowledge-page-summary">
        <span>{isPending ? '正在读取…' : `显示 ${itemStart}–${itemEnd} 条，共 ${currentTotal} 条`}</span>
        <label className="sr-only" htmlFor="copy-knowledge-page-size">每页条数</label>
        <Select value={String(pagination.pageSize)} disabled={isPending} onValueChange={(value) => selectPageSize(Number(value))}>
          <SelectTrigger id="copy-knowledge-page-size"><SelectValue /></SelectTrigger>
          <SelectContent>{COPY_KNOWLEDGE_PAGE_SIZES.map((size) => <SelectItem key={size} value={String(size)}>{size} 条 / 页</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="copy-knowledge-page-buttons">
        <Button unstyled className="button small" type="button" disabled={pagination.page <= 1 || isPending} onClick={() => selectPage(pagination.page - 1)}><ChevronLeft aria-hidden="true" size={14} />上一页</Button>
        <span role="status">第 {pagination.page} / {pagination.totalPages} 页</span>
        <Button unstyled className="button small" type="button" disabled={pagination.page >= pagination.totalPages || isPending} onClick={() => selectPage(pagination.page + 1)}>下一页<ChevronRight aria-hidden="true" size={14} /></Button>
      </div>
    </nav>

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
            <DialogClose asChild><Button unstyled className="button primary" type="button">关闭</Button></DialogClose>
          </div>
        </>}
      </DialogContent>
    </Dialog>
  </section>;
}
