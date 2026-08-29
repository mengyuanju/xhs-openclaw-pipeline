import {
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Files,
  ListChecks,
  LoaderCircle,
} from 'lucide-react';
import Link from 'next/link';

import { Card, CardContent } from '@/components/ui/card';

import { StatusPill } from './components/status-pill';
import { withAdminStore } from '../src/admin/runtime.mjs';

export const dynamic = 'force-dynamic';

export default function DashboardPage() {
  const { stats, recent } = withAdminStore((store: any) => ({
    stats: store.getDashboardStats(),
    recent: store.listTasks({ page: 1, pageSize: 6 }).data,
  })) as any;

  const metrics = [
    { label: '全部任务', value: stats.tasks.total, detail: '已进入生产队列', icon: Files, tone: 'neutral' },
    { label: '生产中', value: stats.tasks.processing, detail: `${stats.tasks.pending} 条等待生成`, icon: LoaderCircle, tone: 'blue' },
    { label: '待人工审核', value: stats.reviews.waiting, detail: `${stats.reviews.rejected} 条需要返工`, icon: ListChecks, tone: 'amber' },
    { label: '已通过', value: stats.reviews.approved, detail: '可进入交付导出', icon: CheckCircle2, tone: 'green' },
  ];

  const attentionItems = [
    { label: '等待人工审核', count: stats.reviews.waiting, href: '/tasks?reviewStatus=WAITING_REVIEW', icon: ListChecks, tone: 'amber' },
    { label: '生成失败任务', count: stats.tasks.failed, href: '/tasks?status=failed', icon: CircleAlert, tone: 'red' },
    { label: '待确认导入批次', count: stats.imports.preview, href: '/imports', icon: Clock3, tone: 'neutral' },
  ];

  return (
    <>
      <section className="dashboard-overview">
        <div>
          <span className="eyebrow">Production command center</span>
          <h1 className="sr-only">工作台</h1>
          <h2>内容生产总览</h2>
          <p className="subtle">先处理阻塞项，再查看最近任务；所有入口都回到同一条生产链路。</p>
        </div>
        <div className="header-actions">
          <Link className="button" href="/tasks">进入任务中心</Link>
          <Link className="button primary" href="/imports">导入新选题</Link>
        </div>
      </section>

      <section className="stats-grid dashboard-metrics" aria-label="生产指标">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <Card className="dashboard-metric-card" key={metric.label}>
              <CardContent className="dashboard-metric-content">
                <div className={`dashboard-metric-icon tone-${metric.tone}`}><Icon aria-hidden="true" size={17} /></div>
                <div><span className="label">{metric.label}</span><strong>{metric.value}</strong><small>{metric.detail}</small></div>
              </CardContent>
            </Card>
          );
        })}
      </section>

      <section className="dashboard-main-grid">
        <article className="panel dashboard-recent-panel">
          <div className="panel-head">
            <div><span className="section-kicker">Latest production</span><h2>最近任务</h2></div>
            <Link className="button small" href="/tasks">查看全部</Link>
          </div>
          {recent.length === 0 ? (
            <div className="empty-state">还没有任务，从 Excel 导入第一组选题。</div>
          ) : (
            <div className="table-wrap mobile-cards">
              <table>
                <thead><tr><th>ID</th><th>选题</th><th>生成状态</th><th>审核</th></tr></thead>
                <tbody>{recent.map((task: any) => (
                  <tr key={task.id}>
                    <td className="mono" data-label="ID">#{task.id}</td>
                    <td className="query-cell" data-label="选题"><Link href={`/tasks/${task.id}`}>{task.query}</Link></td>
                    <td data-label="生成状态"><StatusPill value={task.status} /></td>
                    <td data-label="审核"><StatusPill value={task.config?.reviewStatus} /></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </article>

        <aside className="dashboard-rail">
          <Card className="dashboard-attention-panel">
            <div className="dashboard-card-heading"><div><span className="section-kicker">Action queue</span><h2>需要处理</h2></div></div>
            <CardContent className="dashboard-attention-list">
              {attentionItems.map((item) => {
                const Icon = item.icon;
                return (
                  <Link className="dashboard-attention-item" href={item.href} key={item.label}>
                    <span className={`dashboard-attention-icon tone-${item.tone}`}><Icon aria-hidden="true" size={16} /></span>
                    <span><strong>{item.label}</strong><small>{item.count === 0 ? '当前没有阻塞项' : `${item.count} 项等待处理`}</small></span>
                    <b>{item.count}</b>
                    <ArrowRight aria-hidden="true" size={15} />
                  </Link>
                );
              })}
            </CardContent>
          </Card>

          <Card className="dashboard-flow-panel">
            <div className="dashboard-card-heading"><div><span className="section-kicker">Production flow</span><h2>生产链路</h2></div></div>
            <CardContent className="dashboard-flow-list">
              <Link href="/imports"><span>01</span><div><strong>选题与需求筛选</strong><small>导入、预检、确认入队</small></div><ArrowRight aria-hidden="true" size={14} /></Link>
              <Link href="/tasks"><span>02</span><div><strong>生成与人工审核</strong><small>查看进度、修订与返工</small></div><ArrowRight aria-hidden="true" size={14} /></Link>
              <Link href="/analytics"><span>03</span><div><strong>交付与效果复盘</strong><small>导出内容、观察质量指标</small></div><ArrowRight aria-hidden="true" size={14} /></Link>
            </CardContent>
          </Card>
        </aside>
      </section>
    </>
  );
}
