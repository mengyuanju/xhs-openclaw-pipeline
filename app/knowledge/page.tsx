import { withAdminStore } from '../../src/admin/runtime.mjs';
import { KnowledgeTabs } from './knowledge-tabs';
import { CentralDataWorkbench } from '../components/central-data-workbench';
import { controlPlaneUrl } from '../../src/control-plane/next-runtime.mjs';

export const dynamic = 'force-dynamic';

export default function KnowledgePage() {
  if (controlPlaneUrl()) return <>
    <header className="page-header"><div><span className="eyebrow">Central knowledge</span><h1 className="sr-only">知识库</h1><p className="subtle">文案与视觉知识由远端中心统一管理，执行机只读取领取任务时冻结的版本。</p></div></header>
    <CentralDataWorkbench resource="knowledge" />
  </>;
  const result = withAdminStore((store: any) => ({
    visualKnowledge: store.listVisualKnowledge({ page: 1, pageSize: 100 }),
    copyKnowledge: store.listCopyKnowledge({ page: 1, pageSize: 100 }),
    copyLabels: store.listCopyKnowledgeLabels(),
  })) as any;
  return <>
    <header className="page-header">
      <div>
        <span className="eyebrow">Content knowledge</span>
        <h1 className="sr-only">知识库</h1>
        <p className="subtle">在同一入口沉淀视觉经验与文案经验，并按内容类型切换管理。</p>
      </div>
    </header>
    <KnowledgeTabs
      visualItems={result.visualKnowledge.data}
      copyItems={result.copyKnowledge.data}
      copyLabels={result.copyLabels}
    />
  </>;
}
