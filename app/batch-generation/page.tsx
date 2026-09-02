import { BatchGenerationWorkbench } from './batch-generation-workbench';

export default function BatchGenerationPage() {
  return <div className="stack">
    <header className="page-header">
      <div>
        <span className="eyebrow">Batch production</span>
        <h1>批量生成图文</h1>
        <p className="subtle">每行输入一个选题，系统按顺序为每条生成文案和配图；单条失败不会中断整批，也不会创建正式生产任务或自动发布。</p>
      </div>
    </header>
    <BatchGenerationWorkbench />
  </div>;
}
