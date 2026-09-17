'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import type { TaskState } from './views';
import { AdminCreatorFilter, type JobCreator } from './admin-creator-filter';
import { AdminAssigneeFilter } from './admin-assignee-filter';

export const CREATOR_ROLE_LABELS: Record<string, string> = {
  ADMIN: '管理员', REVIEWER: '审核员', USER: '普通用户', UNKNOWN: '未知角色',
};

export function AdminJobFilters({ role, state, creator, assignee, createdDateFrom, createdDateTo, stateLabels,
  onRoleChange, onStateChange, onCreatorChange, onAssigneeChange,
  onCreatedDateFromChange, onCreatedDateToChange }: {
  role: string;
  state: string;
  creator: JobCreator | null;
  assignee: JobCreator | null;
  createdDateFrom: string;
  createdDateTo: string;
  stateLabels: Record<TaskState, string>;
  onRoleChange: (value: string) => void;
  onStateChange: (value: string) => void;
  onCreatorChange: (value: JobCreator | null) => void;
  onAssigneeChange: (value: JobCreator | null) => void;
  onCreatedDateFromChange: (value: string) => void;
  onCreatedDateToChange: (value: string) => void;
}) {
  return <div className="workbench-admin-filters">
    <AdminCreatorFilter value={creator} roleLabels={CREATOR_ROLE_LABELS} onChange={onCreatorChange} />
    <AdminAssigneeFilter value={assignee} roleLabels={CREATOR_ROLE_LABELS} onChange={onAssigneeChange} />
    <div>
      <label htmlFor="workbench-creator-role">创建者当前角色</label>
      <Select value={role} onValueChange={onRoleChange}>
        <SelectTrigger id="workbench-creator-role"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">全部角色</SelectItem>
          {Object.entries(CREATOR_ROLE_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
    <div>
      <label htmlFor="workbench-task-state">任务状态</label>
      <Select value={state} onValueChange={onStateChange}>
        <SelectTrigger id="workbench-task-state"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">全部状态</SelectItem>
          {Object.entries(stateLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
    <div>
      <label htmlFor="workbench-created-date-from">创建日期（起）</label>
      <Input id="workbench-created-date-from" type="date" value={createdDateFrom}
        max={createdDateTo || undefined}
        onChange={(event) => onCreatedDateFromChange(event.target.value)} />
    </div>
    <div>
      <label htmlFor="workbench-created-date-to">创建日期（止，含当天）</label>
      <Input id="workbench-created-date-to" type="date" value={createdDateTo}
        min={createdDateFrom || undefined}
        onChange={(event) => onCreatedDateToChange(event.target.value)} />
    </div>
  </div>;
}
