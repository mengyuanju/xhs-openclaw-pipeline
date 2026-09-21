import { redirect } from 'next/navigation';

import { readServerSession } from '../server-session';
import { readCentralPageData } from '../central-user-client';
import { AutoAssignmentPoolManager } from './auto-assignment-pool-manager';
import { UserManager } from './user-manager';
import { UserManagementWorkspace } from './user-management-workspace';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const session = await readServerSession();
  if (!session) redirect('/login?next=%2Fusers');
  if (!session.roles?.includes('ADMIN')) redirect('/workbench/personal');
  const [users, autoAssignment] = await Promise.all([
    readCentralPageData('/v1/users', session, '/users'),
    readCentralPageData('/v1/auto-assignment', session, '/users'),
  ]);
  const autoAssignableTasks = typeof autoAssignment.autoAssignableTaskCount === 'number'
    ? autoAssignment.autoAssignableTaskCount
    : autoAssignment.unassignedTaskCount;
  const overview = {
    totalUsers: users.length,
    activeUsers: users.filter((user: { status: string }) => user.status === 'ACTIVE').length,
    autoAssignableTasks,
    availableWorkers: autoAssignment.workers.filter((worker: { canReceive: boolean }) => worker.canReceive).length,
    poolMembers: autoAssignment.workers.length,
    assignmentEnabled: autoAssignment.settings.enabled,
  };
  return <>
    <header className="page-header">
      <div><span className="eyebrow">Access management</span><h1>用户管理</h1><p className="subtle">集中管理账号权限与任务分配。新账号的默认密码为 123456。</p></div>
    </header>
    <UserManagementWorkspace
      overview={overview}
      accountManager={<UserManager initialUsers={users} currentUsername={session.username || session.subject} />}
      assignmentManager={<AutoAssignmentPoolManager users={users} initialSnapshot={autoAssignment} />}
    />
  </>;
}
