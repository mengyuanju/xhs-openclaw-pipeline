'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { apiRequest } from '../../components/api-client';
import { subscribeWorkspaceUpdates } from '../../components/workspace-updates';
import { personalListHref } from '../../../src/personal-workspace.mjs';
import { chinaDay } from '../../../src/web-statistics/summary.mjs';
import { OperatorDeliveryHistory } from '../operator-delivery-history';
import type { PersonalTaskScope } from '../list-state';
import { PersonalActivityDialog, type ActivitySelection } from './personal-activity-dialog';
import styles from './personal-statistics-dashboard.module.css';

type Stage = 'COPY' | 'IMAGE';
type Tab = 'personal' | 'jobs';
type Quality = { firstPassed: number; passed: number; decided: number; firstPassRate: number | null; rate: number | null };
type Annotation = { firstSubmissions: number; reworkSubmissions: number; submissions: number; quality: Quality };
type Qa = {
  firstReviews: number; rechecks: number; passed: number; returned: number; reviews: number;
  actualOperations: number; processingCoverage: number; batchReturned: number; batchReleased: number;
  discarded: number; escalated: number; coverageIncomplete: boolean;
};
type PersonalReport = {
  section: 'personal'; updatedAt: string; timezone: string; range: { from: string; to: string };
  annotation: Record<Stage, Annotation> | null; qa: Record<Stage, Qa> | null; notices: string[];
};
type JobsReport = {
  section: 'jobs'; updatedAt: string; scope: PersonalTaskScope; counts: Record<string, number>;
  rework: { copy: number; image: number; both: number; edit: number; processing: number; confirm: number; longWaiting: number; longestHours: number };
  background: { plan: number; repair: number; previews: number; failed: number; imageRequests: number };
  missingDates: number;
};
type Report = PersonalReport | JobsReport;
type RefreshReason = 'initial' | 'manual' | 'change' | 'poll' | 'visible';
type RefreshRequest = { key: string; controller: AbortController; queued: boolean };

function sameStatistics(previous: Report | undefined, next: Report) {
  if (!previous) return false;
  return JSON.stringify({ ...previous, updatedAt: undefined }) === JSON.stringify({ ...next, updatedAt: undefined });
}

const STAGES: { value: Stage; label: string }[] = [{ value: 'COPY', label: '文案' }, { value: 'IMAGE', label: '图片' }];
const number = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString('zh-CN');
const percent = (value: number | null | undefined) => value == null ? '—' : `${(value * 100).toFixed(1)}%`;
const updatedAt = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

