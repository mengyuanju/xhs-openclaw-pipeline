'use client';

import { useMemo, useState } from 'react';
import { BarChart3, CalendarDays, ChevronDown, FileText, ImageIcon, Search, SlidersHorizontal } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
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
import type { CompletedWork, PersonalStatisticsRange, Statistics, StateGroup } from './types';

type PersonalStatistics = {
  data: Statistics | null;
  error: string;
  busy: boolean;
  cooldown: boolean;
  refresh: () => void;
};

const SCOPE_OPTIONS: ReadonlyArray<{ value: PersonalTaskScope; label: string }> = [
  { value: 'ALL', label: '全部相关' },
  { value: 'ASSIGNED', label: '我负责的' },
  { value: 'CREATED', label: '我创建的' },
];

const DAY = 86_400_000;
const COMPLETION_STATE_LABELS: Record<string, string> = {
  COPY_QUEUED: '待文案生成',
  COPY_RUNNING: '文案生成中',
  COPY_REVIEW_PENDING: '待文案审核',
  COPY_QC_PENDING: '待文案质检',
  COPY_FAILED: '文案执行失败',
  IMAGE_QUEUED: '待生图',
  IMAGE_RUNNING: '生图中',
  IMAGE_FAILED: '图片执行失败',
  MANUAL_ARCHIVE: '待人工归档',
  IMAGE_QC_PENDING: '待图片质检',
  IMAGE_REWORK_PENDING: '图片质检打回',
  REVIEWED: '完整交付',
  CANCELLED: '已废弃',
};
const COMPLETION_STATE_ORDER = Object.keys(COMPLETION_STATE_LABELS);

function shanghaiDay(milliseconds = Date.now()) {
  return new Date(milliseconds + 8 * 3_600_000).toISOString().slice(0, 10);
}

function completionRangeLabel(range: { from: string; to: string }) {
  if (range.from === range.to) return range.from;
  return `${range.from} 至 ${range.to}`;
}

