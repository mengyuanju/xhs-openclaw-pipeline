import { redirect } from 'next/navigation';
import { readServerSession } from '../../server-session';
import { AnnotationJobReport } from './report';

export const dynamic = 'force-dynamic';

export default async function AnnotationJobReportPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const session = await readServerSession();
  if (!session) redirect('/login?next=%2Freports%2Fannotation-jobs');
  if (!session.roles?.includes('ADMIN')) redirect('/workbench/personal');
  const query=await searchParams;
  const today=new Date(Date.now()+8*3_600_000).toISOString().slice(0,10);
  const span=query.period==='7d'?6:query.period==='30d'?29:0;
  let from=new Date(Date.parse(`${today}T00:00:00Z`)-span*86_400_000).toISOString().slice(0,10);
  let to=today;
  const validDay=(value:unknown):value is string=>typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
  if(validDay(query.from)&&validDay(query.to)) {
    const days=(Date.parse(query.to)-Date.parse(query.from))/86_400_000+1;
    if(Number.isFinite(days)&&days>=1&&days<=366){from=query.from;to=query.to;}
  }
  const accountId=typeof query.accountId==='string'&&/^[1-9]\d*$/u.test(query.accountId)
    && Number.isSafeInteger(Number(query.accountId))?query.accountId:'';
  return <AnnotationJobReport initialFilters={{from,to,accountId}} />;
}
