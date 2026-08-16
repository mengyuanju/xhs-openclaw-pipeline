export async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined' && window.location.pathname !== '/login') {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/login?next=${encodeURIComponent(next)}`);
      throw new Error('登录已过期，请重新登录');
    }
    throw new Error(payload?.error?.message || `请求失败（${response.status}）`);
  }
  return payload.data as T;
}
