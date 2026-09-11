import { redirect } from 'next/navigation';

import { readCentralPageData } from '../central-user-client';
import { readServerSession } from '../server-session';
import type { XhsSearchNodeStatus } from '../components/xhs-search-status';
import { ExecutorManager, type ExecutorStatus } from './executor-manager';

export const dynamic = 'force-dynamic';

export default async function ExecutorsPage() {
  const session = await readServerSession();
  if (!session) redirect('/login?next=%2Fexecutors');
  if (!session.roles?.includes('ADMIN')) redirect('/workbench/personal');
  const [nodes, xhsSearchNodes] = await Promise.all([
    readCentralPageData('/v1/executor-statuses', session, '/executors') as Promise<ExecutorStatus[]>,
    readCentralPageData('/v1/xhs-search-statuses', session, '/executors') as Promise<XhsSearchNodeStatus[]>,
  ]);
  return <>
    <header className="page-header executor-page-header">
      <div>
        <span className="eyebrow">Executor fleet</span>
        <h1 className="sr-only">执行机管理</h1>
        <p className="subtle">查看全部执行机及小红书搜索节点的在线状态、账号状态与任务占用。</p>
      </div>
    </header>
    <ExecutorManager initialNodes={nodes} initialXhsSearchNodes={xhsSearchNodes} />
  </>;
}
