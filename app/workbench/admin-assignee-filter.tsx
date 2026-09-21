'use client';

import { JobUserPicker, type JobCreator } from './job-user-picker';

export function AdminAssigneeFilter({ value, roleLabels, onChange }: {
  value: JobCreator | null;
  roleLabels: Record<string, string>;
  onChange: (value: JobCreator | null) => void;
}) {
  return <JobUserPicker
    value={value}
    label="负责人"
    triggerId="workbench-assignee"
    emptyLabel="全部负责人"
    dialogTitle="选择负责人"
    dialogDescription="按姓名或账号搜索，选定后只查看分配给该账号的作业，可与创建人、角色、状态和 Query 筛选组合使用。"
    roleLabels={roleLabels}
    onChange={onChange}
  />;
}
