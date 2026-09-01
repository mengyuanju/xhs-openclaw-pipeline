import { ClipboardCheck } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { readServerSession, withAuthorizedReviewStore } from '../server-session';
import { ReviewWorkbench } from './review-workbench';

export const dynamic = 'force-dynamic';

function emptyResult(page = 1) {
  return { data: [], pagination: { page, pageSize: 30, totalItems: 0, totalPages: 0 } };
}

export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await readServerSession();
  if (!session) redirect('/login?next=%2Freviews');
  const params = await searchParams;
  const pageNumber = (name: string) => {
    const value = typeof params[name] === 'string' ? Number(params[name]) : 1;
    return Number.isInteger(value) && value > 0 ? value : 1;
  };
  const data = withAuthorizedReviewStore(session, (store: any, actor: any) => {
    const isManager = actor.roles.some((role: string) => ['ADMIN', 'QC_LEAD'].includes(role));
    const canQuery = isManager || actor.roles.includes('QUERY_REVIEWER');
    const canCopy = isManager || actor.roles.includes('COPY_REVIEWER');
    return {
      actor,
      taskAssignments: canCopy
        ? store.listReviewTaskAssignments(actor, { page: pageNumber('taskPage'), pageSize: 30 })
        : emptyResult(pageNumber('taskPage')),
      queryItems: canQuery
        ? store.listReviewWorkItems(actor, {
          page: pageNumber('queryPage'),
          pageSize: 30,
          reviewType: 'QUERY',
        })
        : emptyResult(pageNumber('queryPage')),
      users: isManager ? store.listReviewUsers(actor, { status: 'ACTIVE' }).data : [],
      batches: isManager ? store.listReviewTaskAllocationBatches(actor) : [],
    };
  }) as any;

  return <>
    <header className="page-header review-center-header">
      <div>
        <span className="eyebrow">Quality operations</span>
        <h1><ClipboardCheck aria-hidden="true" size={26} />质检中心</h1>
        <p className="subtle">生产任务按条数分给一名内容质检员，文案到图片由同一人负责；Query 预审保持独立。</p>
      </div>
      {session.roles?.includes('ADMIN') && <Link className="button" href="/reviews/people">管理质检人员</Link>}
    </header>
    <ReviewWorkbench
      actor={data.actor}
      taskAssignments={data.taskAssignments}
      queryItems={data.queryItems}
      users={data.users}
      batches={data.batches}
    />
  </>;
}
