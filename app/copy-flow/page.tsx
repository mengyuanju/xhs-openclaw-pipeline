import { redirect } from 'next/navigation';
import { readServerSession } from '../server-session';
import { CopyFlowWorkbench } from './copy-flow-workbench';

export const dynamic = 'force-dynamic';

export default async function CopyFlowPage() {
  const session = await readServerSession();
  if (!session) redirect('/login?next=%2Fcopy-flow');
  const role = session.roles?.[0] || 'USER';
  if (role !== 'ADMIN') redirect(role === 'REVIEWER' ? '/copy-qa' : '/workbench/personal');
  return <CopyFlowWorkbench />;
}
