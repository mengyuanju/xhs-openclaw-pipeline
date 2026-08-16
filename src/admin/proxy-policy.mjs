import { ApiError, assertAuthenticatedRequest, assertLocalRequest } from './http.mjs';

const PUBLIC_PATHS = new Set(['/login', '/api/auth/login']);

export function evaluateAdminProxyRequest(request, environment = process.env) {
  const url = new URL(request.url);
  try {
    assertLocalRequest(request, { allowedHosts: environment.XHS_ALLOWED_HOSTS });
  } catch (error) {
    if (error instanceof ApiError) return { type: 'forbidden' };
    throw error;
  }

  let isAuthenticated = false;
  try {
    assertAuthenticatedRequest(request, environment);
    isAuthenticated = true;
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'AUTH_REQUIRED') throw error;
  }

  if (url.pathname === '/login' && isAuthenticated) {
    return { type: 'redirect', location: '/' };
  }
  if (PUBLIC_PATHS.has(url.pathname)) return { type: 'next' };
  if (isAuthenticated) return { type: 'next' };
  if (url.pathname.startsWith('/api/')) return { type: 'unauthorized' };

  const returnPath = `${url.pathname}${url.search}`;
  return { type: 'redirect', location: `/login?next=${encodeURIComponent(returnPath)}` };
}
