'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { paginationBounds, parsePageNumber } from '../../src/control-plane/workbench-pagination.mjs';

export function WorkbenchPagination({ page, pageSize, total, offset, count, busy, loadError, onRetry, onPageChange, onPageSizeChange }: {
  page: number;
  pageSize: number;
  total: number;
  offset: number;
  count: number;
  busy: boolean;
  loadError: string;
  onRetry: () => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const id = useId();
  const { totalPages } = paginationBounds(total, pageSize, page);
  const [pageInput, setPageInput] = useState(String(page));
  const [error, setError] = useState('');
  useEffect(() => { setPageInput(String(page)); setError(''); }, [page, pageSize, totalPages]);

  function jump(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const next = parsePageNumber(pageInput, totalPages);
    if (next === null) { setError(`请输入 1–${totalPages} 的整数页码`); return; }
    setError('');
    setPageInput(String(next));
    onPageChange(next);
  }

  return <nav className="workbench-pagination" aria-label="任务列表分页">
    <div className="workbench-page-summary">
      <span>{busy ? '正在读取…' : `${loadError ? '上次结果' : '显示'} ${count ? offset + 1 : 0}–${count ? offset + count : 0} 条，共 ${total} 条`}</span>
      <label className="sr-only" htmlFor={`${id}-size`}>每页条数</label>
      <Select value={String(pageSize)} disabled={busy} onValueChange={(value) => onPageSizeChange(Number(value))}>
        <SelectTrigger id={`${id}-size`}><SelectValue /></SelectTrigger>
        <SelectContent>{[20, 50, 100].map((size) => <SelectItem key={size} value={String(size)}>{size} 条 / 页</SelectItem>)}</SelectContent>
      </Select>
      {loadError && <Button unstyled className="button small" type="button" disabled={busy} onClick={onRetry}>重试读取</Button>}
    </div>
    <div className="workbench-page-buttons">
      <Button unstyled className="button small" type="button" disabled={page <= 1 || busy} onClick={() => onPageChange(1)}><ChevronFirst size={14} aria-hidden="true" />首页</Button>
      <Button unstyled className="button small" type="button" disabled={page <= 1 || busy} onClick={() => onPageChange(page - 1)}><ChevronLeft size={14} aria-hidden="true" />上一页</Button>
      <span role="status">{busy ? `读取第 ${page} 页…` : loadError ? `第 ${page} 页读取失败` : `第 ${page} / ${totalPages} 页`}</span>
      <Button unstyled className="button small" type="button" disabled={page >= totalPages || busy} onClick={() => onPageChange(page + 1)}>下一页<ChevronRight size={14} aria-hidden="true" /></Button>
      <Button unstyled className="button small" type="button" disabled={page >= totalPages || busy} onClick={() => onPageChange(totalPages)}>尾页<ChevronLast size={14} aria-hidden="true" /></Button>
    </div>
    <form className="workbench-page-jump" onSubmit={jump}>
      <label htmlFor={`${id}-page`}>跳至</label>
      <Input id={`${id}-page`} type="text" inputMode="numeric" maxLength={10} value={pageInput} aria-label="跳转页码" aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} disabled={busy} onChange={(event) => { setPageInput(event.target.value); setError(''); }} />
      <span>页</span><Button unstyled className="button small" type="submit" disabled={busy}>跳转</Button>
    </form>
    {error && <p id={`${id}-error`} className="workbench-page-error" role="alert">{error}</p>}
  </nav>;
}
