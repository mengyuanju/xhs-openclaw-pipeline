'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Image, PackageCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiRequest } from '../../components/api-client';
import { subscribeWorkspaceUpdates } from '../../components/workspace-updates';
import { chinaDay } from '../../../src/web-statistics/summary.mjs';
import type { ActivitySelection } from './personal-activity-dialog';
import styles from './personal-statistics-dashboard.module.css';

type Overview = {
  section: 'overview'; updatedAt: string; timezone: string; range: { from: string; to: string };
  delivery: { ready: number; href: string | null }; passed: { COPY: number; IMAGE: number };
};
type RefreshReason = 'initial' | 'manual' | 'change' | 'poll' | 'visible';
type Request = { controller: AbortController; queued: boolean };

const count = (value: number | undefined) => value == null ? '—' : value.toLocaleString('zh-CN');
const validCount = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;

export function PersonalTodayOverview({ today, onTodayChange, refreshKey, canDeliver, onSelect }: {
  today: string; onTodayChange: (day: string) => void; refreshKey: number; canDeliver: boolean;
  onSelect: (selection: ActivitySelection) => void;
}) {
  const [report, setReport] = useState<Overview | null>(null);
  const [checkedAt, setCheckedAt] = useState('');
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<{ day: string; message: string } | null>(null);
  const cached = useRef<Overview | null>(null);
  const fetchedAt = useRef(0);
  const dirty = useRef(false);
  const active = useRef<Request | null>(null);
  const latest = useRef<(reason: RefreshReason) => Promise<void>>(async () => {});
  const manualKey = useRef(refreshKey);

  const refresh = useCallback(async (reason: RefreshReason) => {
    if (reason === 'change') dirty.current = true;
    if (document.visibilityState !== 'visible') return;
    const currentDay = chinaDay(Date.now());
    if (currentDay !== today) { onTodayChange(currentDay); return; }
    const hasCached = cached.current?.range.from === today && cached.current?.range.to === today;
    const maxAge = reason === 'poll' ? 30_000 : 15_000;
    if (['initial', 'visible', 'poll'].includes(reason) && hasCached && !dirty.current
      && Date.now() - fetchedAt.current < maxAge) return;
    if (active.current) {
      if (reason === 'change') active.current.queued = true;
      return;
    }
    const request: Request = { controller: new AbortController(), queued: false };
    active.current = request;
    setLoading(!hasCached);
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        request.queued = false;
        dirty.current = false;
        const controller = new AbortController();
        request.controller = controller;
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 25_000);
        try {
          const data = await apiRequest<Overview>('/api/control-plane/v1/personal-workspace/statistics?section=overview', {
            signal: controller.signal, cache: 'no-store',
          });
          if (active.current !== request) return;
          const responseDay = chinaDay(Date.now());
          if (responseDay !== today) { onTodayChange(responseDay); return; }
          if (data?.section !== 'overview' || !data.range || !Number.isFinite(Date.parse(data.updatedAt))
            || !validCount(data.delivery?.ready) || !validCount(data.passed?.COPY) || !validCount(data.passed?.IMAGE)
            || data.delivery.href != null && (typeof data.delivery.href !== 'string' || !data.delivery.href.startsWith('/delivery-pool?'))) {
            throw new Error('今日概览数据格式不完整');
          }
          if (data.range.from !== today || data.range.to !== today) throw new Error('今日概览时间范围不匹配，请刷新后重试');
          if (JSON.stringify({ ...cached.current, updatedAt: undefined }) !== JSON.stringify({ ...data, updatedAt: undefined })) setReport(data);
          cached.current = data;
          fetchedAt.current = Date.now();
          setCheckedAt(data.updatedAt);
          setFailure(null);
        } catch (caught) {
          if (active.current !== request) return;
          dirty.current = true;
          setFailure({ day: today, message: timedOut ? '今日概览读取超时，请重试'
            : caught instanceof Error ? caught.message : '今日概览读取失败' });
        } finally { clearTimeout(timeout); }
        if (!request.queued || document.visibilityState !== 'visible') break;
      }
    } finally {
      if (active.current === request) { active.current = null; setLoading(false); }
    }
  }, [today, onTodayChange]);

  useEffect(() => { latest.current = refresh; }, [refresh]);
  useEffect(() => subscribeWorkspaceUpdates(() => void latest.current('change'), {scopes:['tasks','quality','statistics','delivery']}), []);
  useEffect(() => {
    void refresh('initial');
    const visible = () => { if (document.visibilityState === 'visible') void refresh('visible'); };
    const timer = setInterval(() => void refresh('poll'), 30_000);
    document.addEventListener('visibilitychange', visible);
    return () => {
      if (active.current) { active.current.controller.abort(); active.current = null; dirty.current = true; }
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);
  useEffect(() => {
    if (manualKey.current !== refreshKey) { manualKey.current = refreshKey; void latest.current('manual'); }
  }, [refreshKey]);

  const data = report?.range.from === today && report.range.to === today ? report : null;
  const error = failure?.day === today ? failure.message : '';
  const passed = (stage: 'COPY' | 'IMAGE', label: string) => onSelect({
    label, metric: 'annotationOverall', stage, sampleSet: 'passed', range: { from: today, to: today }, isToday: true,
  });
  const delivery = <><span className={styles.overviewCardHeading}><span>今日可交付</span><PackageCheck size={20} aria-hidden="true" /></span>
    <strong>{count(data?.delivery.ready)}<small>条</small></strong><small>截至当前的交付池待交付数量</small>
    <span className={styles.overviewSource}>含待打包和已打包待交付</span></>;

  return <section className={styles.overview} aria-label="今日概览" aria-busy={loading && !data}>
    <div className={styles.overviewHeading}><div><h2>今日概览</h2><span className={styles.muted}>{today} · 北京时间 · 独立于下方日期筛选</span></div>
      {data && <span className={`${styles.muted} ${styles.checkedTime}`}>最近同步 {new Date(checkedAt || data.updatedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</span>}</div>
    {error && <div className="notice error" role="alert">{error}{data ? '。以下保留上次成功的数据，可能已过时。' : '。暂未取得今日概览。'} <Button variant="outline" size="sm" type="button" onClick={() => void refresh('manual')}>重试概览</Button></div>}
    <div className={styles.overviewGrid}>
      {data?.delivery.href && canDeliver
        ? <Link className={`${styles.overviewCard} ${styles.overviewDelivery}`} href={data.delivery.href}>{delivery}</Link>
        : <div className={`${styles.overviewCard} ${styles.overviewDelivery}`}>{delivery}</div>}
      <Button unstyled className={styles.overviewCard} type="button" disabled={!data} onClick={() => passed('COPY', '今日文案质检通过')}>
        <span className={styles.overviewCardHeading}><span>今日文案质检通过</span><CheckCircle2 size={20} aria-hidden="true" /></span>
        <strong>{count(data?.passed.COPY)}<small>次</small></strong><small>本人文案按今日质检通过判定计次</small>
        <span className={styles.overviewSource}>含返修后通过</span>
      </Button>
      <Button unstyled className={styles.overviewCard} type="button" disabled={!data} onClick={() => passed('IMAGE', '今日图片质检通过')}>
        <span className={styles.overviewCardHeading}><span>今日图片质检通过</span><Image size={20} aria-hidden="true" /></span>
        <strong>{count(data?.passed.IMAGE)}<small>次</small></strong><small>本人图片按今日质检通过判定计次</small>
        <span className={styles.overviewSource}>整套图片计一次判定 · 含返修后通过</span>
      </Button>
    </div>
  </section>;
}
