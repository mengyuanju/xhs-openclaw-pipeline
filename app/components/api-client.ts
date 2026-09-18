import { notifyWorkspaceUpdated } from './workspace-updates';

export class ApiRequestError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(`${message}（${code}）`);
    this.name = 'ApiRequestError';
  }
}

export async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined' && window.location.pathname !== '/login') {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/login?next=${encodeURIComponent(next)}`);
      throw new Error('登录已过期，请重新登录');
    }
    const code = typeof payload?.error?.code === 'string' ? payload.error.code : `HTTP_${response.status}`;
    const message = typeof payload?.error?.message === 'string'
      ? payload.error.message : `请求失败（${response.status}）`;
    throw new ApiRequestError(response.status, code, message);
  }
  if (url.startsWith('/api/control-plane/') && !['GET', 'HEAD'].includes((init?.method ?? 'GET').toUpperCase())) notifyWorkspaceUpdated();
  return payload.data as T;
}
