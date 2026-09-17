import { redirect } from 'next/navigation';

import { readServerSession } from '../server-session';
import { DeliveryPoolWorkbench } from './delivery-pool-workbench';

export const dynamic = 'force-dynamic';

export default async function DeliveryPoolPage() {
  const session = await readServerSession();
  if (!session) redirect('/login?next=%2Fdelivery-pool');
  const role = session.roles?.[0] || 'USER';
  if (role !== 'ADMIN') redirect(role === 'REVIEWER' ? '/copy-qa' : '/workbench/personal');
  return <>
    <header className="page-header"><div><span className="eyebrow">Delivery pool</span><h1>交付池</h1><p className="subtle">集中核对、预览和打包已通过门禁的正式内容；测试任务自动隔离。</p></div></header>
    <DeliveryPoolWorkbench role="ADMIN" />
  </>;
}
