import { CopyGenerationWorkbench } from './copy-generation-workbench';

export default function CopyGenerationPage() {
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
