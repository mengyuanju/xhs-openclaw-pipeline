import { BatchImageGenerationWorkbench } from './batch-image-generation-workbench';

export default function BatchImageGenerationPage() {
  return <div className="stack">
    <header className="page-header">
      <div>
        <span className="eyebrow">Batch image production</span>
        <h1>批量生成图片</h1>
        <p className="subtle">从已人工质检通过的文案中选择记录，再顺序生成图片。未质检文案不会出现在可选列表中。</p>
      </div>
    </header>
    <BatchImageGenerationWorkbench />
  </div>;
}
