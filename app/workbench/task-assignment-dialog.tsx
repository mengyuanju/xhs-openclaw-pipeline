'use client';

import { useEffect, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';

import { apiRequest } from '../components/api-client';
import { selectedTasksHaveMixedAssignees } from '../../src/control-plane/task-assignment.mjs';
import { CREATOR_ROLE_LABELS } from './admin-job-filters';
import { JobUserPicker, type JobCreator } from './job-user-picker';

export type AssignmentTask = {
  id: number;
  query: string;
  state: string;
  skipCopyReview?: boolean;
  assignedToUserId: string | null;
  assignedToAccountId?: number | null;
  assignedToDisplayName?: string | null;
};

function currentAssignee(tasks: AssignmentTask[]): JobCreator | null {
  const username = tasks[0]?.assignedToUserId;
  if (!username || tasks.some((task) => task.assignedToUserId !== username)) return null;
  const accountId = Number(tasks[0]?.assignedToAccountId);
  return {
    id: Number.isSafeInteger(accountId) && accountId > 0 ? accountId : null,
    username,
    displayName: tasks[0].assignedToDisplayName || username,
    role: 'USER',
    status: 'ACTIVE',
  };
}

export function TaskAssignmentDialog({ tasks, open, currentAdmin, onOpenChange, onAssigned }: {
  tasks: AssignmentTask[];
  open: boolean;
  currentAdmin: JobCreator;
  onOpenChange: (open: boolean) => void;
  onAssigned: (message: string) => void | Promise<void>;
}) {
  const [assignee, setAssignee] = useState<JobCreator | null>(null);
  const [destinationRequired, setDestinationRequired] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const canReturnToPool = tasks.every((task) => (
    ['COPY_QUEUED', 'COPY_REVIEW_PENDING'].includes(task.state)
      && !(task.skipCopyReview === true && task.state === 'COPY_QUEUED')
  ));

  useEffect(() => {
    if (!open) return;
    const current = currentAssignee(tasks);
    setAssignee(current);
    setDestinationRequired(selectedTasksHaveMixedAssignees(tasks)
      || tasks.some((task) => task.assignedToUserId !== null
        && (!Number.isSafeInteger(task.assignedToAccountId) || Number(task.assignedToAccountId) < 1))
      || (!canReturnToPool && current === null));
    setReason('');
    setError('');
  }, [open, tasks]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || tasks.length === 0) return;
    if (destinationRequired) {
      setError(canReturnToPool
        ? '所选任务当前负责人不一致，请先明确选择新的负责人或待分配任务池。'
        : '当前任务不能退回待分配池，请先明确选择新的负责人。');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const reasonValue = reason.trim() || undefined;
      if (tasks.length === 1) {
        await apiRequest(`/api/control-plane/v1/tasks/${tasks[0].id}/assignee`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assignedToUserId: assignee?.username ?? null,
            assignedToAccountId: assignee?.id ?? null, reason: reasonValue }),
        });
      } else {
        await apiRequest('/api/control-plane/v1/tasks/batch-assignee', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskIds: tasks.map((task) => task.id),
            assignedToUserId: assignee?.username ?? null,
            assignedToAccountId: assignee?.id ?? null, reason: reasonValue }),
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
        文案生成完成后可分配给普通作业员，或由当前管理员领取。负责人变更不会影响机器执行队列。
      </DialogDescription>
      <form className="workbench-create-form" onSubmit={submit}>
        <JobUserPicker
          value={assignee}
          label="负责人"
          triggerId="task-assignment-user"
          emptyLabel={destinationRequired ? '负责人不一致，请重新选择' : '待分配任务池'}
          emptyOptionLabel="待分配任务池"
          emptyOptionSelected={!destinationRequired && assignee === null}
          dialogTitle="选择任务负责人"
          dialogDescription="显示已启用的普通作业员和当前管理员；未加入自动分配池的普通作业员仍可手动指定。"
          roleLabels={CREATOR_ROLE_LABELS}
          eligibleRoles={['USER']}
          additionallyEligibleUserIds={[Number(currentAdmin.id)]}
          activeOnly
          allowEmptyOption={canReturnToPool}
          disabled={submitting}
          onChange={(nextAssignee) => {
            setAssignee(nextAssignee);
            setDestinationRequired(false);
            setError('');
          }}
        />
        <div className="workbench-row-actions">
          <Button unstyled className="button small" type="button" disabled={submitting}
            onClick={() => {
              setAssignee(currentAdmin);
              setDestinationRequired(false);
              setError('');
            }}>我来处理</Button>
          {!canReturnToPool && <small>当前状态只能改派负责人，不能退回待分配池。</small>}
        </div>
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
            <Button unstyled className="button primary" type="submit"
              disabled={submitting || tasks.length === 0 || destinationRequired}>
              {submitting ? '正在分配…' : '确认分配'}
            </Button>
          </div>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
