'use client';

import {
  ArrowRight,
  ClipboardList,
  Clock3,
  Layers3,
  RefreshCw,
  SearchCheck,
  ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { apiRequest } from '../components/api-client';
import { createRequestId } from '../components/request-id';
import styles from './copy-flow.module.css';

type Queue = { id: string | null; version: string; query_package_name: string; review: number; qc: number; frozen: number; rework: number; image: number };
type Overview = { capabilities: { review: boolean; qc: boolean; admin: boolean }; queues: Queue[] };

export default function CopyFlowPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      setData(await apiRequest<Overview>('/api/control-plane/v1/copy-quality/queues'));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function close(queue: Queue) {
    setBusy(true);
    try {
      await apiRequest(`/api/control-plane/v1/production-batches/${queue.id}/copy-sampling-freeze`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: createRequestId(), expectedVersion: Number(queue.version) }),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '结批失败');
    } finally {
      setBusy(false);
    }
  }

  const totals = data?.queues.reduce((summary, queue) => ({
    review: summary.review + queue.review,
    qc: summary.qc + queue.qc,
    image: summary.image + queue.image,
  }), { review: 0, qc: 0, image: 0 }) ?? { review: 0, qc: 0, image: 0 };
  const columnCount = data?.capabilities.admin ? 7 : 6;

  return <div className={styles.page}>
    <header className={styles.pageHeader}>
      <div>
        <span className="eyebrow">Copy workflow</span>
        <h1>文案工作入口</h1>
        <p className="subtle">查看审核与质检进度，快速进入当前需要处理的工作。</p>
      </div>
      <button className={`button ${styles.refreshButton}`} type="button" disabled={loading || busy} onClick={() => void refresh()}>
        <RefreshCw aria-hidden="true" className={loading ? styles.spinning : undefined} size={15} />
        {loading ? '刷新中' : '刷新数据'}
      </button>
    </header>

    <nav className={styles.quickActions} aria-label="文案工作快捷入口">
      <Link className={`${styles.actionCard} ${styles.primaryAction}`} href="/workbench/personal">
        <span className={styles.actionIcon}><ClipboardList aria-hidden="true" size={19} /></span>
        <span className={styles.actionText}><strong>浏览任务</strong><small>查看并处理分配给我的任务</small></span>
        <ArrowRight aria-hidden="true" className={styles.actionArrow} size={17} />
      </Link>
      {data?.capabilities.review && <Link className={styles.actionCard} href="/workbench/personal?state=COPY_REVIEW_PENDING">
        <span className={styles.actionIcon}><ShieldCheck aria-hidden="true" size={19} /></span>
        <span className={styles.actionText}><strong>文案审核</strong><small>处理待审核文案并提交结果</small></span>
        <ArrowRight aria-hidden="true" className={styles.actionArrow} size={17} />
      </Link>}
      {data?.capabilities.qc && <Link className={styles.actionCard} href="/copy-qa">
        <span className={styles.actionIcon}><SearchCheck aria-hidden="true" size={19} /></span>
        <span className={styles.actionText}><strong>文案质检</strong><small>进行抽检与返工复检</small></span>
        <ArrowRight aria-hidden="true" className={styles.actionArrow} size={17} />
      </Link>}
    </nav>

    {error && <div className={styles.error} role="alert">{error}</div>}

    <section className={`panel ${styles.queuePanel}`} aria-labelledby="copy-queue-heading">
      <header className={styles.queueHeader}>
        <div className={styles.queueHeading}>
          <div className={styles.queueTitleRow}>
            <span className={styles.queueTitleIcon}><Layers3 aria-hidden="true" size={17} /></span>
            <h2 id="copy-queue-heading">批次队列</h2>
            {data && <span className="pill">{data.queues.length} 个批次</span>}
          </div>
          <p><Clock3 aria-hidden="true" size={13} />按最终审核人独立成批；未满抽样量的文案最多等待 30 分钟后结批抽检。</p>
        </div>

        <dl className={styles.summary} aria-label="队列汇总">
          <div><dt>批次数</dt><dd>{data?.queues.length ?? '—'}</dd></div>
          <div><dt>待审核</dt><dd>{data ? totals.review : '—'}</dd></div>
          <div><dt>待质检</dt><dd>{data ? totals.qc : '—'}</dd></div>
          <div><dt>可生图</dt><dd>{data ? totals.image : '—'}</dd></div>
        </dl>
      </header>

      <div className={styles.tableWrap} role="region" aria-label="文案批次队列，可横向滚动查看完整内容" aria-busy={loading} tabIndex={0}>
        <table className={styles.table}>
          <thead><tr>
            <th scope="col">队列</th>
            <th className={styles.numberHeader} scope="col">待审核</th>
            <th className={styles.numberHeader} scope="col">待质检</th>
            <th className={styles.numberHeader} scope="col">待批次放行</th>
            <th className={styles.numberHeader} scope="col">返工</th>
            <th className={styles.numberHeader} scope="col">可生图</th>
            {data?.capabilities.admin && <th className={styles.actionHeader} scope="col">操作</th>}
          </tr></thead>
          <tbody>
            {data?.queues.map(queue => <tr key={queue.id ?? 'none'}>
              <td className={styles.queueCell} data-label="队列">
                <span className={styles.queueMark}><Layers3 aria-hidden="true" size={15} /></span>
                <strong>{queue.query_package_name || '独立任务'}</strong>
              </td>
              <td className={styles.numberCell} data-label="待审核"><strong className={styles.count} data-tone={queue.review > 0 ? 'red' : 'neutral'}>{queue.review}</strong></td>
              <td className={styles.numberCell} data-label="待质检"><strong className={styles.count} data-tone={queue.qc > 0 ? 'amber' : 'neutral'}>{queue.qc}</strong></td>
              <td className={styles.numberCell} data-label="待批次放行"><strong className={styles.count} data-tone="neutral">{queue.frozen}</strong></td>
              <td className={styles.numberCell} data-label="返工"><strong className={styles.count} data-tone={queue.rework > 0 ? 'red' : 'neutral'}>{queue.rework}</strong></td>
              <td className={styles.numberCell} data-label="可生图"><strong className={styles.count} data-tone={queue.image > 0 ? 'green' : 'neutral'}>{queue.image}</strong></td>
              {data.capabilities.admin && <td className={styles.actionCell} data-label="操作">{queue.id && <button className="button small" type="button" disabled={busy || loading} onClick={() => void close(queue)}>结批并抽检</button>}</td>}
            </tr>)}
            {!data && <tr><td className={styles.emptyState} colSpan={columnCount}>{loading ? '正在加载队列…' : '暂时无法显示队列'}</td></tr>}
            {data?.queues.length === 0 && <tr><td className={styles.emptyState} colSpan={columnCount}>当前没有待处理批次</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  </div>;
}
