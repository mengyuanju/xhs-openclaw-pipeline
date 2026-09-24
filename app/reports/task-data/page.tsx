import { redirect } from 'next/navigation';
import { readServerSession } from '../../server-session';
import { TaskDataReport } from './task-data-report';

export const dynamic = 'force-dynamic';

export default async function TaskDataReportPage() {
  const session = await readServerSession();
  if (!session) redirect('/login?next=%2Freports%2Ftask-data');
  if (!session.roles?.includes('ADMIN')) redirect('/workbench/personal');
  return <TaskDataReport />;
}
