import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { LoginForm } from '@/components/login-form';
import { findAdminSessionByTokens, readSessionTokens } from '@/lib/server/auth';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '登录 | 海默信息小红书编辑器',
};

export default async function LoginPage() {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');
  const session = await findAdminSessionByTokens(
    readSessionTokens(cookieHeader),
  );
  if (session) {
    redirect('/');
  }
  return <LoginForm />;
}
