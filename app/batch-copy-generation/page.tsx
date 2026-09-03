import { BatchCopyGenerationWorkbench } from './batch-copy-generation-workbench';
import { redirect } from 'next/navigation';
import { controlPlaneUrl } from '../../src/control-plane/next-runtime.mjs';

export default function BatchCopyGenerationPage() {
  if (controlPlaneUrl()) redirect('/copy-generation');
  return <div className="stack">
    <header className="page-header">
      <div>
        <span className="eyebrow">Batch copy production</span>
        <h1>批量生成文案</h1>
        <p className="subtle">每行输入一个选题，系统按顺序生成并保存文案。生成完成后先逐条人工质检，未确认的文案不会进入批量生图。</p>
      </div>
    </header>
    <BatchCopyGenerationWorkbench />
  </div>;
}
