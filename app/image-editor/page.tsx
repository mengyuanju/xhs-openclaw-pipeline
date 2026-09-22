import { redirect } from 'next/navigation';
import { readServerSession } from '../server-session';
import { ImageEditorWorkbench } from './workbench';
export const dynamic = 'force-dynamic';
export default async function ImageEditorPage() {
  const session=await readServerSession();
  if(!session)redirect('/login?next=%2Fimage-editor');
  if(!['ADMIN','USER'].includes(session.roles?.[0]??''))redirect('/workbench/personal');
  return <ImageEditorWorkbench />;
}
