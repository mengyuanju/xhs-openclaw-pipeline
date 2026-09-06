import { redirect } from 'next/navigation';

import { readCentralData } from '../central-user-client';
import { readServerSession } from '../server-session';
import { ExecutorManager, type ExecutorStatus } from './executor-manager';

export const dynamic = 'force-dynamic';

export default async function ExecutorsPage() {
  const session = await readServerSession();
  if (!session) redirect('/login?next=%2Fexecutors');
  if (!session.roles?.includes('ADMIN')) redirect('/workbench/personal');
  const nodes = await readCentralData('/v1/executor-statuses', session) as ExecutorStatus[];
  return <>
    <header className="page-header executor-page-header">
      <div>
        <span className="eyebrow">Executor fleet</span>
        <h1 className="sr-only">执行机管理</h1>
        <p className="subtle">查看全部执行机的在线状态、最后心跳及文案与生图并发占用。</p>
      </div>
    </header>
    <ExecutorManager initialNodes={nodes} />
  </>;
}
