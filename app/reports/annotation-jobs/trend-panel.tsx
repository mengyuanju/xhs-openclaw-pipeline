'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
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
type Metric = 'totalJobs' | 'copyReview' | 'copyFirstPassRate' | 'imageFirstReview';

const Chart = dynamic(() => import('./trend-chart'), { ssr: false,
  loading: () => <div className={styles.trendChartLoading}>图表加载中…</div> });
const DEFAULT_LINES = 8;
const MAX_LINES = 10;
const PALETTE = ['#327e9b', '#b96b49', '#6b63a3', '#528c61', '#af792d',
  '#b65a80', '#368c87', '#886a42', '#4b73ad', '#7a8d39'];
const METRICS: { key: Metric; label: string; note: string; rate?: boolean }[] = [
  { key: 'totalJobs', label: '总作业', note: '每日有效提交或本人废弃操作' },
  { key: 'copyReview', label: '首次文案审核', note: '每日个人接手轮次的首次文案操作' },
  { key: 'copyFirstPassRate', label: '文案一次通过率', note: '首次操作日归属；结论追踪至报表时点', rate: true },
  { key: 'imageFirstReview', label: '首次图片审核', note: '每日个人接手轮次的首次图片操作' },
];

export function AnnotationTrendPanel({ trend, people, busy }: {
  trend: AnnotationJobTrend | null; people: TrendPerson[]; busy: boolean;
}) {
  const [chosen, setChosen] = useState<number[] | null>(null);
  const [search, setSearch] = useState('');
  const workers = useMemo(() => people.filter(person => person.totalJobs > 0)
    .toSorted((a, b) => b.totalJobs - a.totalJobs || a.accountId - b.accountId), [people]);
  const defaultIds = useMemo(() => workers.slice(0, DEFAULT_LINES).map(person => person.accountId), [workers]);
  const available = useMemo(() => new Set(workers.map(person => person.accountId)), [workers]);
  const selectedIds = useMemo(() => (chosen ?? defaultIds).filter(id => available.has(id)),
    [chosen, defaultIds, available]);
  const selected = useMemo(() => {
    const ids = new Set(selectedIds);
    return workers.filter(person => ids.has(person.accountId));
  }, [workers, selectedIds]);
  const listed = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('zh-CN');
    return workers.filter(person => `${person.displayName} ${person.username} ${person.accountId}`
      .toLocaleLowerCase('zh-CN').includes(term)).slice(0, 40);
  }, [workers, search]);
  const rows = useMemo(() => new Map((trend?.rows ?? []).map(row => [`${row.accountId}:${row.date}`, row])), [trend]);
  const charts = useMemo(() => METRICS.map(metric => ({ ...metric, lines: selected.map((person, index): TrendLine => {
    const points = (trend?.dates ?? []).map(date => rows.get(`${person.accountId}:${date}`));
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
  }) })), [rows, selected, trend]);

  function toggle(accountId: number, checked: boolean) {
    setChosen(current => {
      const active = (current ?? defaultIds).filter(id => available.has(id));
      if (checked) return active.includes(accountId) || active.length >= MAX_LINES ? active : [...active, accountId];
      return active.length <= 1 ? active : active.filter(id => id !== accountId);
    });
  }

  return <section className={`panel ${styles.trends}`} aria-label="标注作业图形统计">
    <div className={styles.trendHead}><div><h2>图形统计</h2><p>横轴为北京时间日期，每条折线代表一位标注人；沿用上方筛选条件。</p></div>
      {workers.length > 0 && <span className={styles.trendCount}>显示 {selected.length} / {workers.length} 位标注人</span>}</div>
    {busy && !trend ? <div className={styles.trendEmpty} role="status">正在汇总每日趋势…</div>
      : !trend || !workers.length ? <div className={styles.trendEmpty}>所选日期暂无标注作业趋势</div>
        : <>
          {workers.length > 1 && <details className={styles.personPicker}><summary>选择折线人员</summary>
            <div className={styles.personPickerBody}>
              <div className={styles.personPickerTop}><label>查找标注人<input type="search" value={search}
                onChange={event => setSearch(event.target.value)} placeholder="姓名、账号或编号" /></label>
                <button type="button" onClick={() => setChosen(null)}>恢复默认</button></div>
              <p>默认显示作业量前 {Math.min(DEFAULT_LINES, workers.length)} 位，最多同时显示 {MAX_LINES} 条折线。</p>
              <div className={styles.personOptions} role="group" aria-label="图表中的标注人">
                {listed.map(person => <label key={person.accountId}><input type="checkbox"
                  checked={selectedIds.includes(person.accountId)}
                  disabled={!selectedIds.includes(person.accountId) && selectedIds.length >= MAX_LINES}
                  onChange={event => toggle(person.accountId, event.target.checked)} />
                  <span>{person.displayName}<small>@{person.username} · #{person.accountId}</small></span></label>)}
                {!listed.length && <span className={styles.personNoMatch}>没有匹配的标注人</span>}
              </div>
              {workers.length > 40 && <small>列表最多显示 40 位；可输入姓名、账号或编号查找其他标注人。</small>}
            </div>
          </details>}
          <div className={styles.trendGrid}>
            {charts.map(metric => <article className={styles.trendCard} key={metric.key}>
              <div className={styles.trendCardHead}><h3>{metric.label}</h3><span>{metric.rate ? '单位：%' : '单位：次'}</span></div>
              <p>{metric.note}</p>
              {metric.rate && metric.lines.every(line => line.values.every(value => value == null))
                ? <div className={styles.trendChartLoading}>所选人员本期暂无有效首检结论</div>
                : <Chart label={`${metric.label}每日趋势，${selected.map(person => person.displayName).join('、')}`}
                    dates={trend.dates} lines={metric.lines} rate={metric.rate} />}
            </article>)}
          </div>
          <p className={styles.trendMethod}>次数缺日记 0；一次通过率在无有效首检结论的日期显示“—”。
            每日通过率按当日首检通过轮次除以当日已判定轮次计算，不能将每日百分比直接平均为区间通过率。</p>
        </>}
  </section>;
}
