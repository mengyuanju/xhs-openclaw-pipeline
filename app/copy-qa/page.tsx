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
        <p className="subtle">进入质检批次查看抽检任务。已通过的任务立即进入生图环节，整批驳回由系统自动判定。</p>
      </div>
    </header>
    <CopyQaWorkbench />
  </>;
}
