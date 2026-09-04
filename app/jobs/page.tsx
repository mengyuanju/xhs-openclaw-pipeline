import { DistributedJobsWorkbench } from './distributed-jobs-workbench';
import { controlPlaneUrl, executorNodeId } from '../../src/control-plane/next-runtime.mjs';

export const dynamic = 'force-dynamic';

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ taskId?: string | string[] }>;
}) {
  const configured = Boolean(controlPlaneUrl());
  const nodeId = configured ? executorNodeId() : '';
  const rawTaskId = (await searchParams).taskId;
  const taskId = typeof rawTaskId === 'string' && /^\d+$/u.test(rawTaskId)
    ? Number(rawTaskId)
    : null;
  return <>
    <header className="page-header">
      <div>
        <span className="eyebrow">Distributed operations</span>
        <h1>远端作业中心</h1>
        <p className="subtle">任务数据以中心服务为准；本机串行生成自己创建的文案，空闲的图片执行机可领取全局生图任务。</p>
      </div>
    </header>
    {configured
      ? <DistributedJobsWorkbench nodeId={nodeId} initialTaskId={taskId} />
      : <div className="panel empty-state">
        请先配置 <code>CONTROL_PLANE_URL</code> 和 <code>EXECUTOR_NODE_ID</code>，然后重启本机界面服务。
      </div>}
  </>;
}
