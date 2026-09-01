import { CopyGenerationWorkbench } from './copy-generation-workbench';

export default function CopyGenerationPage() {
  return <>
    <header className="page-header">
      <div>
        <span className="eyebrow">Standalone copy</span>
        <h1>单独生成文案</h1>
        <p className="subtle">直接完成选题审核、联网研究、文案生成与文本审核；不创建生产任务，也不生成图片。</p>
      </div>
    </header>
    <CopyGenerationWorkbench />
  </>;
}
