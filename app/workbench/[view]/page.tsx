import { notFound, redirect } from 'next/navigation';

import { controlPlaneUrl, executorNodeId } from '../../../src/control-plane/next-runtime.mjs';
import { readServerSession } from '../../server-session';
import { CreationWorkbench } from '../creation-workbench';
import { WORKBENCH_VIEWS } from '../views';

export const dynamic = 'force-dynamic';

export default async function WorkbenchListPage({ params, searchParams }: {
  params: Promise<{ view: string }>; searchParams: Promise<{ createdByUserId?: string; taskId?: string }>;
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
  const initialCreator = typeof search.createdByUserId === 'string' ? search.createdByUserId.slice(0, 128) : '';
  const id = Number(search.taskId);
  const initialTaskId = Number.isSafeInteger(id) && id > 0 ? id : null;

  return <>
    <h1 className="sr-only">{definition.label}</h1>
    {controlPlaneUrl()
      ? <CreationWorkbench
          key={`${definition.key}:${initialCreator}:${initialTaskId ?? ''}`}
          viewKey={definition.key}
          nodeId={executorNodeId()}
          creatorUserId={session.username || 'admin'}
          role={role}
          initialCreator={role === 'ADMIN' ? initialCreator : ''}
          initialTaskId={role === 'ADMIN' ? initialTaskId : null}
        />
      : <div className="panel empty-state">
        请先配置中心服务连接，然后重启界面服务。
      </div>}
  </>;
}
