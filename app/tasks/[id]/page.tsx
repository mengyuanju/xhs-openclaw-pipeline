import Link from 'next/link';
import { notFound } from 'next/navigation';

import { StatusPill } from '../../components/status-pill';
import { withAdminStore } from '../../../src/admin/runtime.mjs';
import { ReviewPanel } from './review-panel';
import { RetryButton } from './retry-button';

export const dynamic = 'force-dynamic';

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const rawId = (await params).id;
  if (!/^[1-9]\d*$/.test(rawId)) notFound();
  const task = withAdminStore((store: any) => store.getTask(Number(rawId))) as any;
  if (!task?.config) notFound();
  return <>
    <header className="page-header"><div className="task-title"><Link className="subtle" href="/tasks">← 返回任务列表</Link><h1>{task.query}</h1><div className="inline"><span className="mono subtle">任务 #{task.id}</span><StatusPill value={task.status} /><StatusPill value={task.config.reviewStatus} />{task.status === 'failed' && <RetryButton taskId={task.id} />}</div></div></header>
    {task.error && <div className="notice error" style={{marginBottom: 18}}>生成失败：{task.error}</div>}
    <ReviewPanel task={task} />
  </>;
}
