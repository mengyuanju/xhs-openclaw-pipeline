import { redirect } from 'next/navigation';

import { readServerSession } from '../server-session';
import { DeliveryPoolWorkbench } from './delivery-pool-workbench';
import { SharedDeliveryWorkbench } from './shared-delivery-workbench';

export const dynamic = 'force-dynamic';

export default async function DeliveryPoolPage() {
  const session = await readServerSession();
  if (!session) redirect('/login?next=%2Fdelivery-pool');
  const role = session.roles?.[0] || 'USER';
  if (!['ADMIN', 'USER'].includes(role)) redirect('/copy-qa');
  const isAdmin = role === 'ADMIN';
  return <>
    <header className="page-header"><div><span className="eyebrow">Delivery pool</span><h1>{isAdmin ? '交付池' : '我的交付池'}</h1><p className="subtle">{isAdmin
      ? '集中核对、预览和打包已通过门禁的正式内容；测试任务自动隔离。'
      : '查看和下载当前账号负责、且已通过全部质检门禁的内容。'}</p></div></header>
    <SharedDeliveryWorkbench role={role as 'ADMIN' | 'USER'} />
    <details className="panel" style={{ marginTop: 20 }}>
      <summary>图文预览、预览发布与原始批次工具</summary>
      <DeliveryPoolWorkbench role={role as 'ADMIN' | 'USER'} username={session.username ?? ''} />
    </details>
  </>;
}
