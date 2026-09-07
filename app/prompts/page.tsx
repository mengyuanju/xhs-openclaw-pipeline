import { withAdminStore } from '../../src/admin/runtime.mjs';
import { PromptRuntimeSettings } from './prompt-runtime-settings';
import { LocalPromptWorkbench } from './local-prompt-workbench';
import { CentralPromptWorkbench } from './central-prompt-workbench';
import { controlPlaneUrl } from '../../src/control-plane/next-runtime.mjs';
import { readServerSession } from '../server-session';
import { redirect } from 'next/navigation';
import { PROMPT_CATALOG } from '../../src/prompt-catalog.mjs';
import { defaultBusinessPrompt } from '../../src/prompt-runtime.mjs';

export const dynamic = 'force-dynamic';

export default async function PromptsPage() {
  const session = await readServerSession();
  if (!session) redirect('/login?next=%2Fprompts');
  if (!session.roles?.includes('ADMIN')) redirect('/workbench');
  if (controlPlaneUrl()) return <>
    <header className="page-header"><div><span className="eyebrow">Central prompt versions</span><h1 className="sr-only">提示词</h1><p className="subtle">提示词由远端中心统一保存和发布；运行中的任务使用已冻结版本。</p></div></header>
    <CentralPromptWorkbench catalog={PROMPT_CATALOG.map((item) => ({ ...item, candidate: defaultBusinessPrompt(item.kind) }))} />
  </>;
  const templates = withAdminStore((store: any) => store.listPromptTemplates()) as any[];
  return <>
    <header className="page-header"><div><span className="eyebrow">Versioned instructions</span><h1 className="sr-only">提示词</h1><p className="subtle">执行开始时固定业务规则和开关；历史重试沿用原快照。原有三类任务提示词继续保留入队时版本。</p></div></header>
    <PromptRuntimeSettings />
    <div className="notice">提示词内容会直接影响批量结果。建议先用 10–20 条小批次验证，通过抽检后再扩到千条规模。</div>
    <LocalPromptWorkbench templates={templates} />
  </>;
}
