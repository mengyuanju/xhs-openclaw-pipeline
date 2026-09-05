import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  ADMIN_SESSION_COOKIE,
  readSessionConfig,
  verifySessionToken,
} from '../src/admin/auth.mjs';
import { ApiError } from '../src/admin/http.mjs';
import { withAdminStore } from '../src/admin/runtime.mjs';

export async function readServerSession(): Promise<any> {
  const config = readSessionConfig();
  if (!config) return null;
  const token = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value;
  const session = token ? verifySessionToken(token, config.sessionSecret) : null;
  return session?.subject === 'admin'
    ? { ...session, roles: ['ADMIN'] }
    : session;
}

export function withAuthorizedReviewStore<T>(
  session: any,
  callback: (store: any, actor: any) => T,
): T {
  try {
    return withAdminStore((store: any) => callback(store, store.resolveReviewActor(session))) as T;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect('/login?reauth=1&next=%2Freviews');
    }
    throw error;
  }
}
