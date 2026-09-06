'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { Counts, Person } from './types';
import { number, ROLE_LABELS } from './shared';

const columns: { key: keyof Counts; label: string }[] = [
  { key: 'createdInPeriod', label: '期间新增' }, { key: 'completedInPeriod', label: '期间完成' },
  { key: 'total', label: '累计创建' }, { key: 'completed', label: '累计完成' },
  { key: 'pending', label: '当前待处理' }, { key: 'anomalies', label: '当前异常' }, { key: 'cancelled', label: '累计废弃' },
];
export function PeopleTable({ people }: { people: Person[] }) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: keyof Counts; ascending: boolean }>({ key: 'createdInPeriod', ascending: false });
  const keyword = search.trim().toLocaleLowerCase('zh-CN');
  const rows = people.filter(person => `${person.displayName} ${person.username ?? ''}`.toLocaleLowerCase('zh-CN').includes(keyword))
    .toSorted((a, b) => (a[sort.key] - b[sort.key]) * (sort.ascending ? 1 : -1));
  return <section className="panel job-stats-section">
    <div className="job-stats-heading"><div><h2>作业员明细</h2><p className="job-stats-note">{people.length} 位有历史作业的创建者 · 角色按当前账号信息</p></div>
      <input type="search" aria-label="搜索表内人员" placeholder="搜索姓名或账号" value={search} onChange={event => setSearch(event.target.value)} />
    </div>
    <div className="job-stats-table-scroll" tabIndex={0} role="region" aria-label="作业员明细，可横向滚动">
      <table className="job-stats-table"><thead><tr><th scope="col">作业员</th>
        {columns.map(column => <th key={column.key} scope="col" aria-sort={sort.key === column.key ? sort.ascending ? 'ascending' : 'descending' : 'none'}>
          <button type="button" onClick={() => setSort({ key: column.key, ascending: sort.key === column.key && !sort.ascending })}>
            {column.label}{sort.key === column.key ? sort.ascending ? ' ↑' : ' ↓' : ''}
          </button></th>)}<th scope="col">操作</th></tr></thead><tbody>
        {rows.map(person => <tr key={person.username ?? '__unassigned__'}>
          <th scope="row"><strong>{person.displayName}</strong><small>{person.username ?? '未记录账号'} · {ROLE_LABELS[person.role ?? ''] ?? '角色未知'}</small></th>
          {columns.map(column => <td key={column.key}>{number(person[column.key])}</td>)}
          <td>{person.username ? <Link className="job-stats-link" href={`/workbench/all?createdByUserId=${encodeURIComponent(person.username)}`}>查看作业</Link> : '—'}</td>
        </tr>)}
        {!rows.length && <tr><td colSpan={9} className="job-stats-empty">{keyword ? '没有匹配的作业员' : '暂无作业记录'}</td></tr>}
      </tbody></table>
    </div>
  </section>;
}
