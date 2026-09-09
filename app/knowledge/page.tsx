import { redirect } from 'next/navigation';

import { readServerSession } from '../server-session';
import { ApiError } from '../../src/admin/http.mjs';
import { withKnowledgeStore, listAllKnowledge } from '../../src/admin/knowledge-runtime.mjs';
import { KnowledgeTabs } from './knowledge-tabs';
import './knowledge.css';

export const dynamic = 'force-dynamic';
const COPY_KNOWLEDGE_PAGE_SIZES = new Set([10, 20, 50]);

type KnowledgeSearchParams = Record<string, string | string[] | undefined>;

function firstSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function boundedSearchParam(value: string | undefined, maximumLength: number) {
  const normalized = value?.normalize('NFKC').trim() ?? '';
  return [...normalized].slice(0, maximumLength).join('');
}

async function listCopyKnowledgePage(store: any, options: Record<string, unknown>) {
  let result = await store.listCopyKnowledge(options);
  if (result.pagination.page > result.pagination.totalPages) {
    result = await store.listCopyKnowledge({ ...options, page: result.pagination.totalPages });
  }
  return result;
}

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<KnowledgeSearchParams>;
}) {
  const session = await readServerSession();
  if (!session) redirect('/login?next=%2Fknowledge');
  if (!session.roles?.some((role: string) => ['ADMIN', 'REVIEWER'].includes(role))) redirect('/workbench/personal');
  const search = await searchParams;
  const requestedPageSize = positiveInteger(firstSearchParam(search.copyPageSize), 10);
  const copyPageSize = COPY_KNOWLEDGE_PAGE_SIZES.has(requestedPageSize) ? requestedPageSize : 10;
  const copyPage = positiveInteger(firstSearchParam(search.copyPage), 1);
  const copyLabel = boundedSearchParam(firstSearchParam(search.copyLabel), 50);
  const copyQuery = boundedSearchParam(firstSearchParam(search.copyQuery), 200);
  let result: any;
  try {
    result = await withKnowledgeStore(async (store: any) => {
      const [visualItems, copyResult, copyLabels, copyAnalysisPrompts, production] = await Promise.all([
        listAllKnowledge(store, 'listVisualKnowledge'),
        listCopyKnowledgePage(store, {
          page: copyPage,
          pageSize: copyPageSize,
          label: copyLabel || undefined,
          query: copyQuery || undefined,
        }),
        store.listCopyKnowledgeLabels(), store.listCopyAnalysisPrompts(),
        store.getProductionSettings(),
      ]);
      return { visualItems, copyResult, copyLabels, copyAnalysisPrompts,
        knowledgeEnabled: production.settings.knowledgeEnabled !== false, remote: Boolean(store.remote) };
    }, session);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect('/login?reauth=1&next=%2Fknowledge');
    return <section className="panel"><h1 className="sr-only">知识库</h1><h2>知识库暂时无法读取</h2><p role="alert">{error instanceof Error ? error.message : '读取失败，请稍后重试'}</p><a className="button" href="/knowledge">重新加载</a></section>;
  }
  return <>
    <h1 className="sr-only">知识库</h1>
    <KnowledgeTabs
      visualItems={result.visualItems}
      copyItems={result.copyResult.data}
      copyPagination={result.copyResult.pagination}
      copyLabels={result.copyLabels}
      copyAnalysisPrompts={result.copyAnalysisPrompts}
      copySelectedLabel={copyLabel || 'ALL'}
      copySearchQuery={copyQuery}
      knowledgeEnabled={result.knowledgeEnabled}
      remote={result.remote}
    />
  </>;
}
