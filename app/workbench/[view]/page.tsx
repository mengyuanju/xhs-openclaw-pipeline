import { notFound, redirect } from 'next/navigation';

import { controlPlaneUrl, executorNodeId } from '../../../src/control-plane/next-runtime.mjs';
import { readServerSession } from '../../server-session';
import { CreationWorkbench } from '../creation-workbench';
import { WORKBENCH_VIEWS } from '../views';

export const dynamic = 'force-dynamic';

export default async function WorkbenchListPage({ params }: { params: Promise<{ view: string }> }) {
  const { view } = await params;
  const definition = WORKBENCH_VIEWS.find((item) => item.href === `/workbench/${view}`);
  if (!definition) notFound();
  const session = await readServerSession();
  if (!session) redirect('/login');

  return <>
    <h1 className="sr-only">{definition.label}</h1>
    {controlPlaneUrl()
      ? <CreationWorkbench key={definition.key} viewKey={definition.key} nodeId={executorNodeId()} creatorUserId={session.subject} />
      : <div className="panel empty-state">
        请先配置中心服务连接，然后重启界面服务。
      </div>}
  </>;
}
