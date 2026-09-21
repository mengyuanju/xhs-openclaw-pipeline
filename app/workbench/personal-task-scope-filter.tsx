'use client';

import { Button } from '@/components/ui/button';

import type { PersonalTaskScope } from './list-state';

const OPTIONS: Array<{ value: PersonalTaskScope; label: string }> = [
  { value: 'ALL', label: '全部相关' },
  { value: 'ASSIGNED', label: '我负责的' },
  { value: 'CREATED', label: '我创建的' },
];

export function PersonalTaskScopeFilter({ value, onChange }: {
  value: PersonalTaskScope;
  onChange: (value: PersonalTaskScope) => void;
}) {
  return <div className="job-stats-chips workbench-personal-scope-filter" aria-label="按我与作业的关系筛选">
    <span className="workbench-personal-state-label">作业归属</span>
    {OPTIONS.map((option) => <Button unstyled key={option.value} type="button"
      aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</Button>)}
  </div>;
}
