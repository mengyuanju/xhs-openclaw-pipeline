'use client';

import { JobUserPicker, type JobCreator } from './job-user-picker';

export type { JobCreator } from './job-user-picker';

export function AdminCreatorFilter({ value, roleLabels, onChange }: {
  value: JobCreator | null;
  roleLabels: Record<string, string>;
  onChange: (value: JobCreator | null) => void;
}) {
  return <JobUserPicker
    value={value}
    label="作业员（创建者）"
    triggerId="workbench-creator"
    emptyLabel="全部作业员"
    dialogTitle="选择作业员"
    dialogDescription="按姓名或账号搜索，选定后查看该账号创建的作业，可继续叠加角色、状态和 Query 筛选。"
    roleLabels={roleLabels}
    onChange={onChange}
  />;
}
