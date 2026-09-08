'use client';

import { UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { SearchInput } from '@/components/ui/search-input';

import { loadJobCreators, type JobCreator } from '../../src/control-plane/job-creators.mjs';
import { apiRequest } from '../components/api-client';

export type { JobCreator } from '../../src/control-plane/job-creators.mjs';

export function JobUserPicker({
  value,
  label,
  triggerId,
  emptyLabel,
  emptyOptionLabel = emptyLabel,
  emptyOptionSelected,
  dialogTitle,
  dialogDescription,
  roleLabels,
  eligibleRoles,
  activeOnly = false,
  disabled = false,
  onChange,
}: {
  value: JobCreator | null;
  label: string;
  triggerId: string;
  emptyLabel: string;
  emptyOptionLabel?: string;
  emptyOptionSelected?: boolean;
  dialogTitle: string;
  dialogDescription: string;
  roleLabels: Record<string, string>;
  eligibleRoles?: string[];
  activeOnly?: boolean;
  disabled?: boolean;
  onChange: (value: JobCreator | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState<JobCreator[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    void loadJobCreators(apiRequest).then((nextUsers) => {
      if (!cancelled) setUsers(nextUsers);
    }).catch((caught) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : '作业员列表读取失败');
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, attempt]);

  const keyword = search.trim().toLocaleLowerCase('zh-CN');
  const matches = users.filter((user) => (
    (!eligibleRoles || eligibleRoles.includes(user.role))
    && (!activeOnly || user.status === 'ACTIVE')
    && (!keyword
      || user.username.toLocaleLowerCase('zh-CN').includes(keyword)
      || user.displayName.toLocaleLowerCase('zh-CN').includes(keyword))
  ));

  function choose(user: JobCreator | null) {
    onChange(user);
    setOpen(false);
  }

  return <div className="workbench-creator-filter">
    <label htmlFor={triggerId}>{label}</label>
    <div className="workbench-creator-control">
      <Dialog open={open} onOpenChange={(nextOpen) => {
        if (disabled) return;
        setOpen(nextOpen);
        if (nextOpen) setSearch('');
      }}>
        <DialogTrigger asChild>
          <Button unstyled className="select-trigger" id={triggerId} type="button" disabled={disabled}
            title={value ? `${value.displayName}（${value.username}）` : emptyLabel}>
            <span>{value ? `${value.displayName}（${value.username}）` : emptyLabel}</span>
            <UserRound size={16} aria-hidden="true" />
          </Button>
        </DialogTrigger>
        <DialogContent className="workbench-creator-dialog">
          <div className="workbench-creator-heading">
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>{dialogDescription}</DialogDescription>
          </div>
          <div className="workbench-creator-search">
            <SearchInput aria-label="搜索作业员姓名或账号" placeholder="输入姓名或账号" value={search}
              maxLength={100} onValueChange={setSearch} />
          </div>
          <div className="workbench-creator-results" aria-busy={loading}>
            <Button unstyled className="workbench-creator-option" type="button"
              aria-pressed={emptyOptionSelected ?? !value}
              onClick={() => choose(null)}>{emptyOptionLabel}</Button>
            {loading ? <p role="status">正在读取作业员…</p>
              : error ? <div role="alert"><p>读取失败：{error}</p><Button unstyled className="button small" type="button"
                  onClick={() => setAttempt((count) => count + 1)}>重新读取作业员</Button></div>
                : matches.length === 0 ? <p role="status">没有可选的作业员，请更换姓名或账号。</p>
                  : matches.map((user) => <Button unstyled className="workbench-creator-option" key={user.id}
                      type="button" aria-pressed={value?.id === user.id} onClick={() => choose(user)}>
                    <span><strong>{user.displayName}</strong><small className="mono">{user.username}</small></span>
                    <small>{roleLabels[user.role] || '未知角色'}{user.status === 'DISABLED' ? ' · 已停用' : ''}</small>
                  </Button>)}
          </div>
        </DialogContent>
      </Dialog>
      {value && <Button unstyled className="button small" type="button" disabled={disabled}
        aria-label={`清除${label}`} onClick={() => onChange(null)}>清除</Button>}
    </div>
  </div>;
}
