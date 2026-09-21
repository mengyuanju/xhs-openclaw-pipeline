import { redirect } from 'next/navigation';
import { readServerSession } from '../../server-session';
import { PersonalStatisticsDashboard } from './personal-statistics-dashboard';

export const dynamic = 'force-dynamic';
export default async function PersonalStatisticsPage() {
  const session = await readServerSession();
  if (!session) redirect('/login');
  return <PersonalStatisticsDashboard canDeliver={session.roles?.[0] === 'USER'} />;
}
