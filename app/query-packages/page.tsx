import { redirect } from 'next/navigation';

import { readServerSession } from '../server-session';
import { QueryPackageWorkbench } from './query-package-workbench';

export const dynamic = 'force-dynamic';

export default async function QueryPackagesPage() {
  const session = await readServerSession();
  if (!session) redirect('/login?next=%2Fquery-packages');
  const role = session.roles?.[0] || 'USER';
  if (role !== 'ADMIN') redirect(role === 'REVIEWER' ? '/copy-qa' : '/workbench/personal');

  return <>
    <header className="page-header">
      <div>
        <span className="eyebrow">Query intake</span>
        <h1>Query 词包</h1>
        <p className="subtle">集中导入并人工筛选 Query；通过的项目会自动创建作业并进入文案生成。</p>
      </div>
    </header>
    <QueryPackageWorkbench />
  </>;
}