function completedAtLabel(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function PersonalCompletionOverview({
  completedWork,
  dataRange,
  range,
  busy,
  onRange,
  onTaskSelect,
}: {
  completedWork?: CompletedWork;
  dataRange?: { from: string; to: string };
  range: PersonalStatisticsRange;
  busy: boolean;
  onRange: (range: PersonalStatisticsRange) => void;
  onTaskSelect?: (taskId: number) => void;
}) {
  const [state, setState] = useState('ALL');
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);
  const today = shanghaiDay();
  const yesterday = shanghaiDay(Date.now() - DAY);
  const resolvedRange = dataRange ?? { from: range.from ?? today, to: range.to ?? range.from ?? today };
  const availableStates = useMemo(() => {
    const present = Object.keys(completedWork?.states ?? {});
    const base = COMPLETION_STATE_ORDER.filter((value) => present.includes(value));
    const extra = present.filter((value) => !COMPLETION_STATE_ORDER.includes(value)).sort();
    return [...base, ...extra];
  }, [completedWork]);
  const matchingTasks = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('zh-CN');
    return (completedWork?.tasks ?? []).filter((task) => (state === 'ALL' || task.state === state)
      && (!needle || String(task.id).includes(needle) || task.query.toLocaleLowerCase('zh-CN').includes(needle)));
  }, [completedWork, search, state]);
  const visibleTasks = showAll ? matchingTasks : matchingTasks.slice(0, 8);
  const singleDayValue = resolvedRange.from === resolvedRange.to ? resolvedRange.from : '';
  const rangeName = range.period === 'today' ? '今天'
    : range.period === '7d' ? '近 7 天'
      : resolvedRange.from === yesterday && resolvedRange.to === yesterday ? '昨天'
        : completionRangeLabel(resolvedRange);

  return <section className="personal-completion" aria-labelledby="personal-completion-title">
    <div className="personal-completion-heading">
      <div>
        <span className="section-kicker">Completion data</span>
        <h3 id="personal-completion-title">完成数据</h3>
        <p>统计你在所选日期完成过文案或图片的任务，并展示这些任务现在所在的状态。</p>
      </div>
      <div className="personal-completion-date-controls" aria-label="选择完成日期">
        <div className="job-stats-segments">
          <Button unstyled type="button" aria-pressed={range.period === 'today'}
            onClick={() => onRange({ period: 'today' })}>今天</Button>
          <Button unstyled type="button"
            aria-pressed={range.period === 'custom' && range.from === yesterday && range.to === yesterday}
            onClick={() => onRange({ period: 'custom', from: yesterday, to: yesterday })}>昨天</Button>
          <Button unstyled type="button" aria-pressed={range.period === '7d'}
            onClick={() => onRange({ period: '7d' })}>近 7 天</Button>
        </div>
        <label className="personal-completion-date">
          <CalendarDays size={14} aria-hidden="true" />
          <span className="sr-only">选择日期</span>
          <Input type="date" max={today} value={singleDayValue}
            onChange={(event) => event.target.value
              && onRange({ period: 'custom', from: event.target.value, to: event.target.value })} />
        </label>
      </div>
    </div>

    <div className="personal-completion-summary" aria-busy={!completedWork && busy}>
      <div className="personal-completion-primary-card">
        <span>{rangeName}完成任务</span>
        {completedWork ? <strong>{number(completedWork.total)}</strong> : <Skeleton className="personal-completion-value-skeleton" />}
        <small>同一任务只计一次 · {completionRangeLabel(resolvedRange)}</small>
      </div>
      <div className="personal-completion-action-card">
        <div><FileText size={16} aria-hidden="true" /><span>文案完成</span><strong>{number(completedWork?.copy)}</strong></div>
        <div><ImageIcon size={16} aria-hidden="true" /><span>图片完成</span><strong>{number(completedWork?.image)}</strong></div>
        <small>阶段任务合计 {number(completedWork ? completedWork.copy + completedWork.image : null)} 项
          {!!completedWork?.overlap && `；其中 ${number(completedWork.overlap)} 个任务同时完成文案和图片`}</small>
      </div>
    </div>

    <div className="personal-completion-section-heading">
      <div><h4>完成任务当前在哪</h4><p>这里是当前状态，不是完成当天的状态。</p></div>
      {state !== 'ALL' && <Button unstyled className="button small" type="button" onClick={() => setState('ALL')}>查看全部状态</Button>}
    </div>
    <div className="personal-completion-states">
      {(availableStates.length ? availableStates : ['COPY_QC_PENDING', 'IMAGE_QUEUED', 'IMAGE_RUNNING', 'IMAGE_QC_PENDING', 'IMAGE_REWORK_PENDING', 'REVIEWED'])
        .map((value) => <Button unstyled type="button" key={value}
          className="personal-completion-state-card" aria-pressed={state === value}
          onClick={() => { setState((current) => current === value ? 'ALL' : value); setShowAll(false); }}>
          <span>{COMPLETION_STATE_LABELS[value] ?? value}</span>
          <strong>{number(completedWork?.states[value] ?? (completedWork ? 0 : null))}</strong>
        </Button>)}
    </div>

    <div className="personal-completion-section-heading personal-completion-list-heading">
      <div><h4>对应任务</h4><p>{state === 'ALL' ? '全部当前状态' : COMPLETION_STATE_LABELS[state] ?? state} · {number(matchingTasks.length)} 项</p></div>
      <label className="personal-completion-search">
        <Search size={14} aria-hidden="true" />
        <span className="sr-only">搜索完成任务</span>
        <Input value={search} onChange={(event) => { setSearch(event.target.value); setShowAll(false); }} placeholder="任务 ID / Query" />
      </label>
    </div>
    <div className="personal-completion-task-list">
      {visibleTasks.map((task) => <Button unstyled type="button" key={task.id}
        className="personal-completion-task" onClick={() => onTaskSelect?.(task.id)} disabled={!onTaskSelect}>
        <span className="personal-completion-task-id">#{task.id}</span>
        <span className="personal-completion-task-query" title={task.query}>{task.query || '未命名任务'}</span>
        <span className="personal-completion-task-work">
          {task.stages.includes('COPY') && <Badge variant="outline">文案</Badge>}
          {task.stages.includes('IMAGE') && <Badge variant="outline">图片</Badge>}
        </span>
        <span className="personal-completion-task-state">{COMPLETION_STATE_LABELS[task.state] ?? task.state}</span>
        <time dateTime={task.latestCompletedAt}>{completedAtLabel(task.latestCompletedAt)}</time>
      </Button>)}
      {completedWork && matchingTasks.length === 0 && <p className="personal-completion-empty">这个日期和筛选条件下没有完成记录。</p>}
      {!completedWork && <div className="personal-completion-loading"><Skeleton /><Skeleton /><Skeleton /></div>}
    </div>
    {matchingTasks.length > 8 && <Button unstyled className="personal-completion-more" type="button"
      onClick={() => setShowAll((value) => !value)}>{showAll ? '收起任务' : `查看全部 ${number(matchingTasks.length)} 项`}</Button>}
  </section>;
}

export function PersonalWorkbenchNavigation({
  range,
  statistics,
  filter,
  scope,
  onRange,
  onFilter,
  onScope,
  onTaskSelect,
}: {
  range: PersonalStatisticsRange;
  statistics: PersonalStatistics;
  filter: string;
  scope: PersonalTaskScope;
  onRange: (range: PersonalStatisticsRange) => void;
  onFilter: (filter: string) => void;
  onScope: (scope: PersonalTaskScope) => void;
  onTaskSelect?: (taskId: number) => void;
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

    <PersonalCompletionOverview
      completedWork={summary?.completedWork}
      dataRange={statistics.data?.range}
      range={range}
      busy={statistics.busy}
      onRange={onRange}
      onTaskSelect={onTaskSelect}
    />

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
              aria-pressed={range.period === value} onClick={() => onRange({ period: value })}>近 {value === '7d' ? 7 : 30} 天</Button>)}
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
