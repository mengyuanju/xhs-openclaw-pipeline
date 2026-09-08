'use client';

import { useEffect, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';

import { apiRequest } from '../components/api-client';
import { CREATOR_ROLE_LABELS } from './admin-job-filters';
import { JobUserPicker, type JobCreator } from './job-user-picker';

export type AssignmentTask = {
  id: number;
  query: string;
  assignedToUserId: string | null;
  assignedToDisplayName?: string | null;
};

function currentAssignee(tasks: AssignmentTask[]): JobCreator | null {
  const username = tasks[0]?.assignedToUserId;
  if (!username || tasks.some((task) => task.assignedToUserId !== username)) return null;
  return {
    username,
    displayName: tasks[0].assignedToDisplayName || username,
    role: 'USER',
    status: 'ACTIVE',
  };
}

export function TaskAssignmentDialog({ tasks, open, onOpenChange, onAssigned }: {
  tasks: AssignmentTask[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAssigned: (message: string) => void | Promise<void>;
}) {
  const [assignee, setAssignee] = useState<JobCreator | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setAssignee(currentAssignee(tasks));
    setReason('');
    setError('');
  }, [open, tasks]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || tasks.length === 0) return;
    setSubmitting(true);
    setError('');
    try {
      const reasonValue = reason.trim() || undefined;
      if (tasks.length === 1) {
        await apiRequest(`/api/control-plane/v1/tasks/${tasks[0].id}/assignee`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assignedToUserId: assignee?.username ?? null, reason: reasonValue }),
        });
      } else {
        await apiRequest('/api/control-plane/v1/tasks/batch-assignee', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskIds: tasks.map((task) => task.id),
            assignedToUserId: assignee?.username ?? null, reason: reasonValue }),
        });
      }
      const destination = assignee ? `${assignee.displayName}（${assignee.username}）` : '待分配任务池';
      onOpenChange(false);
      await onAssigned(`已将 ${tasks.length} 条任务分配至${destination}。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '任务分配失败');
    } finally {
      setSubmitting(false);
    }
  }

  return <Dialog open={open} onOpenChange={(nextOpen) => { if (!submitting) onOpenChange(nextOpen); }}>
    <DialogContent className="workbench-save-view-dialog">
      <DialogTitle>{tasks.length > 1 ? `批量分配 ${tasks.length} 条任务` : '分配任务'}</DialogTitle>
      <DialogDescription>
        只能选择已启用的普通作业员。选择“待分配任务池”会撤回尚未开始的文案任务，执行机不会领取待分配任务。
      </DialogDescription>
      <form className="workbench-create-form" onSubmit={submit}>
        <JobUserPicker
          value={assignee}
          label="负责人"
          triggerId="task-assignment-user"
          emptyLabel="待分配任务池"
          dialogTitle="选择任务负责人"
          dialogDescription="仅显示已启用的普通作业员。未加入自动分配池的人员仍可由管理员手动指定。"
          roleLabels={CREATOR_ROLE_LABELS}
          eligibleRoles={['USER']}
          activeOnly
          disabled={submitting}
          onChange={setAssignee}
        />
        <div className="field">
          <label htmlFor="task-assignment-reason">分配说明（可选）</label>
          <Textarea id="task-assignment-reason" value={reason} maxLength={200} rows={3} disabled={submitting}
            placeholder="例如：补充夜班作业量" onChange={(event) => setReason(event.target.value)} />
        </div>
        {error && <div className="notice error" role="alert">{error}</div>}
        <div className="workbench-create-footer">
          <span aria-live="polite">{tasks.length === 1 ? `Query #${tasks[0]?.id}` : `已选择 ${tasks.length} 条任务`}</span>
          <div>
            <Button unstyled className="button" type="button" disabled={submitting} onClick={() => onOpenChange(false)}>取消</Button>
            <Button unstyled className="button primary" type="submit" disabled={submitting || tasks.length === 0}>
              {submitting ? '正在分配…' : '确认分配'}
            </Button>
          </div>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
