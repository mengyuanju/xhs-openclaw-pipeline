'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { TaskState } from './views';
import { AdminCreatorFilter, type JobCreator } from './admin-creator-filter';

export const CREATOR_ROLE_LABELS: Record<string, string> = {
  ADMIN: '管理员', REVIEWER: '审核员', USER: '普通用户', UNKNOWN: '未知角色',
};

export function AdminJobFilters({ role, state, creator, stateLabels, onRoleChange, onStateChange, onCreatorChange }: {
  role: string;
  state: string;
  creator: JobCreator | null;
  stateLabels: Record<TaskState, string>;
  onRoleChange: (value: string) => void;
  onStateChange: (value: string) => void;
  onCreatorChange: (value: JobCreator | null) => void;
}) {
  return <div className="workbench-admin-filters">
    <AdminCreatorFilter value={creator} roleLabels={CREATOR_ROLE_LABELS} onChange={onCreatorChange} />
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
  </div>;
}
