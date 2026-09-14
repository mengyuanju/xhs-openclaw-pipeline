'use client';

import { useState } from 'react';
import { apiRequest } from '@/app/components/api-client';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Checkbox, Textarea } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';

export type PriorityTask = { id: number; systemPriority?: number; manualPriority?: number | null;
  effectivePriority?: number; priorityMode?: string; priorityPaused?: boolean; queueEnteredAt?: string;
  reworkCount?: number; requeueReason?: string; priorityReason?: string | null; priorityVersion?: number;
  productionBatchId?: number | null };
const MODES = [['SYSTEM', '跟随系统（恢复系统优先级）'], ['HIGHEST', '最高优先 · 500'],
  ['HIGH', '高优先 · 350'], ['NORMAL', '普通 · 100'], ['DEFER', '暂缓 · 10'], ['PAUSE', '暂停']];

export function PrioritySummary({ task }: { task: PriorityTask }) {
  const systemReason = task.systemPriority === 400 ? ((task.reworkCount ?? 0) >= 2 ? '多次返工' : '强制复检')
    : task.systemPriority === 300 ? '修改或审核打回' : task.systemPriority === 200 ? '人工重试'
      : task.systemPriority === 150 ? '系统恢复' : '首次任务';
  return <span title={`系统规则：${systemReason}；进入队列：${task.queueEnteredAt ?? '未知'}；返工 ${task.reworkCount ?? 0} 次；${task.priorityReason ?? ''}`}>
    {task.priorityPaused ? '已暂停' : `优先级 ${task.effectivePriority ?? 100}`} · {task.priorityMode && task.priorityMode !== 'SYSTEM' ? '管理员' : '系统'}
    {`（系统 ${task.systemPriority ?? 100} / 人工 ${task.manualPriority ?? '—'}）`}
  </span>;
}

export function TaskPriorityControl({ tasks, onChanged }: { tasks: PriorityTask[]; onChanged: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('SYSTEM');
  const [reason, setReason] = useState('');
  const [wholeBatch, setWholeBatch] = useState(false);
  const [preview, setPreview] = useState<{ scope: object; items: PriorityTask[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const batchId = tasks[0]?.productionBatchId;
  const canBatch = batchId != null && tasks.every(task => task.productionBatchId === batchId);
  async function prepare() {
    setBusy(true); setError('');
    try {
      setPreview(await apiRequest('/api/control-plane/v1/tasks/priority-scope', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wholeBatch ? { productionBatchId: batchId } : { taskIds: tasks.map(task => task.id) }),
      }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : '读取范围失败'); }
    finally { setBusy(false); }
  }
  async function submit() {
    if (!preview || !reason.trim()) return;
    setBusy(true); setError('');
    try {
      await apiRequest('/api/control-plane/v1/tasks/priority', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...preview.scope, mode, reason,
          expectedVersions: Object.fromEntries(preview.items.map(task => [task.id, task.priorityVersion])) }),
      });
      setOpen(false); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '调整失败'); setPreview(null); }
    finally { setBusy(false); }
  }
  return <>
    <Button unstyled className="button small" type="button" onClick={() => {
      setOpen(true); setPreview(null); setReason(''); setError(''); setWholeBatch(false); setMode('SYSTEM');
    }}>调整优先级</Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <DialogContent><div><DialogTitle>调整任务优先级</DialogTitle>
        <DialogDescription>只调整排队顺序。运行中的任务继续执行；审核和批次冻结关卡保持有效。</DialogDescription>
      </div>
        <label>优先级 <Select value={mode} disabled={busy} onValueChange={setMode}><SelectTrigger aria-label="优先级"><SelectValue /></SelectTrigger><SelectContent>
          {MODES.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
        </SelectContent></Select></label>
        {canBatch && <label><Checkbox checked={wholeBatch} disabled={busy}
          onChange={event => { setWholeBatch(event.target.checked); setPreview(null); }} />调整整个生产批次 #{batchId}</label>}
        <label>调整原因（必填）<Textarea aria-label="调整原因" required maxLength={2000} value={reason}
          disabled={busy} onChange={event => setReason(event.target.value)} /></label>
        <p>同级先到先处理；每等待一小时补偿相当于 6 点的排序优势，避免长期等待。</p>
        {preview && <div><strong>将调整 {preview.items.length} 条任务</strong>
          <p>任务：{preview.items.slice(0, 20).map(task => `#${task.id}`).join('、')}
            {preview.items.length > 20 ? `，另 ${preview.items.length - 20} 条同批任务` : ''}</p></div>}
        {error && <p role="alert">{error}</p>}
        {!preview ? <Button type="button" disabled={busy || !reason.trim()} onClick={() => { void prepare(); }}>预览调整范围</Button>
          : <Button type="button" disabled={busy || !reason.trim()} onClick={() => { void submit(); }}>确认调整并记录原因</Button>}
      </DialogContent>
    </Dialog>
  </>;
}
