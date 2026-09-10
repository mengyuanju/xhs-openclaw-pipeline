import { redirect } from 'next/navigation';

import { readServerSession } from '../server-session';
import { CopyQaWorkbench } from './copy-qa-workbench';

export const dynamic = 'force-dynamic';

export default async function CopyQaPage() {
  const session = await readServerSession();
  if (!session) redirect('/login?next=%2Fcopy-qa');
  const role = session.roles?.[0] || 'USER';
  if (!['ADMIN', 'REVIEWER'].includes(role)) redirect('/workbench/personal');

  return <>
    <header className="page-header">
      <div>
        <span className="eyebrow">Copy sampling QA</span>
        <h1>文案抽检</h1>
        <p className="subtle">独立核对最终人工通过版本；发现错误时默认只打回当前样本。</p>
      </div>
    </header>
    <CopyQaWorkbench role={role as 'ADMIN' | 'REVIEWER'} />
  </>;
}
