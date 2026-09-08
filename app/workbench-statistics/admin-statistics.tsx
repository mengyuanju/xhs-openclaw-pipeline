'use client';

import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Disclosure, DisclosureTrigger, DisclosureContent } from '@/components/ui/disclosure';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useStatistics } from './use-statistics';
import { Chart, Metric, number, ROLE_LABELS, STATE_LABELS, StatisticsStatus } from './shared';
import { PeopleTable } from './people-table';
import { EfficiencyPanel } from './efficiency-panel';
import type { Creator, Period, StateGroup } from './types';

export function AdminStatistics() {
  const [period, setPeriod] = useState<Period>('today');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [dateError, setDateError] = useState('');
  const [creator, setCreator] = useState<Creator | null>(null);
  const [role, setRole] = useState('');
  const username = creator ? creator.username ?? '__unassigned__' : '';
  const statistics = useStatistics({ scope: 'admin', period, ...(period === 'custom' ? custom : {}),
    username, ...(creator?.accountId ? { createdByAccountId: creator.accountId } : {}), role, details: true });
  const { data, creators } = statistics;
  const summary = data?.summary;
  const leaders = summary?.people?.toSorted((a, b) => b.createdInPeriod - a.createdInPeriod).slice(0, 10) ?? [];
  function applyDates(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const from = String(fields.get('from')), to = String(fields.get('to'));
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
    if (!Number.isFinite(days) || days < 1 || days > 366) { setDateError('请选择 1–366 天的有效日期范围'); return; }
    setCustom({ from, to }); setPeriod('custom'); setDateError('');
  }
  return <div className="job-stats-page">
    <div className="job-stats-heading"><div><h1>作业统计</h1><p className="job-stats-note">查看团队产出、生成效率与当前待处理作业。</p></div><StatisticsStatus {...statistics} /></div>
    <section className="panel job-stats-filters" aria-label="统计筛选">
      <div className="job-stats-filter-row"><div className="job-stats-segments" aria-label="统计日期">
        {(['today', '7d', '30d'] as const).map((value, i) => <Button unstyled type="button" key={value} aria-pressed={period === value}
          onClick={() => { setPeriod(value); setDateError(''); }}>{['今日', '近 7 天', '近 30 天'][i]}</Button>)}
      </div>
        <form onSubmit={applyDates} className="job-stats-date-form"><DatePicker name="from" label="自定义开始" required defaultValue={custom.from} />
          <DatePicker name="to" label="结束" required defaultValue={custom.to} /><Button unstyled className="button small" type="submit">应用日期</Button></form>
      </div>
      <div className="job-stats-filter-row">
        <label>创建者角色<Select value={role || '__all__'} onValueChange={(nextValue) => { setRole((nextValue === '__all__' ? '' : nextValue)); setCreator(null); }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__all__">全部角色</SelectItem>
          {Object.entries(ROLE_LABELS).map(([value, label]) => <SelectItem key={value} value={String(value)}>{label}</SelectItem>)}</SelectContent></Select></label>
        <label>作业员<Select value={creator ? String(creator.accountId ?? '__unassigned__') : '__all__'} onValueChange={(nextValue) => setCreator(nextValue === '__all__' ? null
          : creators?.find(person => String(person.accountId ?? '__unassigned__') === nextValue) ?? null)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__all__">全部作业员</SelectItem>
          {creators?.filter(person => !role || person.role === role).map(person => <SelectItem key={`${person.accountId ?? 'unassigned'}:${person.username ?? ''}`} value={String(person.accountId ?? '__unassigned__')}>{person.displayName}{person.username ? `（${person.username}）` : ''}</SelectItem>)}
        </SelectContent></Select></label>
        <span className="job-stats-note">{data ? `${data.range.from} 至 ${data.range.to} · 北京时间` : '正在读取所选范围…'}</span>
      </div>{dateError && <p className="job-stats-warning" role="alert">{dateError}</p>}
    </section>
    <section className="panel job-stats-section" aria-label="作业数量概览">
      <div className="job-stats-metrics">
        <Metric label="期间新增作业" value={number(summary?.createdInPeriod)} note={`累计创建 ${number(summary?.total)} 项，含已废弃`} />
        <Metric label="期间审核完成" value={number(summary?.completedInPeriod)} note={`累计有效完成 ${number(summary?.completed)} 项`} />
        <Metric label="当前待处理" value={number(summary?.pending)} note="所有未完成且未废弃作业" />
        <Metric label="当前异常待处理" value={number(summary?.anomalies)} note="执行失败或生图失败回审" />
      </div>
      <p className="job-stats-note">日期只筛选期间指标；当前状态和累计数量覆盖所选人员的全部历史作业。审核完成依当前有效审核时间，重新生图可能改变历史曲线。</p>
      {!!summary?.missingDates && <p className="job-stats-warning">{summary.missingDates} 项任务缺少有效日期，未纳入对应日期指标。</p>}
    </section>
    {summary && <div className="job-stats-two-columns">
      <section className="panel job-stats-section"><h2>每日产出</h2><Chart label="每日新增及当前有效审核完成作业数量" labels={summary.trend.map(day => day.date.slice(5))}
        series={[{ name: '新增作业', values: summary.trend.map(day => day.created) }, { name: '审核完成', values: summary.trend.map(day => day.completed) }]} /></section>
      <section className="panel job-stats-section"><h2>当前状态分布</h2><Chart label="所选人员全部历史作业的当前状态分布" bar horizontal
        labels={Object.values(STATE_LABELS)} series={[{ name: '作业数', values: (Object.keys(STATE_LABELS) as StateGroup[]).map(key => summary.states[key]) }]} />
        <p className="job-stats-note">{(Object.keys(STATE_LABELS) as StateGroup[]).map(key => `${STATE_LABELS[key]} ${summary.states[key]}`).join(' · ')}</p></section>
    </div>}
    <EfficiencyPanel data={data?.details ?? null} />
    {summary && <>
      <PeopleTable people={summary.people ?? []} />
      <div className="job-stats-two-columns"><section className="panel job-stats-section"><h2>作业员期间提交量</h2>
        <p className="job-stats-note">展示前 10 位，完整数据见上表。</p>
        {leaders.length ? <Chart label="期间新增作业数量前十位创建者" bar horizontal labels={leaders.map(person => person.displayName)}
          series={[{ name: '期间新增', values: leaders.map(person => person.createdInPeriod) }]} /> : <p className="job-stats-empty">暂无作业记录</p>}
      </section><section className="panel job-stats-section"><h2>长期未更新</h2><p className="job-stats-note">当前待处理且超过 24 小时未更新 · 共 {summary.staleCount} 项，展示最久的 20 项。</p>
        <ul className="job-stats-stale">{summary.stale?.map(task => <li key={task.id}><Link href={`/workbench/all?taskId=${task.id}`}><strong>#{task.id}</strong> {task.query}</Link><span>{task.hours} 小时 · {task.username ?? '历史无归属'}</span></li>)}</ul>
        {!summary.staleCount && <p className="job-stats-empty">暂无长期未更新作业</p>}
      </section></div>
    </>}
    <Disclosure className="panel job-stats-section job-stats-methods"><DisclosureTrigger>统计口径与更新说明</DisclosureTrigger><DisclosureContent>
      <p>一条 Query 为一项作业，按任务 ID 去重；重试不新增作业。已废弃作业保留在累计创建中。人员表仅列出有历史作业的创建者，无归属任务独立统计。</p>
      <p>有效图片数只计算期间有效审核完成任务的当前图片资产。失败执行占比为失败 /（成功 + 失败）；多次执行任务占比基于期间有已结束执行的作业。</p>
      <p>页面打开时按需更新，后台标签页暂停轮询。数量通常缓存 60 秒，变化的明细增量读取；数据量大时显示进度，保留上次完整结果。当前分页接口不提供固定快照，统计为近实时参考。</p>
    </DisclosureContent></Disclosure>
  </div>;
}
