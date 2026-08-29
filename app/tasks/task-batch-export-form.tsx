'use client';

import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useState,
} from 'react';

type TaskBatchExportFormProps = {
  exportableCount: number;
  children: ReactNode;
};

function selectedIds(form: HTMLFormElement) {
  return new FormData(form).getAll('taskId')
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}

function downloadName(contentDisposition: string | null) {
  const match = contentDisposition?.match(/filename="([^"]+)"/i);
  return (match?.[1] || 'xhs-task-batch.zip').replace(/[\\/:*?"<>|]/g, '-');
}

export function TaskBatchExportForm({ exportableCount, children }: TaskBatchExportFormProps) {
  const [selectedTaskIds, setSelectedTaskIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [messageIsError, setMessageIsError] = useState(false);
  const allSelected = exportableCount > 0 && selectedTaskIds.length === exportableCount;
  const guidance = busy
    ? '正在打包，请稍候。'
    : exportableCount < 1
      ? '暂不可操作：本页没有待审核或已通过且交付文件完整的任务；逐条原因见下方。'
      : selectedTaskIds.length < 1
        ? '批量导出不可操作：请先勾选至少 1 条可导出任务。'
        : `已选择 ${selectedTaskIds.length} 条任务，可以开始批量导出。`;

  function syncSelection(event: ChangeEvent<HTMLFormElement>) {
    if (event.target instanceof HTMLInputElement && event.target.name === 'taskId') {
      setSelectedTaskIds(selectedIds(event.currentTarget));
      setMessage('');
    }
  }

  function toggleAll(event: FormEvent<HTMLButtonElement>) {
    const form = event.currentTarget.form;
    if (!form) return;
    const checkboxes = form.querySelectorAll<HTMLInputElement>('input[name="taskId"]:not(:disabled)');
    const shouldSelect = Array.from(checkboxes).some((checkbox) => !checkbox.checked);
    checkboxes.forEach((checkbox) => { checkbox.checked = shouldSelect; });
    setSelectedTaskIds(selectedIds(form));
    setMessage('');
  }

  async function exportSelected(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const taskIds = selectedIds(event.currentTarget);
    if (taskIds.length < 1) return;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/task-exports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message || `批量导出失败（${response.status}）`);
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = downloadName(response.headers.get('content-disposition'));
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setMessage(`已开始下载 ${taskIds.length} 条任务的批量 ZIP。`);
      setMessageIsError(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '批量导出失败，请稍后重试');
      setMessageIsError(true);
    } finally {
      setBusy(false);
    }
  }

  return <form className="batch-export-form" onChange={syncSelection} onSubmit={exportSelected}>
    <section className="panel batch-export-toolbar" aria-label="批量导出任务">
      <div className="batch-export-copy"><strong>批量导出</strong><span className="subtle">处于待审核或已通过状态、且交付文件完整的任务均可导出，下载包会按任务分目录。</span></div>
      <div className="inline batch-export-actions">
        <button className="button" type="button" disabled={busy || exportableCount < 1} aria-describedby="batch-export-guidance" title={busy || exportableCount < 1 ? guidance : undefined} onClick={toggleAll}>{allSelected ? '取消全选' : '全选本页可导出任务'}</button>
        <span className="subtle batch-export-summary" aria-live="polite">本页可导出 {exportableCount} 条 · 已选 {selectedTaskIds.length} 条</span>
        <button className="button primary" type="submit" disabled={busy || selectedTaskIds.length < 1} aria-describedby="batch-export-guidance" title={busy || selectedTaskIds.length < 1 ? guidance : undefined}>{busy ? '正在打包…' : `批量导出 ZIP（${selectedTaskIds.length}）`}</button>
      </div>
      <p className="batch-export-guidance" id="batch-export-guidance" role="note" aria-live="polite">{guidance}</p>
      {message && <div className={messageIsError ? 'notice error batch-export-message' : 'notice success batch-export-message'} role={messageIsError ? 'alert' : 'status'} aria-live="polite">{message}</div>}
    </section>
    {children}
  </form>;
}
