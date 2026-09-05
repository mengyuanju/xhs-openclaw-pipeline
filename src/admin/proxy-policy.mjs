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
    const legacyReviewer = session.roles?.some((role) => ['QC_LEAD', 'QUERY_REVIEWER', 'COPY_REVIEWER'].includes(role));
    return { type: 'redirect', location: legacyReviewer ? '/reviews' : '/workbench/personal' };
  }
  if (PUBLIC_PATHS.has(url.pathname)) return { type: 'next' };
  if (session?.subject === 'admin' || session?.roles?.includes('ADMIN')) return { type: 'next' };
  if (session?.subject === 'user') {
    const role = session.roles?.[0];
    const alwaysAllowed = url.pathname === '/profile'
      || url.pathname.startsWith('/api/profile')
      || url.pathname === '/api/auth/logout'
      || url.pathname.startsWith('/api/control-plane/');
    if (alwaysAllowed) return { type: 'next' };
    if (role === 'REVIEWER') {
      const allowed = url.pathname === '/workbench'
        || url.pathname.startsWith('/workbench/')
        || url.pathname === '/knowledge'
        || url.pathname.startsWith('/knowledge/')
        || url.pathname.startsWith('/api/knowledge-')
        || url.pathname.startsWith('/api/copy-knowledge-')
        || url.pathname === '/api/visual-analyses'
        || url.pathname.startsWith('/api/copy-analys');
      return allowed ? { type: 'next' } : { type: 'forbidden' };
    }
    if (role === 'USER') {
      const allowed = url.pathname === '/workbench'
        || url.pathname === '/workbench/personal';
      return allowed ? { type: 'next' } : { type: 'forbidden' };
    }
    // Preserve the legacy review-center accounts until they are migrated.
    const legacyReviewPath = url.pathname === '/reviews'
      || url.pathname.startsWith('/reviews/')
      || url.pathname.startsWith('/api/review-');
    return legacyReviewPath ? { type: 'next' } : { type: 'forbidden' };
  }
  if (url.pathname.startsWith('/api/')) return { type: 'unauthorized' };

  const returnPath = `${url.pathname}${url.search}`;
  return { type: 'redirect', location: `/login?next=${encodeURIComponent(returnPath)}` };
}
