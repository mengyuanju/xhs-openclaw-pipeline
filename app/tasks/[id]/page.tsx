import Link from 'next/link';
import { notFound } from 'next/navigation';

import { StatusPill } from '../../components/status-pill';
import { TaskProgressRefresh } from '../../components/task-progress-refresh';
import { TaskTiming } from '../../components/task-timing';
import { attachGenerationVisualPlans } from '../../../src/admin/generation-artifact-reader.mjs';
import { adminOutputRoot, withAdminStore } from '../../../src/admin/runtime.mjs';
import { getTaskExportAvailability } from '../../../src/admin/task-export.mjs';
import { ReviewPanel } from './review-panel';
import { RetryButton } from './retry-button';

export const dynamic = 'force-dynamic';

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const rawId = (await params).id;
  if (!/^[1-9]\d*$/.test(rawId)) notFound();
  const taskId = Number(rawId);
  const detail = withAdminStore((store: any) => {
    const task = store.getTask(taskId);
    return {
      task,
      adjacent: task ? store.getAdjacentTaskIds(taskId) : null,
      timingStats: store.getTaskTimingStats(),
      exportAvailability: getTaskExportAvailability(task),
    };
  }) as any;
  const task = await attachGenerationVisualPlans(detail.task, { outputRoot: adminOutputRoot() });
  const { adjacent, timingStats, exportAvailability } = detail;
  if (!task?.config) notFound();
  const taskListHref = task.config.importBatchId
    ? `/tasks?batchId=${task.config.importBatchId}`
    : '/tasks';
  return <>
    <header className="page-header">
      <div className="task-title">
        <div className="task-review-topbar">
          <Link className="subtle" href={taskListHref}>← 返回当前批次</Link>
          <nav className="task-review-nav" aria-label="审核题目导航">
            {adjacent.previousTaskId
              ? <Link className="button small" href={`/tasks/${adjacent.previousTaskId}`} rel="prev">上一题</Link>
              : <button className="button small" type="button" disabled title="已经是第一题">上一题</button>}
            {adjacent.nextTaskId
              ? <Link className="button small" href={`/tasks/${adjacent.nextTaskId}`} rel="next">下一题</Link>
              : <button className="button small" type="button" disabled title="已经是最后一题">下一题</button>}
          </nav>
        </div>
        <h1>{task.query}</h1>
        <div className="inline"><span className="mono subtle">任务 #{task.id}</span><StatusPill value={task.status} /><StatusPill value={task.config.reviewStatus} /><TaskTiming task={task} timingStats={timingStats} />{task.status === 'failed' && <RetryButton taskId={task.id} />}</div>
      </div>
      <TaskProgressRefresh active={task.status === 'pending' || task.status === 'processing'} />
    </header>
    {task.error && <div className="notice error" style={{marginBottom: 18}}>生成失败：{task.error}</div>}
    <ReviewPanel task={task} exportAvailability={exportAvailability} />
  </>;
}
