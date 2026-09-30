'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { BarChart3, CalendarDays, CheckCircle2, Eye, EyeOff, FileText, Image as ImageIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { TrendLine } from './trend-chart';
import styles from './report.module.css';

export type AnnotationJobTrendRow = {
  date: string;
  accountId: number;
  totalJobs: number;
  copyReview: number;
  imageFirstReview: number;
  copyFirstPassed: number;
  copyDecided: number;
  copyFirstPassRate: number | null;
};

export type AnnotationJobTrend = { dates: string[]; rows: AnnotationJobTrendRow[] };
type TrendPerson = { accountId: number; username: string; displayName: string; totalJobs: number };
type MetricKey = 'totalJobs' | 'copyReview' | 'copyFirstPassRate' | 'imageFirstReview';
type Metric = { key: MetricKey; label: string; note: string; tone: string; icon: LucideIcon; rate?: boolean };
type Totals = { totalJobs: number; copyReview: number; imageFirstReview: number;
  copyFirstPassed: number; copyDecided: number };

const Chart = dynamic(() => import('./trend-chart'), { ssr: false,
  loading: () => <div className={styles.trendChartLoading}>图表加载中…</div> });
const DEFAULT_VISIBLE_LINES = 8;
const PALETTE = ['#327e9b', '#b96b49', '#6b63a3', '#528c61', '#af792d',
  '#b65a80', '#368c87', '#886a42', '#4b73ad', '#7a8d39', '#986683', '#40818a'];
const METRICS: Metric[] = [
  { key: 'totalJobs', label: '总作业', note: '有效提交与本人废弃操作', tone: 'blue', icon: BarChart3 },
  { key: 'copyReview', label: '首次文案审核', note: '个人接手轮次的首次文案操作', tone: 'orange', icon: FileText },
  { key: 'copyFirstPassRate', label: '文案一次通过率', note: '按首次操作日归属首检结论', tone: 'green', icon: CheckCircle2, rate: true },
  { key: 'imageFirstReview', label: '首次图片审核', note: '个人接手轮次的首次图片操作', tone: 'purple', icon: ImageIcon },
];

function TrendLoading() {
  return <div className={styles.trendCard} role="status" aria-label="正在汇总每日趋势">
    <div className={styles.trendSkeletonHead}><Skeleton className={styles.trendSkeletonIcon} />
      <Skeleton className={styles.trendSkeletonTitle} /><Skeleton className={styles.trendSkeletonValue} /></div>
    <Skeleton className={styles.trendSkeletonChart} />
  </div>;
}

