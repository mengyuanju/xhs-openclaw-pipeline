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

  let session = null;
  try {
    session = assertAuthenticatedRequest(request, environment);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'AUTH_REQUIRED') throw error;
  }

  if (url.pathname === '/login' && session && url.searchParams.get('reauth') !== '1') {
    return { type: 'redirect', location: session.subject === 'admin' ? '/' : '/reviews' };
  }
  if (PUBLIC_PATHS.has(url.pathname)) return { type: 'next' };
  if (session?.subject === 'admin') return { type: 'next' };
  if (session?.subject === 'user') {
    const isReviewPath = url.pathname === '/reviews'
      || url.pathname.startsWith('/reviews/')
      || url.pathname.startsWith('/api/review-work-items')
      || url.pathname.startsWith('/api/review-task-assignments')
      || url.pathname.startsWith('/api/review-users')
      || url.pathname === '/api/auth/logout';
    return isReviewPath ? { type: 'next' } : { type: 'forbidden' };
  }
  if (url.pathname.startsWith('/api/')) return { type: 'unauthorized' };

  const returnPath = `${url.pathname}${url.search}`;
  return { type: 'redirect', location: `/login?next=${encodeURIComponent(returnPath)}` };
}
