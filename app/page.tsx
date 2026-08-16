import Link from 'next/link';

import { StatusPill } from './components/status-pill';
import { withAdminStore } from '../src/admin/runtime.mjs';

export const dynamic = 'force-dynamic';

export default function DashboardPage() {
  const { stats, recent } = withAdminStore((store: any) => ({
    stats: store.getDashboardStats(),
    recent: store.listTasks({ page: 1, pageSize: 6 }).data,
  })) as any;

  return (
    <>
      <header className="page-header">
        <div>
          <span className="eyebrow">Production overview</span>
          <h1>今天，内容流转到哪里了？</h1>
          <p className="subtle">选题入队、OpenClaw 生成、人工审核，所有关键状态集中在这里。</p>
        </div>
        <div className="header-actions">
          <Link className="button" href="/prompts">调整提示词</Link>
          <Link className="button primary" href="/imports">导入新选题</Link>
        </div>
      </header>

      <section className="stats-grid" aria-label="任务统计">
        <article className="stat-card accent"><span className="label">全部任务</span><strong>{stats.tasks.total}</strong><small>已进入生产队列</small></article>
        <article className="stat-card"><span className="label">等待生成</span><strong>{stats.tasks.pending}</strong><small>{stats.tasks.processing} 条正在生成</small></article>
        <article className="stat-card"><span className="label">待人工审核</span><strong>{stats.reviews.waiting}</strong><small>{stats.reviews.approved} 条已通过</small></article>
        <article className="stat-card"><span className="label">导入批次</span><strong>{stats.imports.committed}</strong><small>{stats.imports.preview} 个批次待确认</small></article>
      </section>

      <section className="two-column">
        <article className="panel">
          <div className="panel-head"><h2>最近任务</h2><Link className="button small" href="/tasks">查看全部</Link></div>
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

        <aside className="panel">
          <div className="panel-head"><h2>标准生产流</h2></div>
          <div className="steps">
            <div className="step"><span className="step-index">01</span><div><strong>Excel 预检</strong><p>识别格式、重复项与无效行，确认后才写入任务队列。</p></div></div>
            <div className="step"><span className="step-index">02</span><div><strong>OpenClaw 生成</strong><p>任务固定使用入队时发布的提示词版本，避免中途漂移。</p></div></div>
            <div className="step"><span className="step-index">03</span><div><strong>人工定稿</strong><p>文案与图片均保留历史版本，通过后才成为可交付内容。</p></div></div>
          </div>
        </aside>
      </section>
    </>
  );
}
