import { redirect } from 'next/navigation';
import { workModeKinds } from '../../src/admin/workflow-access.mjs';
import { controlPlaneUrl, executorNodeId } from '../../src/control-plane/next-runtime.mjs';
import { readServerSession } from '../server-session';
import { WorkMode } from './work-mode';
import type { WorkKind } from './types';

export const dynamic = 'force-dynamic';

export default async function WorkModePage() {
  const session = await readServerSession();
  if (!session) redirect('/login?next=%2Fwork-mode');
  const kinds = workModeKinds(session) as WorkKind[];
  if (!kinds.length) redirect('/workbench/personal');
  if (!controlPlaneUrl()) return <div className="panel empty-state">请先配置中心服务连接，然后重启界面服务。</div>;
  return <WorkMode kinds={kinds} role={session.roles?.[0] || 'USER'} nodeId={executorNodeId()}
    username={session.username || 'admin'} accountId={Number(session.userId)} />;
}
