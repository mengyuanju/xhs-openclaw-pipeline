import { redirect } from 'next/navigation';

import { canQualityCheckImage } from '../../src/admin/workflow-access.mjs';
import { readServerSession } from '../server-session';
import { ImageQaWorkbench } from './image-qa-workbench';

export const dynamic = 'force-dynamic';

export default async function ImageQaPage() {
  const session = await readServerSession();
  if (!session) redirect('/login?next=%2Fimage-qa');
  const role = session.roles?.[0] || 'USER';
  if (!canQualityCheckImage(session)) redirect('/workbench/personal');
  return <>
    <header className="page-header">
      <div>
        <span className="eyebrow">Image sampling QA</span>
        <h1>图片质检</h1>
        <p className="subtle">处理随机图片抽检和返修后的强制全检。普通作业员只负责自己的图片初审，不进入此质检池。</p>
      </div>
    </header>
    <ImageQaWorkbench role={role as 'ADMIN' | 'REVIEWER'} />
  </>;
}
