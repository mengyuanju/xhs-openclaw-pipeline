import { controlPlaneUrl, executorNodeId } from '../../src/control-plane/next-runtime.mjs';
import { CreationWorkbench } from './creation-workbench';

export const dynamic = 'force-dynamic';

export default function WorkbenchPage() {
  const configured = Boolean(controlPlaneUrl());

  return <>
    <header className="page-header workbench-page-header">
      <div>
        <h1 className="sr-only">作业中心</h1>
        <p className="subtle">集中管理笔记任务，查看文案生成、审核、生图及完成进度。</p>
      </div>
    </header>
    {configured
      ? <CreationWorkbench nodeId={executorNodeId()} />
      : <div className="panel empty-state">
        请先在根目录 <code>.env</code> 配置 <code>CONTROL_PLANE_URL</code> 和 <code>EXECUTOR_NODE_ID</code>，然后重启本机界面服务。
      </div>}
  </>;
}
