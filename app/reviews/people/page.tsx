import Link from 'next/link';
import { redirect } from 'next/navigation';

import { withAdminStore } from '../../../src/admin/runtime.mjs';
import { readServerSession } from '../../server-session';
import { ReviewPeopleManager } from './review-people-manager';

export const dynamic = 'force-dynamic';

export default async function ReviewPeoplePage() {
  const session = await readServerSession();
  if (!session) redirect('/login?next=%2Freviews%2Fpeople');
  if (!session.roles?.includes('ADMIN')) redirect('/reviews');
  const users = withAdminStore((store: any) => store.listReviewUsers(session).data) as any[];

  return <>
    <header className="page-header">
      <div><span className="eyebrow">Access management</span><h1>质检人员</h1><p className="subtle">创建独立账号并按 Query、内容质检（文案+图片）或组长职责授权；停用账号会使旧会话失效。</p></div>
      <Link className="button" href="/reviews">返回质检中心</Link>
    </header>
    <ReviewPeopleManager users={users} />
  </>;
}