export function AnnotationTrendPanel({ trend, people, busy }: {
  trend: AnnotationJobTrend | null; people: TrendPerson[]; busy: boolean;
}) {
  const [activeKey, setActiveKey] = useState<MetricKey>('totalJobs');
  const [dateView, setDateView] = useState<'worked' | 'calendar'>('worked');
  const [showValues, setShowValues] = useState(true);
  const [visibleCount, setVisibleCount] = useState<number | null>(null);
  const metric = METRICS.find(item => item.key === activeKey) ?? METRICS[0];
  const workers = useMemo(() => people.filter(person => person.totalJobs > 0)
    .toSorted((a, b) => b.totalJobs - a.totalJobs || a.accountId - b.accountId), [people]);
  const rows = useMemo(() => new Map((trend?.rows ?? []).map(row => [`${row.accountId}:${row.date}`, row])), [trend]);
  const workedDates = useMemo(() => {
    const dates = new Set((trend?.rows ?? []).filter(row => row.totalJobs > 0).map(row => row.date));
    return (trend?.dates ?? []).filter(date => dates.has(date));
  }, [trend]);
  const chartDates = dateView === 'worked' ? workedDates : trend?.dates ?? [];
  const foldedDays = (trend?.dates.length ?? 0) - workedDates.length;
  const totals = useMemo(() => {
    const value: Totals = { totalJobs: 0, copyReview: 0, imageFirstReview: 0, copyFirstPassed: 0, copyDecided: 0 };
    for (const row of trend?.rows ?? []) {
      value.totalJobs += row.totalJobs;
      value.copyReview += row.copyReview;
      value.imageFirstReview += row.imageFirstReview;
      value.copyFirstPassed += row.copyFirstPassed;
      value.copyDecided += row.copyDecided;
    }
    return value;
  }, [trend]);
  const lines = useMemo(() => workers.map((person, index): TrendLine => {
    const points = chartDates.map(date => rows.get(`${person.accountId}:${date}`));
    return {
      name: `${person.displayName} · #${person.accountId}`,
      color: PALETTE[index % PALETTE.length],
      values: points.map(point => metric.rate
        ? point?.copyFirstPassRate == null ? null : point.copyFirstPassRate * 100
        : point?.[metric.key] ?? 0),
      ...(metric.rate ? {
        passed: points.map(point => point?.copyFirstPassed ?? 0),
        decided: points.map(point => point?.copyDecided ?? 0),
      } : {}),
    };
  }), [workers, chartDates, rows, metric]);
  const value = metric.key === 'copyFirstPassRate'
    ? totals.copyDecided ? `${(totals.copyFirstPassed / totals.copyDecided * 100).toFixed(2)}%` : '—'
    : `${totals[metric.key].toLocaleString('zh-CN')} 次`;
  const dateLabel = trend?.dates.length ? `${trend.dates[0]} 至 ${trend.dates.at(-1)}` : '按北京时间统计';
  const Icon = metric.icon;

  return <section className={`panel ${styles.trends}`} aria-label="标注作业图形统计">
    <header className={styles.trendHead}>
      <div className={styles.trendTitle}><span className={styles.trendTitleIcon}><BarChart3 size={21} aria-hidden="true" /></span>
        <div><span className={styles.trendEyebrow}>趋势分析</span><h2>图形统计</h2>
          <p><CalendarDays size={13} aria-hidden="true" />{dateLabel} · 点击图例切换人员，支持全选与反选</p></div>
      </div>
      {workers.length > 0 && <Badge variant="secondary" className={styles.trendCount}>
        {workers.length} 位有作业的标注人</Badge>}
    </header>
    {busy && !trend ? <TrendLoading />
      : !trend || !workers.length ? <div className={styles.trendEmpty}><BarChart3 size={25} aria-hidden="true" />
          <strong>暂无趋势数据</strong><span>所选日期内没有标注作业。</span></div>
        : <Tabs value={activeKey} onValueChange={value => setActiveKey(value as MetricKey)} className={styles.trendTabs}>
          <TabsList className={styles.metricTabs} aria-label="图形统计分类">
            {METRICS.map(item => {
              const TabIcon = item.icon;
              return <TabsTrigger key={item.key} value={item.key} className={styles.metricTab} data-tone={item.tone}>
                <TabIcon size={16} aria-hidden="true" /><span>{item.label}</span>
              </TabsTrigger>;
            })}
          </TabsList>
          <TabsContent value={activeKey} forceMount className={styles.trendContent}>
            <div className={styles.trendViewBar}>
              <span>日期视角</span>
              <div className={styles.trendViewSwitch} role="group" aria-label="图表日期视角">
                <Button type="button" variant="ghost" size="sm" aria-pressed={dateView === 'worked'}
                  onClick={() => setDateView('worked')}>有作业日</Button>
                <Button type="button" variant="ghost" size="sm" aria-pressed={dateView === 'calendar'}
                  onClick={() => setDateView('calendar')}>自然日</Button>
              </div>
              <Button type="button" variant="outline" size="sm" className={styles.trendValueToggle}
                aria-pressed={showValues} onClick={() => setShowValues(current => !current)}>
                {showValues ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}
                显示数值
              </Button>
              <small>{dateView === 'worked'
                ? `显示 ${workedDates.length} 天，折叠 ${foldedDays} 天无作业日期`
                : `显示全部 ${trend.dates.length} 天，保留无作业日的零值`}</small>
            </div>
            <div className={styles.trendCard} data-tone={metric.tone}>
              <div className={styles.trendCardHead}>
                <span className={styles.metricIcon}><Icon size={19} aria-hidden="true" /></span>
                <div className={styles.metricName}><h3>{metric.label}</h3><p>{metric.note}</p>
                  <Badge variant="outline" className={styles.visibleCount}>
                    图中显示 {visibleCount ?? Math.min(DEFAULT_VISIBLE_LINES, workers.length)} / {workers.length} 人
                  </Badge></div>
                <div className={styles.metricSummary}><span>报表范围汇总</span>
                  <strong data-slot="metric-period-value">{value}</strong>
                  {metric.rate && <small>{totals.copyFirstPassed} / {totals.copyDecided} 已判定轮次</small>}
                </div>
              </div>
              <Chart label={`${metric.label}每日趋势`} dates={chartDates} lines={lines}
                rate={metric.rate} showValues={showValues} defaultVisibleCount={DEFAULT_VISIBLE_LINES}
                visibleCount={visibleCount ?? undefined} onVisibleChange={setVisibleCount} />
              {metric.rate && totals.copyDecided === 0 && <p className={styles.trendNoRate}>本期暂无有效首检结论，图例仍可查看人员。</p>}
            </div>
            <p className={styles.trendMethod}>“有作业日”仅折叠当前筛选范围无人作业的日期；“自然日”保留每天的真实次数。
              点位数值可开关；重叠标签会自动避让，悬浮可查看完整数值。
              图例包含当前筛选范围内的 {workers.length} 位标注人，
              默认显示作业量前 {Math.min(DEFAULT_VISIBLE_LINES, workers.length)} 位；点击姓名切换，或在图例中全选、反选。
              {metric.rate && ' 无首检判定的日期保持空值，折线仅连接前后有效点；本期通过率按通过轮次总和除以判定轮次总和计算。'}</p>
          </TabsContent>
        </Tabs>}
  </section>;
}
