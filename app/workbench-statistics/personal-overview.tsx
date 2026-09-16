'use client';

import { useState } from 'react';
import { BarChart3, ChevronDown, SlidersHorizontal } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

import {
  PERSONAL_DETAIL_FILTERS,
  PERSONAL_LEGACY_FILTERS,
  PERSONAL_PRIMARY_FILTERS,
  isPersonalAdvancedStateFilter,
  isPersonalPrimaryStateFilter,
  personalStateFilterCount,
} from '../workbench/personal-state-filters';
import type { PersonalTaskScope } from '../workbench/list-state';
import { Chart, Metric, number, STATE_LABELS, StatisticsStatus } from './shared';
import type { Statistics, StateGroup } from './types';

type PersonalStatistics = {
  data: Statistics | null;
  error: string;
  busy: boolean;
  cooldown: boolean;
  refresh: () => void;
};

type PersonalPeriod = '7d' | '30d';

const SCOPE_OPTIONS: ReadonlyArray<{ value: PersonalTaskScope; label: string }> = [
  { value: 'ALL', label: '全部相关' },
  { value: 'ASSIGNED', label: '我负责的' },
  { value: 'CREATED', label: '我创建的' },
];

export function PersonalWorkbenchNavigation({
  period,
  statistics,
  filter,
  scope,
  onPeriod,
  onFilter,
  onScope,
}: {
  period: PersonalPeriod;
  statistics: PersonalStatistics;
  filter: string;
  scope: PersonalTaskScope;
  onPeriod: (period: PersonalPeriod) => void;
  onFilter: (filter: string) => void;
  onScope: (scope: PersonalTaskScope) => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(isPersonalAdvancedStateFilter(filter));
  const [statisticsOpen, setStatisticsOpen] = useState(false);
  const summary = statistics.data?.summary;
  const primaryValue = isPersonalPrimaryStateFilter(filter) ? filter : 'advanced';
  const advancedValue = isPersonalAdvancedStateFilter(filter) ? filter : 'ANY';

  return <section className="panel personal-workbench-navigation" aria-label="个人作业快速导航">
    <header className="personal-workbench-navigation-header">
      <div>
        <span className="section-kicker">Personal workbench</span>
        <h2>从工作阶段快速找到作业</h2>
        <p>状态只影响列表查询，不改变作业本身；操作权限仍由当前账号和中心服务校验。</p>
      </div>
      <StatisticsStatus {...statistics} />
    </header>

    <Tabs className="personal-workbench-status-tabs" value={primaryValue}
      onValueChange={(value) => { onFilter(value); setAdvancedOpen(false); }}>
      <TabsList aria-label="按工作阶段筛选个人作业">
        {PERSONAL_PRIMARY_FILTERS.map((item) => {
          const count = personalStateFilterCount(item.value, summary);
          return <TabsTrigger key={item.value} value={item.value} title={item.description}>
            <span>{item.label}</span>
            {count === null
              ? <Skeleton className="personal-workbench-count-skeleton" aria-label="统计中" />
              : <Badge variant={primaryValue === item.value ? 'default' : 'secondary'}>{number(count)}</Badge>}
          </TabsTrigger>;
        })}
      </TabsList>
    </Tabs>

    <div className="personal-workbench-filter-row">
      <div className="personal-workbench-scope">
        <span>与我的关系</span>
        <Tabs value={scope} onValueChange={(value) => onScope(value as PersonalTaskScope)}>
          <TabsList aria-label="按我与作业的关系筛选">
            {SCOPE_OPTIONS.map((item) => <TabsTrigger key={item.value} value={item.value}>{item.label}</TabsTrigger>)}
          </TabsList>
        </Tabs>
      </div>

      <Collapsible className="personal-workbench-advanced" open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <Button unstyled className="button small" type="button" aria-label="展开高级状态筛选">
            <SlidersHorizontal size={14} aria-hidden="true" />高级状态
            {isPersonalAdvancedStateFilter(filter) && <Badge variant="outline">已启用</Badge>}
            <ChevronDown className={advancedOpen ? 'is-expanded' : ''} size={14} aria-hidden="true" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="personal-workbench-advanced-content">
          <label htmlFor="personal-workbench-exact-state">精确阶段</label>
          <Select value={advancedValue} onValueChange={(value) => onFilter(value === 'ANY' ? 'ALL' : value)}>
            <SelectTrigger id="personal-workbench-exact-state"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ANY">不限精确阶段</SelectItem>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>原始流转状态</SelectLabel>
                {PERSONAL_DETAIL_FILTERS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
              </SelectGroup>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>兼容已有链接</SelectLabel>
                {PERSONAL_LEGACY_FILTERS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
              </SelectGroup>
            </SelectContent>
          </Select>
        </CollapsibleContent>
      </Collapsible>
    </div>

    <p className="personal-workbench-count-note">阶段数量按“当前账号创建或负责的全部相关作业”统计；“与我的关系”只缩小下方列表范围。</p>

    <Separator />

    <Collapsible className="personal-workbench-statistics" open={statisticsOpen} onOpenChange={setStatisticsOpen}>
      <CollapsibleTrigger asChild>
        <Button unstyled className="personal-workbench-statistics-trigger" type="button">
          <BarChart3 size={15} aria-hidden="true" />查看数据概览与趋势
          {!!summary?.anomalies && <Badge variant="destructive">异常 {number(summary.anomalies)}</Badge>}
          <ChevronDown className={statisticsOpen ? 'is-expanded' : ''} size={15} aria-hidden="true" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="personal-workbench-statistics-content">
        <div className="job-stats-metrics">
          <Metric label="今日新建" value={number(summary?.todayCreated)} />
          <Metric label="提交或负责" value={number(summary?.total)} note="包含已废弃作业" />
          <Metric label="今日审核完成" value={number(summary?.todayCompleted)} />
          <Metric label="累计已完成" value={number(summary?.completed)} note="当前审核通过的作业" />
        </div>
        <div className="job-stats-heading personal-workbench-trend-heading">
          <h3>新建与审核完成趋势</h3>
          <div className="job-stats-segments">
            {(['7d', '30d'] as const).map((value) => <Button unstyled key={value} type="button"
              aria-pressed={period === value} onClick={() => onPeriod(value)}>近 {value === '7d' ? 7 : 30} 天</Button>)}
          </div>
        </div>
        {summary && <div className="job-stats-two-columns">
          <Chart label="每日新增与当前有效审核完成的个人作业数量" labels={summary.trend.map((day) => day.date.slice(5))}
            series={[{ name: '新建作业', values: summary.trend.map((day) => day.created) }, { name: '审核完成', values: summary.trend.map((day) => day.completed) }]} />
          <Chart label="我的全部历史作业当前状态分布" bar horizontal labels={Object.values(STATE_LABELS)}
            series={[{ name: '当前作业数', values: (Object.keys(STATE_LABELS) as StateGroup[]).map((key) => summary.states[key]) }]} />
        </div>}
        <p className="job-stats-note">按北京时间统计，独立于列表搜索和页码。新建按任务创建时间统计；审核完成按当前有效审核时间统计，重新生图后可能变化。{summary?.missingDates ? `有 ${summary.missingDates} 项日期不完整，未纳入对应日期统计。` : ''}</p>
      </CollapsibleContent>
    </Collapsible>
  </section>;
}