export function PersonalStatisticsDashboard({ canDeliver = false }: { canDeliver?: boolean }) {
  const [tab, setTab] = useState<Tab>('personal');
  const [scope, setScope] = useState<PersonalTaskScope>('ASSIGNED');
  const [reports, setReports] = useState<Record<string, Report>>({});
  const [checkedTimes, setCheckedTimes] = useState<Record<string, string>>({});
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [selection, setSelection] = useState<ActivitySelection | null>(null);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const active = useRef<RefreshRequest | null>(null);
  const cache = useRef<Record<string, Report>>({});
  const fetchedAt = useRef<Record<string, number>>({});
  const dirtyKeys = useRef(new Set<string>());
  const refreshLatest = useRef<(reason: RefreshReason) => Promise<void>>(async () => {});
  const queryKey = tab === 'personal' ? 'personal' : `jobs:${scope}`;
  const refreshInterval = tab === 'personal' ? 60_000 : 30_000;

  const refresh = useCallback(async (reason: RefreshReason = 'poll') => {
    if (reason === 'change') {
      for (const key of Object.keys(cache.current)) dirtyKeys.current.add(key);
      dirtyKeys.current.add(queryKey);
    }
    if (document.visibilityState !== 'visible') return;
    const cached = cache.current[queryKey];
    const hasCached = cached?.section === 'personal'
      ? cached.range.from === chinaDay(Date.now()) : cached?.section === 'jobs' && cached.scope === scope;
    const maxAge = reason === 'poll' ? refreshInterval : 15_000;
    if (['initial', 'visible', 'poll'].includes(reason) && hasCached && !dirtyKeys.current.has(queryKey)
      && Date.now() - (fetchedAt.current[queryKey] ?? 0) < maxAge) return;
    if (active.current?.key === queryKey) {
      if (reason === 'change') active.current.queued = true;
      if (reason === 'manual') setManualRefreshing(true);
      return;
    }
    const request: RefreshRequest = { key: queryKey, controller: new AbortController(), queued: false };
    active.current = request;
    const query = new URLSearchParams(tab === 'personal'
      ? { section: 'personal' } : { section: 'jobs', personalScope: scope });
    setLoadingKey(hasCached ? null : queryKey);
    setManualRefreshing(reason === 'manual');
    try {
      // Coalesce changes during a request into at most one immediate follow-up.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        request.queued = false;
        dirtyKeys.current.delete(queryKey);
        const controller = new AbortController();
        request.controller = controller;
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 25_000);
        try {
          const data = await apiRequest<Report>(`/api/control-plane/v1/personal-workspace/statistics?${query}`, {
            signal: controller.signal, cache: 'no-store',
          });
          if (active.current !== request) return;
          if (tab === 'personal') {
            if (data.section !== 'personal' || !data.range || !data.updatedAt) throw new Error('个人数据格式不完整');
          } else if (data.section !== 'jobs' || !data.counts || !data.updatedAt) throw new Error('作业数据格式不完整');
          if (!sameStatistics(cache.current[queryKey], data)) setReports(previous => ({ ...previous, [queryKey]: data }));
          cache.current[queryKey] = data;
          fetchedAt.current[queryKey] = Date.now();
          setCheckedTimes(previous => ({ ...previous, [queryKey]: data.updatedAt }));
          setErrors(previous => previous[queryKey] ? { ...previous, [queryKey]: '' } : previous);
        } catch (caught) {
          if (active.current !== request) return;
          dirtyKeys.current.add(queryKey);
          setErrors(previous => ({ ...previous, [queryKey]: timedOut ? '统计读取超时，请重试'
            : caught instanceof Error ? caught.message : '统计读取失败' }));
        } finally { clearTimeout(timeout); }
        if (!request.queued || document.visibilityState !== 'visible') break;
      }
    } finally {
      if (active.current === request) { active.current = null; setLoadingKey(null); setManualRefreshing(false); }
    }
  }, [queryKey, refreshInterval, tab, scope]);

  useEffect(() => { refreshLatest.current = refresh; }, [refresh]);
  useEffect(() => subscribeWorkspaceUpdates(() => void refreshLatest.current('change')), []);

  useEffect(() => {
    setLoadingKey(null);
    setManualRefreshing(false);
    void refresh('initial');
    const visible = () => { if (document.visibilityState === 'visible') void refresh('visible'); };
    const timer = setInterval(() => void refresh('poll'), refreshInterval);
    document.addEventListener('visibilitychange', visible);
    return () => {
      const pending = active.current;
      if (pending) { dirtyKeys.current.add(pending.key); pending.controller.abort(); active.current = null; }
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh, refreshInterval]);

  const today = chinaDay(Date.now());
  const personal = reports.personal;
  const jobs = reports[`jobs:${scope}`];
  const personalData = personal?.section === 'personal' && personal.range.from === today ? personal : null;
  const jobsData = jobs?.section === 'jobs' ? jobs : null;
  const currentData = tab === 'personal' ? personalData : jobsData;
  const loading = loadingKey === queryKey && !currentData;
  const error = errors[queryKey] ?? '';
  const selectMetric = (label: string, metric: ActivitySelection['metric'], stage: Stage, sampleSet?: ActivitySelection['sampleSet']) =>
    setSelection({ label, metric, stage, sampleSet });
  const activityMetric = (label: string, value: number | null | undefined, metric: ActivitySelection['metric'], stage: Stage, note: string, incomplete = false) =>
    <Button key={label} unstyled className={`${styles.metric}${metric === 'submitAll' ? ` ${styles.totalMetric}` : ''}`} type="button" disabled={value == null}
      onClick={() => selectMetric(label, metric, stage)}><span>{label}</span><strong className={incomplete ? styles.confirmedValue : undefined}>{incomplete && value != null ? `已确认 ${number(value)}` : number(value)}</strong><small>{note}</small></Button>;
  const qaAuxiliaryMetric = (label: string, value: number | null | undefined, metric: ActivitySelection['metric'], stage: Stage) =>
    <Button key={label} unstyled className={styles.qaAuxiliaryMetric} type="button" disabled={value == null}
      onClick={() => selectMetric(label, metric, stage)}><span>{label}</span><strong>{number(value)}</strong><small>条次</small></Button>;
  const rate = (label: string, value: number | null | undefined, numerator: number | null | undefined, denominator: number | null | undefined) =>
    <div className={styles.rate} key={label}><span>{label}</span><strong>{percent(value)}</strong>
      <small>{denominator == null ? '数据暂不可用' : `${number(numerator)} / ${number(denominator)} 判定项次${denominator > 0 && denominator < 20 ? ' · 样本较少' : ''}`}</small></div>;
  const jobHref = (category: string, extras: Record<string, string> = {}) =>
    personalListHref({ personalScope: jobsData?.scope ?? scope, category, ...extras });
  const jobMetric = (label: string, value: number | null | undefined, category: string, note: string, extras: Record<string, string> = {}) =>
    jobsData ? <Link className={styles.metric} key={label} href={jobHref(category, extras)}><span>{label}</span><strong>{number(value)}</strong><small>{note}</small></Link>
      : <div className={styles.metric} key={label}><span>{label}</span><strong>—</strong><small>{note}</small></div>;

  return <div className={styles.dashboard}>
    <header className={styles.heading}><div><h1>个人数据统计</h1><p className={styles.muted} role={loading ? 'status' : undefined}>{loading ? `正在读取${tab === 'personal' ? '个人数据' : '作业数据'}…` : '今日工作次数与当前作业状态'}</p></div>
      <div className={styles.actions}><Link className="button" href="/workbench/personal">我的作业</Link>
        <Button unstyled className={`button ${styles.refreshButton}`} type="button" disabled={loading || manualRefreshing} onClick={() => void refresh('manual')}><RefreshCw size={15} className={loading || manualRefreshing ? 'animate-spin' : ''} />刷新</Button></div></header>
    <Tabs className={styles.tabs} value={tab} onValueChange={value => { setSelection(null); setTab(value as Tab); }}>
      <TabsList className={styles.tabList} aria-label="统计类型">
        <TabsTrigger className={styles.tab} value="personal">个人数据</TabsTrigger>
        <TabsTrigger className={styles.tab} value="jobs">作业数据</TabsTrigger>
      </TabsList>
      {error && <div className="notice error" role="alert">{error}{currentData ? '。以下保留上次成功的数据，可能已过时。' : '。暂未取得统计数据，请重试。'}</div>}
      <TabsContent className={styles.content} value="personal" aria-busy={loading && tab === 'personal'}>
        <section className={`panel ${styles.section}`}>
          <div className={styles.sectionHeader}><div><h2>今日标注与图片初审</h2>
            <p className={styles.muted}>{personalData?.range.from ?? today} · 北京时间 · 按本人有效提交时间计次</p></div>
            {personalData && <span className={`${styles.muted} ${styles.checkedTime}`}>最近同步 {updatedAt(checkedTimes.personal ?? personalData.updatedAt)}</span>}</div>
          {personalData?.notices?.map(notice => <div className="notice warning" role="status" key={notice}>{notice}</div>)}
          <div className={styles.stageGrid}>{STAGES.map(({ value: stage, label }) => {
            const annotation = personalData?.annotation?.[stage];
            return <article className={styles.stage} key={stage}>
              <h3>{stage === 'IMAGE' ? '图片标注／初审' : `${label}标注`}</h3>
              <p className={`${styles.muted} ${styles.stageNote}`}>{stage === 'IMAGE' ? '每次负责人图片初审提交计一次；标注与初审共用同一提交记录。' : '全部提交包含首次、返修和普通再次提交，按有效操作逐次计数。'}</p>
              <div className={styles.metricGrid}>
                {activityMetric(`${label}今日全部提交`, annotation?.submissions, 'submitAll', stage, '次 · 含首次、返修及再次提交')}
                {activityMetric(stage === 'COPY' ? '文案首次提交' : '图片首次初审提交', annotation?.firstSubmissions, 'submitFirst', stage, '次 · 今日提交')}
                {activityMetric(stage === 'COPY' ? '文案返修提交' : '图片返修初审提交', annotation?.reworkSubmissions, 'submitRework', stage, '次 · 今日提交')}
              </div>
              <div className={styles.rateGrid}>
                {rate('一次通过率', annotation?.quality?.firstPassRate, annotation?.quality?.firstPassed, annotation?.quality?.decided)}
                {rate('整体通过率', annotation?.quality?.rate, annotation?.quality?.passed, annotation?.quality?.decided)}
              </div>
            </article>;
          })}</div>
          <p className={styles.muted}>通过率按今天给出的有效质检结论归实际标注人：一次通过为首次通过判定／全部通过或退回判定；整体通过包含返修后通过。今天提交但尚未质检的作业不进入今日分母。</p>
        </section>
        <section className={`panel ${styles.section}`}><div className={styles.sectionHeader}><div><h2>今日质检操作</h2>
          <p className={styles.muted}>按北京时间今天的质检处理时间统计。负责人图片初审已计入上方图片提交；这里展示独立质检的人工操作与处理覆盖。</p></div></div>
          <div className={styles.stageGrid}>{STAGES.map(({ value: stage, label }) => {
            const qa = personalData?.qa?.[stage];
            return <article className={styles.stage} key={stage}><h3>{label}质检</h3>
              <div className={styles.qaPrimaryGrid}>
                {activityMetric('今日实际逐条操作量', qa?.actualOperations, 'qaActual', stage, '条次 · 人工逐条通过、退回、废弃或升级')}
                {activityMetric('今日处理覆盖量（含批量）', qa?.processingCoverage, 'qaCoverage', stage,
                  qa?.coverageIncomplete ? '条次 · 已确认范围，历史记录不完整' : '条次 · 含批量退回与自动放行，重叠项去重', qa?.coverageIncomplete)}
              </div>
              {qa?.coverageIncomplete && <p className={styles.coverageNotice} role="status">历史覆盖记录不完整；以上为已确认条次，部分批量影响范围无法恢复。</p>}
              <div className={styles.qaGrid}>
                {activityMetric('首轮质检', qa?.firstReviews, 'qaFirst', stage, '条次 · 人工逐条处理')}
                {activityMetric('复检', qa?.rechecks, 'qaRecheck', stage, '条次 · 人工逐条处理')}
                {activityMetric('通过', qa?.passed, 'qaPassed', stage, '条次 · 人工质检结论')}
                {activityMetric('退回', qa?.returned, 'qaReturned', stage, '条次 · 人工质检结论')}
              </div>
              <div className={styles.qaAuxiliaryGrid}>
                {qaAuxiliaryMetric('批量退回影响', qa?.batchReturned, 'qaBatchReturned', stage)}
                {qaAuxiliaryMetric('自动放行覆盖', qa?.batchReleased, 'qaBatchReleased', stage)}
                {qaAuxiliaryMetric('逐条废弃', qa?.discarded, 'qaDiscarded', stage)}
                {qaAuxiliaryMetric('升级处理', qa?.escalated, 'qaEscalated', stage)}
              </div>
              <p className={styles.muted}>{stage === 'IMAGE' ? '图片按一个任务当前版本的整套图片计一条；' : '文案按一个质检项或版本计一条；'}新版本复检另计。处理覆盖包含自动放行和系统联动，不代表人工逐条检查量。</p>
            </article>;
          })}</div>
          <p className={styles.muted}>同一质检项或版本在今日覆盖明细中只显示一条；逐条和批量覆盖可以重叠，辅助数量不能相加。多人参与同一内容时各自保留处理记录，个人覆盖量不可直接相加作为系统总量。</p>
        </section>
      </TabsContent>
      <TabsContent className={styles.content} value="jobs" aria-busy={loading && tab === 'jobs'}>
        <section className={`panel ${styles.section}`}><div className={styles.sectionHeader}><div><h2>当前作业状态</h2>
          <p className={styles.muted}>按当前作业 ID 去重，不受“今天”限制；状态卡存在包含关系，不能相加。</p></div>
          <label className={styles.scope}>作业关系<Select value={scope} onValueChange={value => setScope(value as PersonalTaskScope)}>
            <SelectTrigger aria-label="作业关系"><SelectValue /></SelectTrigger><SelectContent>
              <SelectItem value="ASSIGNED">我负责的</SelectItem><SelectItem value="CREATED">我创建的</SelectItem><SelectItem value="ALL">与我相关</SelectItem>
            </SelectContent></Select></label></div>
          {jobsData && <span className={`${styles.muted} ${styles.checkedTime}`}>最近同步 {updatedAt(checkedTimes[`jobs:${scope}`] ?? jobsData.updatedAt)}{jobsData.missingDates ? ` · ${jobsData.missingDates} 项缺少等待起始时间` : ''}</span>}
          <div className={styles.statusPrimary}>{jobMetric('待我处理', jobsData?.counts.actionable, 'actionable', '当前由我负责且需要人工操作的作业')}</div>
          <div className={styles.statusGrid}>
            {jobMetric('待文案初审', jobsData?.counts.copyInitial, 'copyInitial', '项作业')}
            {jobMetric('待图片初审', jobsData?.counts.imageInitial, 'imageInitial', '项作业')}
            {jobMetric('返修作业', jobsData?.counts.rework, 'rework', '项 · 含修改、后台处理与结果确认')}
            {jobMetric('执行异常', jobsData?.counts.anomaly, 'anomaly', '项作业')}
            {jobMetric('生产中', jobsData?.counts.production, 'production', '项 · 排队或运行')}
            {jobMetric('我的内容等待质检', jobsData?.counts.qa, 'qa', `项 · 其中复检 ${number(jobsData?.counts.recheck)}`)}
            {jobMetric('可交付', jobsData?.counts.ready, 'ready', '项 · 当前版本尚未打包')}
          </div>
          <h3 className={styles.subheading}>返修细分</h3>
          {jobsData && <div className={styles.rework}>
            <Link className="button small" href={jobHref('rework', { reworkType: 'COPY' })}>仅文案 {number(jobsData.rework.copy)}</Link>
            <Link className="button small" href={jobHref('rework', { reworkType: 'IMAGE' })}>仅图片 {number(jobsData.rework.image)}</Link>
            <Link className="button small" href={jobHref('rework', { reworkType: 'BOTH' })}>文案和图片 {number(jobsData.rework.both)}</Link>
            <Link className="button small" href={jobHref('rework', { reworkProgress: 'EDIT' })}>待修改 {number(jobsData.rework.edit)}</Link>
            <Link className="button small" href={jobHref('rework', { reworkProgress: 'PROCESSING' })}>后台处理中 {number(jobsData.rework.processing)}</Link>
            <Link className="button small" href={jobHref('rework', { reworkProgress: 'CONFIRM' })}>待确认 {number(jobsData.rework.confirm)}</Link>
            <Link className="button small" href={jobHref('rework', { longWaiting: '1' })}>超过 24 小时 {number(jobsData.rework.longWaiting)}</Link>
          </div>}
          {canDeliver && <div className={styles.actions}><Button variant="outline" type="button" onClick={() => setDeliveryOpen(true)}>我的交付记录</Button></div>}
        </section>
      </TabsContent>
    </Tabs>
    {selection && <PersonalActivityDialog selection={selection} onClose={() => setSelection(null)} />}
    {canDeliver && <Dialog open={deliveryOpen} onOpenChange={setDeliveryOpen}><DialogContent className={styles.deliveryDialog}>
      <DialogTitle>我的交付记录</DialogTitle><DialogDescription>查看下载记录并确认交付。</DialogDescription>
      {deliveryOpen && <OperatorDeliveryHistory refreshKey={0} initialStatus="DOWNLOADED" />}
    </DialogContent></Dialog>}
  </div>;
}
