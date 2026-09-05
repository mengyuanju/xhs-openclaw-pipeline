import { redirect } from 'next/navigation';

import { readServerSession } from '../server-session';
import { readCentralData } from '../central-user-client';
import { UserManager } from './user-manager';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const session = await readServerSession();
  if (!session) redirect('/login?next=%2Fusers');
  if (!session.roles?.includes('ADMIN')) redirect('/workbench/personal');
  const users = await readCentralData('/v1/users', session);
  return <>
    <header className="page-header">
      <div><span className="eyebrow">Access management</span><h1>用户管理</h1><p className="subtle">创建账号、设置姓名和固定角色。新账号的默认密码均为 123456。</p></div>
    </header>
    <UserManager initialUsers={users} currentUsername={session.username || session.subject} />
  </>;
}
