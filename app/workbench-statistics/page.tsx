import { redirect } from 'next/navigation';
import { readServerSession } from '../server-session';
import { OperatorPerformance } from './operator-performance';

export const dynamic = 'force-dynamic';
export default async function WorkbenchStatisticsPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const session = await readServerSession();
  if (!session) redirect('/login');
  if (!session.roles?.includes('ADMIN')) redirect('/workbench/personal');
  const query=await searchParams;
  const initialFilters=Object.fromEntries(Object.entries(query).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));
  const accountView=initialFilters.view==='accounts' || !!initialFilters.accountId || !!initialFilters.query
    || !!initialFilters.stage || !!initialFilters.batchId || ['PRODUCTION','QA'].includes(initialFilters.activity);
  if(accountView){
    const params=new URLSearchParams();
    for(const key of ['period','from','to','accountId']) if(initialFilters[key]) params.set(key,initialFilters[key]);
    redirect(`/reports/annotation-jobs${params.size?`?${params}`:''}`);
  }
  return <OperatorPerformance initialFilters={initialFilters}/>;
}
