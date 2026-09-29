'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { apiRequest } from '../../components/api-client';
import styles from './personal-statistics-dashboard.module.css';

export type ActivitySelection = {
  label: string;
  metric: 'submitAll' | 'submitFirst' | 'submitRework' | 'annotationOverall' | 'qaFirst' | 'qaRecheck' | 'qaPassed' | 'qaReturned'
    | 'copyFirstReview' | 'annotationDiscarded' | 'qaActual' | 'qaCoverage' | 'qaBatchReturned' | 'qaBatchReleased' | 'qaDiscarded' | 'qaEscalated';
  stage: 'COPY' | 'IMAGE';
  sampleSet?: 'all' | 'first' | 'passed' | 'failed';
  range: { from: string; to: string };
  isToday: boolean;
};

type Receipt = {
  id: string;
  code: string;
  stage: 'COPY' | 'IMAGE';
  kind: string;
  at: string;
  outcome?: string;
  submissionType?: string;
  firstPassed?: boolean;
  sampleKind?: string;
  coverageSources?: string[];
  manualKinds?: string[];
};
type Page = { total: number; page: number; pageSize: number; items: Receipt[]; coverageIncomplete?: boolean };

function receiptLabel(item: Receipt) {
  if (item.kind === 'COMPLETE' || item.kind === 'SUBMIT') return item.submissionType === 'REWORK' ? '返修提交' : item.submissionType === 'REPEAT' ? '再次提交' : '首次提交';
  if (item.outcome === 'PASS') return item.firstPassed ? '一次通过' : '通过';
  if (item.outcome === 'RETURN') return '退回';
  if (item.outcome === 'ESCALATE') return '升级处理';
  if (item.outcome === 'RELEASE') return '放行';
  if (item.outcome === 'DISCARD' || item.kind === 'QA_DISCARD' || item.kind === 'ANNOTATION_DISCARD') return '废弃';
  return '质检操作';
}

function coverageLabel(item: Receipt) {
  const sources = new Set(item.coverageSources);
  const labels = [sources.has('DIRECT') ? '逐条' : '', sources.has('BATCH_RETURN') ? '批量退回' : '',
    sources.has('BATCH_RELEASE') ? '自动放行' : ''].filter(Boolean);
  return labels.join('＋');
}

function activityDescription(selection: ActivitySelection) {
  const { from, to } = selection.range;
  const dates = `北京时间 ${from === to ? from : `${from} 至 ${to}`}`;
  if (selection.metric === 'copyFirstReview') return `${dates} · 首次文案审核 = 首次提交 + 废弃数，逐次列出本人首次提交和文案审核或返修中的废弃记录。`;
  if (selection.metric === 'annotationDiscarded') return `${dates} · 按本人文案审核或返修中的实际废弃时间计次。`;
  if (selection.metric === 'qaCoverage') return `${dates} · 每个质检项或版本只列一条，合并逐条、批量退回与自动放行覆盖。新版本复检另计，覆盖量包含系统联动。`;
  if (selection.metric === 'qaBatchReturned') return `${dates} · 列出本人整批退回影响的质检项或版本，包含已逐条操作的重叠项。`;
  if (selection.metric === 'qaBatchReleased') return `${dates} · 列出本人操作触发的自动放行覆盖，不代表本人逐条检查。`;
  if (selection.metric === 'qaActual') return `${dates} · 按本人逐条通过、退回、废弃或升级的质检项或版本计次，不包含批量影响。新版本复检另计。`;
  return `${dates} · 按本人实际提交或质检记录逐次列出。同一作业可能有多次记录。`;
}

export function PersonalActivityDialog({ selection, onClose }: {
  selection: ActivitySelection;
  onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 25_000);
    const query = new URLSearchParams({
      period: 'custom', from: selection.range.from, to: selection.range.to, metric: selection.metric, stage: selection.stage,
      sampleSet: selection.sampleSet ?? 'all', page: String(page), pageSize: '15',
    });
    setData(null);
    setError('');
    setBusy(true);
    void apiRequest<Page>(`/api/control-plane/v1/personal-workspace/qa-activities?${query}`, {
      signal: controller.signal, cache: 'no-store',
    }).then(next => {
      if (disposed) return;
      if (!Array.isArray(next?.items) || !Number.isSafeInteger(next.total)) throw new Error('明细数据格式不完整');
      setData(next);
    }).catch(caught => {
      if (disposed) return;
      if (timedOut) setError('明细读取超时，请重试');
      else setError(caught instanceof Error ? caught.message : '明细读取失败');
    }).finally(() => { clearTimeout(timeout); if (!disposed) setBusy(false); });
    return () => { disposed = true; clearTimeout(timeout); controller.abort(); };
  }, [selection, page, retry]);

  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className={styles.activityDialog}>
      <header className={styles.activityHeader}>
        <span className={styles.activityKicker}>{selection.isToday ? '今日操作明细' : '操作明细'}</span>
        <DialogTitle className={styles.activityTitle}>{selection.label}</DialogTitle>
        <DialogDescription className={styles.activityDescription}>{activityDescription(selection)}</DialogDescription>
      </header>
      <div className={styles.activityBody}>
        {busy && <p className={styles.activityLoading} role="status">正在读取明细…</p>}
        {error && <div className="notice error" role="alert">{error} <Button variant="outline" size="sm" onClick={() => setRetry(value => value + 1)}>重试</Button></div>}
        {data && <>
          {data.coverageIncomplete && <p className={styles.coverageNotice} role="status">历史覆盖记录不完整，以下仅列出已确认的影响范围。</p>}
          <div className={styles.activitySummary}><span>{data.coverageIncomplete ? '已确认记录' : selection.isToday ? '今日记录' : '所选时间内的记录'}</span><strong>共 {data.total} 次记录</strong></div>
          {data.items.length === 0
            ? <div className={styles.activityEmpty}><strong>{data.coverageIncomplete ? '暂无可确认的覆盖明细' : `${selection.isToday ? '今天' : '所选时间内'}暂无${selection.label}记录`}</strong><p>{data.coverageIncomplete ? '部分历史批量范围无法恢复，当前空明细不代表没有处理。' : '产生有效操作后，记录会显示在这里。'}</p></div>
            : <div className={styles.details}>{data.items.map(item => <article key={item.id} className={styles.receipt}>
              <div className={styles.receiptTop}><strong>{item.code}</strong><span className={styles.receiptOutcome}>{receiptLabel(item)}</span></div>
              {coverageLabel(item) && <div className={styles.receiptSources}>{coverageLabel(item)}</div>}
              <div className={styles.receiptMeta}><span>{item.stage === 'COPY' ? '文案' : '图片'}{item.sampleKind === 'MANDATORY_RECHECK' ? ' · 强制复检' : ''}</span>
                <time dateTime={item.at}>{item.at ? new Date(item.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '时间未记录'}</time></div>
            </article>)}</div>}
        </>}
      </div>
      {data && data.total > data.pageSize && <footer className={styles.pagination}>
        <span>第 {data.page} / {Math.ceil(data.total / data.pageSize)} 页</span>
        <div><Button variant="outline" size="sm" disabled={busy || data.page <= 1} onClick={() => setPage(data.page - 1)}>上一页</Button>
          <Button variant="outline" size="sm" disabled={busy || data.page * data.pageSize >= data.total} onClick={() => setPage(data.page + 1)}>下一页</Button></div>
      </footer>}
    </DialogContent>
  </Dialog>;
}
