import 'server-only';

import { controlPlaneUrl } from '../src/control-plane/next-runtime.mjs';

export async function readCentralData(path: string, session: any) {
  const root = controlPlaneUrl();
  if (!root) throw new Error('中心服务尚未配置');
  const response = await fetch(`${root}${path}`, {
    headers: {
      'X-Actor-Username': session.username || 'admin',
      'X-Actor-Role': session.roles?.[0] || 'USER',
      'X-Actor-Credential-Version': String(session.credentialVersion || 1),
    },
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || '中心服务请求失败');
  return payload.data;
}
