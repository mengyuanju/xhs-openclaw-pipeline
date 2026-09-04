import { withAdminStore } from '../../src/admin/runtime.mjs';
import { PromptEditor } from './prompt-editor';
import { CentralPromptWorkbench } from './central-prompt-workbench';
import { controlPlaneUrl } from '../../src/control-plane/next-runtime.mjs';

export const dynamic = 'force-dynamic';

export default function PromptsPage() {
  if (controlPlaneUrl()) return <>
    <header className="page-header"><div><span className="eyebrow">Central prompt versions</span><h1 className="sr-only">提示词</h1><p className="subtle">提示词由远端中心统一保存和发布；运行中的任务使用已冻结版本。</p></div></header>
    <CentralPromptWorkbench />
  </>;
  const templates = withAdminStore((store: any) => store.listPromptTemplates()) as any[];
  return <>
    <header className="page-header"><div><span className="eyebrow">Versioned instructions</span><h1 className="sr-only">提示词</h1><p className="subtle">新任务在入队时固定提示词内容和哈希；发布新版本不会改变已经排队的任务。</p></div></header>
    <div className="notice">提示词内容会直接影响批量结果。建议先用 10–20 条小批次验证，通过抽检后再扩到千条规模。</div>
    <section className="stack prompt-template-list">{templates.map((template: any) => <PromptEditor key={template.id} template={template} />)}</section>
  </>;
}
