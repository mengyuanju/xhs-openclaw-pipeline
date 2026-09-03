import { DistributedJobsWorkbench } from './distributed-jobs-workbench';
import { controlPlaneUrl, executorNodeId } from '../../src/control-plane/next-runtime.mjs';

export const dynamic = 'force-dynamic';

export default function JobsPage() {
  const configured = Boolean(controlPlaneUrl());
  const nodeId = configured ? executorNodeId() : '';
  return <>
    <header className="page-header">
      <div>
        <span className="eyebrow">Distributed operations</span>
        <h1>远端作业中心</h1>
        <p className="subtle">任务数据以中心服务为准；本机串行生成自己创建的文案，空闲的图片执行机可领取全局生图任务。</p>
      </div>
    </header>
    {configured
      ? <DistributedJobsWorkbench nodeId={nodeId} />
      : <div className="panel empty-state">
        请先配置 <code>CONTROL_PLANE_URL</code> 和 <code>EXECUTOR_NODE_ID</code>，然后重启本机界面服务。
      </div>}
  </>;
}
