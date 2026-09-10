import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { PreviewManager } from '@/components/preview-manager';
import { findAdminSessionByTokens, readSessionTokens } from '@/lib/server/auth';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');
  const session = await findAdminSessionByTokens(
    readSessionTokens(cookieHeader),
  );
  if (!session) {
    redirect('/login');
  }
  return <PreviewManager username={session.username} />;
}
