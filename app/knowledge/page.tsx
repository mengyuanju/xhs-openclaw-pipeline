import { withAdminStore } from '../../src/admin/runtime.mjs';
import { KnowledgeWorkbench } from './knowledge-workbench';

export const dynamic = 'force-dynamic';

export default function KnowledgePage() {
  const result = withAdminStore((store: any) => store.listVisualKnowledge({ page: 1, pageSize: 100 })) as any;
  return <>
    <header className="page-header">
      <div>
        <span className="eyebrow">Visual knowledge</span>
        <h1>把优秀作品沉淀为可控的视觉配方</h1>
        <p className="subtle">图片只作临时分析；只有自有或已授权素材才允许长期保留并进入参考图生成。</p>
      </div>
    </header>
    <div className="notice">视觉分析会调用真实模型并可能产生费用。配方必须由管理员确认发布，草稿不会进入生产任务。</div>
    <KnowledgeWorkbench items={result.data} />
  </>;
}
