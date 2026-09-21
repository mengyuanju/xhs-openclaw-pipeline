import { redirect } from 'next/navigation';

import { readServerSession } from '../server-session';
import { CopyQaWorkbench } from './copy-qa-workbench';

export const dynamic = 'force-dynamic';

export default async function CopyQaPage() {
  const session = await readServerSession();
  if (!session) redirect('/login?next=%2Fcopy-qa');
  const role = session.roles?.[0] || 'USER';
  if (!['ADMIN', 'REVIEWER', 'USER'].includes(role)) redirect('/workbench/personal');

  return <>
    <header className="page-header">
      <div>
        <span className="eyebrow">Copy sampling QA</span>
        <h1>文案质检</h1>
        <p className="subtle">一次抽检与返工强制复检分开显示；返工版本必须通过强制复检，才会解除待生图门禁。</p>
      </div>
    </header>
    <CopyQaWorkbench role={role as 'ADMIN' | 'REVIEWER' | 'USER'} />
  </>;
}
