import { redirect } from 'next/navigation';

import { readServerSession } from '../server-session';
import { readCentralPageData } from '../central-user-client';
import { AutoAssignmentPoolManager } from './auto-assignment-pool-manager';
import { UserManager } from './user-manager';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const session = await readServerSession();
  if (!session) redirect('/login?next=%2Fusers');
  if (!session.roles?.includes('ADMIN')) redirect('/workbench/personal');
  const [users, autoAssignment] = await Promise.all([
    readCentralPageData('/v1/users', session, '/users'),
    readCentralPageData('/v1/auto-assignment', session, '/users'),
  ]);
  return <>
    <header className="page-header">
      <div><span className="eyebrow">Access management</span><h1>用户管理</h1><p className="subtle">创建账号、设置姓名和固定角色。新账号的默认密码均为 123456。</p></div>
    </header>
    <div className="user-management-stack">
      <UserManager initialUsers={users} currentUsername={session.username || session.subject} />
      <AutoAssignmentPoolManager users={users} initialSnapshot={autoAssignment} />
    </div>
  </>;
}
