import { CopyGenerationWorkbench } from './copy-generation-workbench';

export default function CopyGenerationPage() {
  return <>
    <header className="page-header">
      <div>
        <span className="eyebrow">Standalone copy</span>
        <h1>单独生成文案</h1>
        <p className="subtle">分别生成并保存原始版与质检修订版，支持历史恢复和并排对比；不创建生产任务，也不生成图片。</p>
      </div>
    </header>
    <CopyGenerationWorkbench />
  </>;
}
