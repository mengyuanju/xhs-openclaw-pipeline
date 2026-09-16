'use client';

import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Disclosure, DisclosureTrigger, DisclosureContent } from '@/components/ui/disclosure';

import Link from 'next/link';
import { AlertTriangle, CircleCheckBig, Clock3, Inbox, ListPlus, UserRoundX, UsersRound } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useStatistics } from './use-statistics';
import { Chart, number, percent, ROLE_LABELS, STATE_LABELS, StatisticsStatus } from './shared';
import { EfficiencyPanel } from './efficiency-panel';
import type { Period, StateGroup, Worker } from './types';

function SummaryItem({ label, value, note, icon, tone = 'neutral' }: {
  label: string; value: string; note: string; icon: ReactNode;
  tone?: 'neutral' | 'good' | 'warning' | 'risk';
}) {
  return <div className={`job-stats-summary-item is-${tone}`}>
    <div className="job-stats-summary-item-icon" aria-hidden="true">{icon}</div>
    <div><span>{label}</span><strong>{value}</strong><small>{note}</small></div>
  </div>;
}

const signed = (value: number | undefined) => value == null ? '—' : `${value > 0 ? '+' : ''}${number(value)}`;

export function AdminStatistics() {
  const [period, setPeriod] = useState<Period>('today');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [dateError, setDateError] = useState('');
  const [worker, setWorker] = useState<Worker | null>(null);
  const [role, setRole] = useState('');
  const username = worker ? worker.username ?? '__unassigned__' : '';
  const statistics = useStatistics({ scope: 'admin', period, ...(period === 'custom' ? custom : {}),
    username, ...(worker?.accountId ? { workerAccountId: worker.accountId } : {}), role, details: true });
  const { data, workers } = statistics;
  const summary = data?.summary;
  const people = summary?.people ?? [];
  const leaders = people.filter(person => person.username !== null
    && (person.completedInPeriod > 0 || person.receivedInPeriod > 0 || person.pending > 0))
    .toSorted((a, b) => b.completedInPeriod + b.receivedInPeriod + b.pending
      - a.completedInPeriod - a.receivedInPeriod - a.pending).slice(0, 6);
  const activeWorkers = people.filter(person => person.username !== null
    && (person.completedInPeriod > 0 || person.receivedInPeriod > 0)).length;
  const validTotal = summary ? summary.total - summary.cancelled : 0;
  const completionRate = validTotal > 0 && summary ? summary.completed / validTotal : null;
  const throughputRate = summary?.createdInPeriod ? summary.completedInPeriod / summary.createdInPeriod : null;
  const throughputValue = summary && summary.createdInPeriod === 0 && summary.completedInPeriod > 0
    ? '仅完成历史作业' : percent(throughputRate);
  const pendingChange = summary ? summary.createdInPeriod - summary.completedInPeriod : undefined;
  const anomalyRate = summary?.pending ? summary.anomalies / summary.pending : null;
  const unassigned = people.find(person => person.username === null);

  function applyDates(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const from = String(fields.get('from')), to = String(fields.get('to'));
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
    if (!Number.isFinite(days) || days < 1 || days > 366) { setDateError('请选择 1–366 天的有效日期范围'); return; }
    setCustom({ from, to }); setPeriod('custom'); setDateError('');
  }

  return <div className="job-stats-page job-stats-page-compact">
    <header className="job-stats-hero job-stats-hero-compact">
      <div><span className="job-stats-kicker">WORK OVERVIEW</span><h1>作业数据看板</h1>
        <p>作业进度、负责人情况和质量效率集中展示；人员数据按实际负责人归属。</p></div>
      <StatisticsStatus {...statistics} />
    </header>

    <section className="panel job-stats-filters job-stats-filters-compact" aria-label="统计筛选">
      <div className="job-stats-filter-toolbar">
        <div className="job-stats-segments" aria-label="统计日期">
          {(['today', '7d', '30d'] as const).map((value, i) => <Button unstyled type="button" key={value} aria-pressed={period === value}
            onClick={() => { setPeriod(value); setDateError(''); }}>{['今日', '近 7 天', '近 30 天'][i]}</Button>)}
        </div>
        <form onSubmit={applyDates} className="job-stats-date-form"><DatePicker name="from" label="自定义开始" required defaultValue={custom.from} />
          <DatePicker name="to" label="结束" required defaultValue={custom.to} /><Button unstyled className="button small" type="submit">应用日期</Button></form>
        <label>负责人角色<Select value={role || '__all__'} onValueChange={(nextValue) => { setRole(nextValue === '__all__' ? '' : nextValue); setWorker(null); }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__all__">全部角色</SelectItem>
          {Object.entries(ROLE_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></label>
        <label>实际负责人<Select value={worker ? String(worker.accountId ?? '__unassigned__') : '__all__'} onValueChange={(nextValue) => setWorker(nextValue === '__all__' ? null
          : workers?.find(person => String(person.accountId ?? '__unassigned__') === nextValue) ?? null)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__all__">全部负责人</SelectItem>
          {workers?.filter(person => !role || person.role === role).map(person => <SelectItem key={`${person.accountId ?? 'unassigned'}:${person.username ?? ''}`} value={String(person.accountId ?? '__unassigned__')}>{person.displayName}{person.username ? `（${person.username}）` : ''}</SelectItem>)}
        </SelectContent></Select></label>
        <span className="job-stats-toolbar-range">{data ? `${data.range.from} 至 ${data.range.to}` : '正在读取…'}</span>
      </div>
      {dateError && <p className="job-stats-warning" role="alert">{dateError}</p>}
    </section>

    <section className="panel job-stats-command-center" aria-labelledby="work-overview-title">
      <div className="job-stats-command-heading"><div><span className="job-stats-kicker">TEAM SNAPSHOT</span>
        <h2 id="work-overview-title">团队作业总览</h2><p>同屏查看本期结果、当前待办、负责人分布和质量效率。</p></div>
        <Link className="job-stats-link" href="/workbench/all?attention=STALE">查看待跟进作业</Link></div>

      <div className="job-stats-summary-strip">
        <SummaryItem label="期间已完成" value={number(summary?.completedInPeriod)} note={`累计完成率 ${percent(completionRate)}`}
          icon={<CircleCheckBig size={20} strokeWidth={2.3} />} tone="good" />
        <SummaryItem label="期间新增" value={number(summary?.createdInPeriod)} note={`完成 / 新增 ${throughputValue}`}
          icon={<ListPlus size={20} strokeWidth={2.3} />} />
        <SummaryItem label="当前待处理" value={number(summary?.pending)} note={`新增减完成 ${signed(pendingChange)}`}
          icon={<Inbox size={20} strokeWidth={2.3} />} tone={pendingChange != null && pendingChange > 0 ? 'warning' : 'neutral'} />
        <SummaryItem label="参与负责人" value={number(summary ? activeWorkers : null)} note="本期有分配或完成记录"
          icon={<UsersRound size={20} strokeWidth={2.3} />} />
        <SummaryItem label="当前异常" value={number(summary?.anomalies)} note={`${percent(anomalyRate)} 的待处理作业`}
          icon={<AlertTriangle size={20} strokeWidth={2.3} />} tone={summary?.anomalies ? 'risk' : 'neutral'} />
        <SummaryItem label="超过 24 小时" value={number(summary?.staleCount)} note="建议优先确认阻塞"
          icon={<Clock3 size={20} strokeWidth={2.3} />} tone={summary?.staleCount ? 'warning' : 'neutral'} />
        <SummaryItem label="尚未分配" value={number(unassigned?.pending ?? 0)} note="需要明确负责人"
          icon={<UserRoundX size={20} strokeWidth={2.3} />} tone={unassigned?.pending ? 'warning' : 'neutral'} />
      </div>

      {!!summary?.missingDates && <p className="job-stats-warning">{summary.missingDates} 项日期不完整，未纳入对应日期指标。</p>}

      <div className="job-stats-command-grid">
        <article className="job-stats-command-card job-stats-team-card">
          <div className="job-stats-chart-heading"><div><h3>负责人作业</h3><p>本期流转与当前待处理分轴显示，避免量级互相挤压。</p></div><span>作业量前 6 位</span></div>
          {leaders.length ? <Chart label="负责人期间完成、期间分配和当前待处理数量" variant="team" horizontal
            labels={leaders.map(person => person.displayName)} series={[
              { name: '期间完成', values: leaders.map(person => person.completedInPeriod) },
              { name: '期间分配', values: leaders.map(person => person.receivedInPeriod) },
              { name: '当前待处理', values: leaders.map(person => person.pending) },
            ]} /> : <p className="job-stats-empty">当前范围暂无负责人作业记录</p>}
        </article>

        <article className="job-stats-command-card job-stats-state-card">
          <div className="job-stats-chart-heading"><div><h3>当前作业状态</h3><p>当前负责人筛选范围内的作业</p></div><span>{number(summary?.total)} 项</span></div>
          {summary ? <Chart label="当前负责人筛选范围内的作业状态分布" variant="donut" labels={Object.values(STATE_LABELS)}
            series={[{ name: '作业数', values: (Object.keys(STATE_LABELS) as StateGroup[]).map(key => summary.states[key]) }]} />
            : <div className="job-stats-chart job-stats-loading">正在汇总作业状态…</div>}
        </article>

        <EfficiencyPanel data={data?.details ?? null} compact />
      </div>
    </section>

    <Disclosure className="panel job-stats-section job-stats-methods job-stats-compact-methods"><DisclosureTrigger>统计口径与更新说明</DisclosureTrigger><DisclosureContent>
      <p>一条 Query 为一项作业，按任务 ID 去重，重试不新增作业。团队新增量按任务创建时间；人员分配量按当前任务的分配时间；完成量按当前有效审核时间，重新生图后可能变化。</p>
      <p>人员归属优先采用当前负责人。为兼容旧流程，未分配且由普通作业员自建的历史任务归属原创建者{summary?.legacyOwnerFallback ? `（当前共 ${summary.legacyOwnerFallback} 项）` : ''}；其余未分配任务只计入“尚未分配负责人”，不作为负责人或角色展示。改派后历史作业随当前负责人重新归属。</p>
      <p>质量效率明细按需增量读取并缓存；人工首评达标指高于 2 分，无评分作业不进入分母。数量和明细均为近实时参考。</p>
    </DisclosureContent></Disclosure>
  </div>;
}
