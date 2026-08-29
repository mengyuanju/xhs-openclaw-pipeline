import Link from 'next/link';

import { formatDuration } from '../components/time-format';
import { withAdminStore } from '../../src/admin/runtime.mjs';

export const dynamic = 'force-dynamic';

function dateTime(value: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN') : '暂无数据';
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ page?: string | string[] }> }) {
  const rawPage = (await searchParams).page;
  const page = Array.isArray(rawPage) ? 1 : Math.max(1, Number(rawPage) || 1);
  const report = withAdminStore((store: any) => store.listProductionStatistics({ page, pageSize: 20 })) as any;
  const repairSuccessRate = report.overview.qualityRepairRuns > 0
    ? Math.round((report.overview.qualityRepairTargetReached / report.overview.qualityRepairRuns) * 100)
    : 0;
  return <>
    <header className="page-header"><div><span className="eyebrow">Production analytics</span><h1 className="sr-only">数据统计</h1><p className="subtle">集中观察批次耗时、评分分布和质量修复表现，为后续策略调整保留统一数据口径。</p></div></header>
    <section className="stats-grid" aria-label="生产统计概览">
      <article className="stat-card accent"><span className="label">任务总数</span><strong>{report.overview.taskCount}</strong><small>{report.overview.finishedTaskCount} 条已结束</small></article>
      <article className="stat-card"><span className="label">质量修复</span><strong>{report.overview.qualityRepairAttempts}</strong><small>{report.overview.qualityRepairTargetReached} 个运行达到目标</small></article>
      <article className="stat-card"><span className="label">修复达标比例</span><strong>{repairSuccessRate}%</strong><small>以产生修复的运行批次计算</small></article>
      <article className="stat-card"><span className="label">统计批次</span><strong>{report.pagination.totalItems}</strong><small>导入批次</small></article>
    </section>

    <section className="panel analytics-score-panel">
      <div className="panel-head"><div><h2>评分分布</h2><p className="subtle">对比质量修复前的首次分数和当前最终分数。</p></div></div>
      <div className="analytics-score-grid">{[0, 1, 2, 3].map((score) => <article key={score}><strong>{score} 分</strong><span>首次 {report.overview.initialScoreCounts[score]}</span><span>最终 {report.overview.finalScoreCounts[score]}</span></article>)}</div>
    </section>

    <section className="panel analytics-batches">
      <div className="panel-head"><h2>批次耗时与进度</h2></div>
      {report.batches.length === 0 ? <div className="empty-state">暂无可统计批次。</div> : <div className="table-wrap mobile-cards"><table><thead><tr><th>批次</th><th>生成进度</th><th>开始时间</th><th>结束时间</th><th>批次耗时</th><th>平均运行耗时</th><th>修复次数</th></tr></thead><tbody>{report.batches.map((batch: any) => <tr key={batch.id}>
        <td data-label="批次"><Link href={`/imports?batchId=${batch.id}`}>{batch.name}</Link></td>
        <td data-label="生成进度">{batch.statistics.finishedTaskCount} / {batch.statistics.taskCount}（{batch.statistics.progressPercent}%）</td>
        <td data-label="开始时间">{dateTime(batch.statistics.startedAt)}</td>
        <td data-label="结束时间">{dateTime(batch.statistics.finishedAt)}</td>
        <td data-label="批次耗时">{formatDuration(batch.statistics.wallDurationMs)}</td>
        <td data-label="平均运行耗时">{formatDuration(batch.statistics.averageRunDurationMs)}</td>
        <td data-label="修复次数">{batch.statistics.qualityRepairAttempts}</td>
      </tr>)}</tbody></table></div>}
      {report.pagination.totalPages > 1 && <nav className="pagination" aria-label="统计分页">
        {page > 1 && <Link className="button small" href={`/analytics?page=${page - 1}`}>上一页</Link>}
        <span>第 {page} / {report.pagination.totalPages} 页</span>
        {page < report.pagination.totalPages && <Link className="button small" href={`/analytics?page=${page + 1}`}>下一页</Link>}
      </nav>}
    </section>
  </>;
}
