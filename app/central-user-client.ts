import 'server-only';

import { redirect } from 'next/navigation';

import { ApiError } from '../src/admin/http.mjs';
import { controlPlaneResponseError } from '../src/control-plane/next-api-error.mjs';
import { controlPlaneUrl } from '../src/control-plane/next-runtime.mjs';
import { sessionActorHeaders } from '../src/control-plane/session-actor-headers.mjs';

export async function readCentralData(path: string, session: any) {
  const root = controlPlaneUrl();
  if (!root) throw new Error('中心服务尚未配置');
  const response = await fetch(`${root}${path}`, {
    headers: sessionActorHeaders(session, {
      username: session.username || 'admin',
      role: session.roles?.[0] || 'USER',
    }),
    cache: 'no-store',
  });
  if (!response.ok) {
    throw await controlPlaneResponseError(response);
  }
  const payload = await response.json().catch(() => null);
  return payload.data;
}

export async function readCentralPageData(path: string, session: any, nextPath: string) {
  try {
    return await readCentralData(path, session);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect(`/login?reauth=1&next=${encodeURIComponent(nextPath)}`);
    }
    throw error;
  }
}
