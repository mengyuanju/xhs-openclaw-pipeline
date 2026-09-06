import { cookies } from 'next/headers';

import {
  ADMIN_SESSION_COOKIE,
  readSessionConfig,
  verifySessionToken,
} from '../src/admin/auth.mjs';

export async function readServerSession(): Promise<any> {
  const config = readSessionConfig();
  if (!config) return null;
  const token = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value;
  const session = token ? verifySessionToken(token, config.sessionSecret) : null;
  return session?.subject === 'admin'
    ? { ...session, roles: ['ADMIN'] }
    : session;
}
