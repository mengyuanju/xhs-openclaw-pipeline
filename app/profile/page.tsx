import { redirect } from 'next/navigation';

import { readCentralData } from '../central-user-client';
import { readServerSession } from '../server-session';
import { ProfileManager } from './profile-manager';

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const session = await readServerSession();
  if (!session) redirect('/login?next=%2Fprofile');
  const user = await readCentralData('/v1/profile', session);
  return <>
    <header className="page-header"><div><span className="eyebrow">My account</span><h1>个人信息</h1><p className="subtle">修改姓名或设置新的登录密码。</p></div></header>
    <ProfileManager user={user} />
  </>;
}
