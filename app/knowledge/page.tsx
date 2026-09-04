import { withKnowledgeStore, listAllKnowledge } from '../../src/admin/knowledge-runtime.mjs';
import { KnowledgeTabs } from './knowledge-tabs';
import './knowledge.css';

export const dynamic = 'force-dynamic';

export default async function KnowledgePage() {
  let result: any;
  try {
    result = await withKnowledgeStore(async (store: any) => {
      const [visualItems, copyItems, copyLabels, copyAnalysisPrompts] = await Promise.all([
        listAllKnowledge(store, 'listVisualKnowledge'), listAllKnowledge(store, 'listCopyKnowledge'),
        store.listCopyKnowledgeLabels(), store.listCopyAnalysisPrompts(),
      ]);
      return { visualItems, copyItems, copyLabels, copyAnalysisPrompts };
    });
  } catch (error) {
    return <section className="panel"><h1 className="sr-only">知识库</h1><h2>知识库暂时无法读取</h2><p role="alert">{error instanceof Error ? error.message : '读取失败，请稍后重试'}</p><a className="button" href="/knowledge">重新加载</a></section>;
  }
  return <>
    <header className="page-header">
      <div>
        <span className="eyebrow">Content knowledge</span>
        <h1 className="sr-only">知识库</h1>
        <p className="subtle">在同一入口沉淀视觉经验与文案经验，并按内容类型切换管理。</p>
      </div>
    </header>
    <KnowledgeTabs
      visualItems={result.visualItems}
      copyItems={result.copyItems}
      copyLabels={result.copyLabels}
      copyAnalysisPrompts={result.copyAnalysisPrompts}
    />
  </>;
}
