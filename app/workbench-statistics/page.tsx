import { redirect } from 'next/navigation';
import { readServerSession } from '../server-session';
import { AdminStatistics } from './admin-statistics';

export const dynamic = 'force-dynamic';
export default async function WorkbenchStatisticsPage() {
  const session = await readServerSession();
  if (!session) redirect('/login');
  if (!session.roles?.includes('ADMIN')) redirect('/workbench/personal');
  return <AdminStatistics />;
}
