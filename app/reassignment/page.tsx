import { redirect } from 'next/navigation';
import { readServerSession } from '../server-session';
import { ReassignmentQueue } from './reassignment-queue';
export const dynamic = 'force-dynamic';
export default async function ReassignmentPage() {
  const session = await readServerSession();
  if (!session) redirect('/login');
  if (!session.roles?.includes('ADMIN')) redirect('/workbench/personal');
  return <ReassignmentQueue />;
}
