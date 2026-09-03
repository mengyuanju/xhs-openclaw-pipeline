import { CopyGenerationWorkbench } from './copy-generation-workbench';
import { DistributedJobsWorkbench } from '../jobs/distributed-jobs-workbench';
import { controlPlaneUrl, executorNodeId } from '../../src/control-plane/next-runtime.mjs';

export const dynamic = 'force-dynamic';

export default function CopyGenerationPage() {
  if (controlPlaneUrl()) {
    return <>
      <header className="page-header">
        <div>
          <span className="eyebrow">Remote copy queue</span>
          <h1>单独生成文案</h1>
          <p className="subtle">创建一条或多条远端任务，由本机执行代理依次生成；完成后在远端作业中心人工审核。</p>
        </div>
      </header>
      <DistributedJobsWorkbench nodeId={executorNodeId()} />
    </>;
  }
  return <>
    <header className="page-header">
      <div>
        <span className="eyebrow">Standalone copy</span>
        <h1>单独生成文案</h1>
        <p className="subtle">生成并保存当前文案，支持历史恢复；自动文案质检当前已关闭，不创建生产任务，也不生成图片。</p>
      </div>
    </header>
    <CopyGenerationWorkbench />
  </>;
}
