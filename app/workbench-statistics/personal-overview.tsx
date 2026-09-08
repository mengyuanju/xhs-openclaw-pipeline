'use client';

import { Button } from '@/components/ui/button';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useStatistics } from './use-statistics';
import { Chart, Metric, number, STATE_LABELS, StatisticsStatus } from './shared';
import type { StateGroup } from './types';

export function PersonalOverview({ filter, onFilter }: { filter: string; onFilter: (filter: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [period, setPeriod] = useState<'7d' | '30d'>('7d');
  const statistics = useStatistics({ scope: 'personal', period });
  const summary = statistics.data?.summary;
  return <section className="panel job-stats-personal" aria-label="我的作业概览">
    <div className="job-stats-heading"><h2>我的作业概览</h2><StatisticsStatus {...statistics} /></div>
    <div className="job-stats-metrics">
      <Metric label="今日新建" value={number(summary?.todayCreated)} />
      <Metric label="当前负责" value={number(summary?.total)} note="包含已废弃作业" />
      <Metric label="今日审核完成" value={number(summary?.todayCompleted)} />
      <Metric label="累计已完成" value={number(summary?.completed)} note="当前审核通过的作业" />
    </div>
    <div className="job-stats-chips" aria-label="按当前状态筛选个人作业">
      <Button unstyled type="button" aria-pressed={filter === 'ALL'} onClick={() => onFilter('ALL')}>全部状态</Button>
      {(Object.keys(STATE_LABELS) as StateGroup[]).map(key => <Button unstyled key={key} type="button" aria-pressed={filter === key}
        disabled={!summary} onClick={() => onFilter(filter === key ? 'ALL' : key)}>{STATE_LABELS[key]} <b>{number(summary?.states[key])}</b></Button>)}
      {!!summary?.anomalies && <span className="job-stats-warning">待处理异常 {summary.anomalies} 项（含生图失败回审）</span>}
    </div>
    <Button unstyled className="job-stats-expand" type="button" aria-expanded={expanded} aria-controls="personal-statistics-trend"
      onClick={() => setExpanded(value => !value)}><ChevronDown size={14} aria-hidden="true" />{expanded ? '收起趋势' : '展开作业趋势'}</Button>
    {expanded && <div id="personal-statistics-trend">
      <div className="job-stats-heading"><h3>新建与审核完成趋势</h3><div className="job-stats-segments">
        {(['7d', '30d'] as const).map(value => <Button unstyled key={value} type="button" aria-pressed={period === value}
          onClick={() => setPeriod(value)}>近 {value === '7d' ? 7 : 30} 天</Button>)}
      </div></div>
      {summary && <div className="job-stats-two-columns"><Chart label="每日新增与当前有效审核完成的个人作业数量" labels={summary.trend.map(day => day.date.slice(5))}
        series={[{ name: '新建作业', values: summary.trend.map(day => day.created) }, { name: '审核完成', values: summary.trend.map(day => day.completed) }]} />
        <Chart label="我的全部历史作业当前状态分布" bar horizontal labels={Object.values(STATE_LABELS)}
          series={[{ name: '当前作业数', values: (Object.keys(STATE_LABELS) as StateGroup[]).map(key => summary.states[key]) }]} /></div>}
      <p className="job-stats-note">按北京时间统计，独立于列表搜索和页码。新建按任务创建时间统计；审核完成按当前有效审核时间统计，重新生图后可能变化。{summary?.missingDates ? `有 ${summary.missingDates} 项日期不完整，未纳入对应日期统计。` : ''}</p>
    </div>}
  </section>;
}
