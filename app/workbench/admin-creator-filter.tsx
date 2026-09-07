'use client';

import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/ui/search-input';

import { UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { apiRequest } from '../components/api-client';
import { loadJobCreators } from '../../src/control-plane/job-creators.mjs';

export type { JobCreator } from '../../src/control-plane/job-creators.mjs';
import type { JobCreator } from '../../src/control-plane/job-creators.mjs';

export function AdminCreatorFilter({ value, roleLabels, onChange }: {
  value: JobCreator | null;
  roleLabels: Record<string, string>;
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
  const matches = users.filter((user) => !keyword
    || user.username.toLocaleLowerCase('zh-CN').includes(keyword)
    || user.displayName.toLocaleLowerCase('zh-CN').includes(keyword));

  function choose(user: JobCreator | null) {
    onChange(user);
    setOpen(false);
  }

  return <div className="workbench-creator-filter">
    <label htmlFor="workbench-creator">作业员（创建者）</label>
    <div className="workbench-creator-control">
      <Dialog open={open} onOpenChange={(nextOpen) => { setOpen(nextOpen); if (nextOpen) setSearch(''); }}>
        <DialogTrigger asChild>
          <Button unstyled className="select-trigger" id="workbench-creator" type="button" title={value ? `${value.displayName}（${value.username}）` : '全部作业员'}>
            <span>{value ? `${value.displayName}（${value.username}）` : '全部作业员'}</span><UserRound size={16} aria-hidden="true" />
          </Button>
        </DialogTrigger>
        <DialogContent className="workbench-creator-dialog">
          <div className="workbench-creator-heading">
            <DialogTitle>选择作业员</DialogTitle>
            <DialogDescription>按姓名或账号搜索，选定后查看该账号创建的作业，可继续叠加角色、状态和 Query 筛选。</DialogDescription>
          </div>
          <div className="workbench-creator-search">
            <SearchInput aria-label="搜索作业员姓名或账号" placeholder="输入姓名或账号" value={search} maxLength={100} onValueChange={(value) => setSearch(value)} />
          </div>
          <div className="workbench-creator-results" aria-busy={loading}>
            <Button unstyled className="workbench-creator-option" type="button" aria-pressed={!value} onClick={() => choose(null)}>全部作业员</Button>
            {loading ? <p role="status">正在读取作业员…</p>
              : error ? <div role="alert"><p>读取失败：{error}</p><Button unstyled className="button small" type="button" onClick={() => setAttempt((count) => count + 1)}>重新读取作业员</Button></div>
                : matches.length === 0 ? <p role="status">没有匹配的作业员，请更换姓名或账号。</p>
                  : matches.map((user) => <Button unstyled className="workbench-creator-option" key={user.username} type="button" aria-pressed={value?.username === user.username} onClick={() => choose(user)}>
                    <span><strong>{user.displayName}</strong><small className="mono">{user.username}</small></span>
                    <small>{roleLabels[user.role] || '未知角色'}{user.status === 'DISABLED' ? ' · 已停用' : ''}</small>
                  </Button>)}
          </div>
        </DialogContent>
      </Dialog>
      {value && <Button unstyled className="button small" type="button" aria-label="清除作业员筛选" onClick={() => onChange(null)}>清除</Button>}
    </div>
  </div>;
}
