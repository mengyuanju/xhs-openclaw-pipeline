'use client';

import { Button } from '@/components/ui/button';
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { paginationBounds } from '../../src/control-plane/workbench-pagination.mjs';

type PageIntent = 'first' | 'previous' | 'next' | 'last';

export function WorkbenchPagination({ page, pageSize, total, offset, count, busy, loadError, onRetry, onPageChange, onPageSizeChange }: {
  page: number;
  pageSize: number;
  total: number;
  offset: number;
  count: number;
  busy: boolean;
  loadError: string;
  onRetry: () => void;
  onPageChange: (page: number, intent: PageIntent) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const { totalPages } = paginationBounds(total, pageSize, page);

  return <nav className="workbench-pagination" aria-label="任务列表分页">
    <div className="workbench-page-summary">
      <span>{busy ? '正在读取…' : `${loadError ? '上次结果' : '显示'} ${count ? offset + 1 : 0}–${count ? offset + count : 0} 条，共 ${total} 条`}</span>
      <Select value={String(pageSize)} disabled={busy} onValueChange={(value) => onPageSizeChange(Number(value))}>
        <SelectTrigger aria-label="每页条数"><SelectValue /></SelectTrigger>
        <SelectContent>{[20, 50, 100].map((size) => <SelectItem key={size} value={String(size)}>{size} 条 / 页</SelectItem>)}</SelectContent>
      </Select>
      {loadError && <Button unstyled className="button small" type="button" disabled={busy} onClick={onRetry}>重试读取</Button>}
    </div>
    <div className="workbench-page-buttons">
      <Button unstyled className="button small" type="button" disabled={page <= 1 || busy} onClick={() => onPageChange(1, 'first')}><ChevronFirst size={14} aria-hidden="true" />首页</Button>
      <Button unstyled className="button small" type="button" disabled={page <= 1 || busy} onClick={() => onPageChange(page - 1, 'previous')}><ChevronLeft size={14} aria-hidden="true" />上一页</Button>
      <span role="status">{busy ? `读取第 ${page} 页…` : loadError ? `第 ${page} 页读取失败` : `第 ${page} / ${totalPages} 页`}</span>
      <Button unstyled className="button small" type="button" disabled={page >= totalPages || busy} onClick={() => onPageChange(page + 1, 'next')}>下一页<ChevronRight size={14} aria-hidden="true" /></Button>
      <Button unstyled className="button small" type="button" disabled={page >= totalPages || busy} onClick={() => onPageChange(totalPages, 'last')}>尾页<ChevronLast size={14} aria-hidden="true" /></Button>
    </div>
  </nav>;
}
