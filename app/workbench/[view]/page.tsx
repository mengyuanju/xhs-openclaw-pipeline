import { notFound, redirect } from 'next/navigation';

import { controlPlaneUrl, executorNodeId } from '../../../src/control-plane/next-runtime.mjs';
import { readServerSession } from '../../server-session';
import { CreationWorkbench } from '../creation-workbench';
import { parseWorkbenchListState } from '../list-state';
import { WORKBENCH_VIEWS } from '../views';

export const dynamic = 'force-dynamic';

export default async function WorkbenchListPage({ params, searchParams }: {
  params: Promise<{ view: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { view } = await params;
  const definition = WORKBENCH_VIEWS.find((item) => item.href === `/workbench/${view}`);
  if (!definition) notFound();
  const session = await readServerSession();
  if (!session) redirect('/login');
  const role = session.roles?.[0] || 'USER';
  if (definition.adminOnly && role !== 'ADMIN') redirect('/workbench/personal');
  if (role === 'USER' && definition.key !== 'PERSONAL') redirect('/workbench/personal');
  const search = await searchParams;
  const initialListState = parseWorkbenchListState(search, { allowAdminFilters: role === 'ADMIN' });
  const personalStates = new Set(['ALL', 'queued', 'running', 'copyReview', 'imageReview', 'failed', 'completed', 'cancelled']);
  if (definition.key === 'PERSONAL' && !personalStates.has(initialListState.state)) initialListState.state = 'ALL';
  if (definition.key === 'ALL_JOBS' && !new Set<string>(['ALL', ...definition.states]).has(initialListState.state)) initialListState.state = 'ALL';
  if (definition.key !== 'PERSONAL' && definition.key !== 'ALL_JOBS') initialListState.state = 'ALL';
  if (definition.key !== 'ALL_JOBS') initialListState.attention = 'NONE';

  return <>
    <h1 className="sr-only">{definition.label}</h1>
    {controlPlaneUrl()
      ? <CreationWorkbench
          key={definition.key}
          viewKey={definition.key}
          nodeId={executorNodeId()}
          creatorUserId={session.username || 'admin'}
          creatorAccountId={Number(session.userId)}
          role={role}
          initialListState={initialListState}
        />
      : <div className="panel empty-state">
        请先配置中心服务连接，然后重启界面服务。
      </div>}
  </>;
}
