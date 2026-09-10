import { redirect } from 'next/navigation';

import { readServerSession } from '../server-session';
import { QueryPackageWorkbench } from './query-package-workbench';

export const dynamic = 'force-dynamic';

export default async function QueryPackagesPage() {
  const session = await readServerSession();
  if (!session) redirect('/login?next=%2Fquery-packages');
  const role = session.roles?.[0] || 'USER';
  if (!['ADMIN', 'USER'].includes(role)) redirect('/copy-qa');

  return <>
    <header className="page-header">
      <div>
        <span className="eyebrow">Query intake</span>
        <h1>Query 词包</h1>
        <p className="subtle">先集中导入和人工筛选 Query，再将通过项一次性创建为正式作业。</p>
      </div>
    </header>
    <QueryPackageWorkbench role={role as 'ADMIN' | 'USER'} />
  </>;
}
