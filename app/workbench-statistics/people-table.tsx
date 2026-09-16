'use client';

import { SearchInput } from '@/components/ui/search-input';
import { Button } from '@/components/ui/button';

import Link from 'next/link';
import { useState } from 'react';
import type { Person, PersonQuality } from './types';
import { number, percent, ROLE_LABELS } from './shared';

type SortKey = 'receivedInPeriod' | 'completedInPeriod' | 'completionRate' | 'passRate' | 'total' | 'pending' | 'anomalies' | 'stale';
const completionRate = (person: Person) => {
  const valid = person.total - person.cancelled;
  return valid > 0 ? person.completed / valid : 0;
};
const qualityKey = (person: Pick<Person, 'accountId' | 'username'>) => `${person.accountId ?? 'historical'}:${person.username ?? 'unassigned'}`;
const sortValue = (person: Person, key: SortKey, quality: Map<string, PersonQuality>) => key === 'completionRate'
  ? completionRate(person) : key === 'passRate' ? quality.get(qualityKey(person))?.passRate ?? -1 : person[key];

const columns: { key: SortKey; label: string; value: (person: Person, quality?: PersonQuality) => string }[] = [
  { key: 'receivedInPeriod', label: '期间分配', value: person => number(person.receivedInPeriod) },
  { key: 'completedInPeriod', label: '期间完成', value: person => number(person.completedInPeriod) },
  { key: 'completionRate', label: '累计完成率', value: person => percent(completionRate(person)) },
  { key: 'passRate', label: '首评通过率', value: (_person, quality) => percent(quality?.passRate) },
  { key: 'pending', label: '当前待处理', value: person => number(person.pending) },
  { key: 'anomalies', label: '当前异常', value: person => number(person.anomalies) },
  { key: 'stale', label: '超 24 小时', value: person => number(person.stale) },
  { key: 'total', label: '累计负责', value: person => number(person.total) },
];

export function PeopleTable({ people, quality = [] }: { people: Person[]; quality?: PersonQuality[] }) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; ascending: boolean }>({ key: 'completedInPeriod', ascending: false });
  const keyword = search.trim().toLocaleLowerCase('zh-CN');
  const peopleQuality = new Map(quality.map(person => [qualityKey(person), person]));
  const owners = people.filter(person => person.username !== null);
  const rows = owners.filter(person => `${person.displayName} ${person.username}`.toLocaleLowerCase('zh-CN').includes(keyword))
    .toSorted((a, b) => (sortValue(a, sort.key, peopleQuality) - sortValue(b, sort.key, peopleQuality)) * (sort.ascending ? 1 : -1));
  return <section className="panel job-stats-section job-stats-people">
    <div className="job-stats-heading"><div><span className="job-stats-kicker">OWNER DETAILS</span><h2>负责人作业明细</h2>
      <p className="job-stats-note">{owners.length} 位负责人 · 尚未分配的作业不计入人员表，已删除账号单列为历史账号</p></div>
      <SearchInput aria-label="搜索表内人员" placeholder="搜索姓名或账号" value={search} onValueChange={setSearch} />
    </div>
    <div className="job-stats-table-scroll" tabIndex={0} role="region" aria-label="负责人作业明细，可横向滚动">
      <table className="job-stats-table"><thead><tr><th scope="col">负责人</th>
        {columns.map(column => <th key={column.key} scope="col" aria-sort={sort.key === column.key ? sort.ascending ? 'ascending' : 'descending' : 'none'}>
          <Button unstyled type="button" onClick={() => setSort({ key: column.key, ascending: sort.key === column.key && !sort.ascending })}>
            {column.label}{sort.key === column.key ? sort.ascending ? ' ↑' : ' ↓' : ''}
          </Button></th>)}<th scope="col">操作</th></tr></thead><tbody>
        {rows.map(person => <tr key={`${person.accountId ?? 'historical'}:${person.username ?? 'unassigned'}`}>
          <th scope="row"><strong>{person.displayName}</strong><small>{person.username ?? '尚未分配'} · {ROLE_LABELS[person.role ?? ''] ?? '无当前角色'}
            {person.legacyFallback > 0 ? ` · 含 ${person.legacyFallback} 项历史自建作业` : ''}</small></th>
          {columns.map(column => {
            const personQuality = peopleQuality.get(qualityKey(person));
            return <td key={column.key} title={column.key === 'passRate' && personQuality
              ? `${personQuality.qualified} / ${personQuality.samples} 项首评通过` : undefined}>{column.value(person, personQuality)}</td>;
          })}
          <td>{person.accountId !== null && person.username ? <Link className="job-stats-link" href={`/workbench/all?assignedToUserId=${encodeURIComponent(person.username)}&assignedToAccountId=${person.accountId}`}>查看当前分配</Link> : '—'}</td>
        </tr>)}
        {!rows.length && <tr><td colSpan={columns.length + 2} className="job-stats-empty">{keyword ? '没有匹配的负责人' : '暂无负责人作业记录'}</td></tr>}
      </tbody></table>
    </div>
  </section>;
}
