import { redirect } from 'next/navigation';

import { readServerSession } from '../server-session';
import { DeliveryPoolWorkbench } from './delivery-pool-workbench';

export const dynamic = 'force-dynamic';

export default async function DeliveryPoolPage() {
  const session = await readServerSession();
  if (!session) redirect('/login?next=%2Fdelivery-pool');
  const role = session.roles?.[0] || 'USER';
  if (!['ADMIN', 'USER'].includes(role)) redirect('/copy-qa');
  return <>
    <header className="page-header"><div><span className="eyebrow">Delivery pool</span><h1>交付池</h1><p className="subtle">仅展示图文终审通过且版本绑定交付条目为 READY 的任务。</p></div></header>
    <DeliveryPoolWorkbench role={role as 'ADMIN' | 'USER'} />
  </>;
}
