import { redirect } from 'next/navigation';

import { readServerSession } from '../server-session';
import { ApiError } from '../../src/admin/http.mjs';
import { withKnowledgeStore, listAllKnowledge } from '../../src/admin/knowledge-runtime.mjs';
import { KnowledgeTabs } from './knowledge-tabs';
import './knowledge.css';

export const dynamic = 'force-dynamic';

export default async function KnowledgePage() {
  const session = await readServerSession();
  if (!session) redirect('/login?next=%2Fknowledge');
  if (!session.roles?.some((role: string) => ['ADMIN', 'REVIEWER'].includes(role))) redirect('/workbench/personal');
  let result: any;
  try {
    result = await withKnowledgeStore(async (store: any) => {
      const [visualItems, copyItems, copyLabels, copyAnalysisPrompts] = await Promise.all([
        listAllKnowledge(store, 'listVisualKnowledge'), listAllKnowledge(store, 'listCopyKnowledge'),
        store.listCopyKnowledgeLabels(), store.listCopyAnalysisPrompts(),
      ]);
      return { visualItems, copyItems, copyLabels, copyAnalysisPrompts };
    }, session);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect('/login?reauth=1&next=%2Fknowledge');
    return <section className="panel"><h1 className="sr-only">知识库</h1><h2>知识库暂时无法读取</h2><p role="alert">{error instanceof Error ? error.message : '读取失败，请稍后重试'}</p><a className="button" href="/knowledge">重新加载</a></section>;
  }
  return <>
    <h1 className="sr-only">知识库</h1>
    <KnowledgeTabs
      visualItems={result.visualItems}
      copyItems={result.copyItems}
      copyLabels={result.copyLabels}
      copyAnalysisPrompts={result.copyAnalysisPrompts}
    />
  </>;
}
