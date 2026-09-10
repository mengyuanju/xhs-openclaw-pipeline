import { ApiError, assertAuthenticatedRequest, assertLocalRequest } from './http.mjs';

const PUBLIC_PATHS = new Set(['/login', '/api/auth/login']);
const PROFILE_PATH = '/profile';
const PASSWORD_CHANGE_API_PATHS = new Set([
  '/api/auth/logout',
  '/api/control-plane/v1/profile',
  '/api/control-plane/v1/profile/password',
]);

function matchesExactPath(pathname, expected) {
  return pathname === expected || pathname === `${expected}/`;
}

function isPasswordChangePath(pathname) {
  return matchesExactPath(pathname, PROFILE_PATH)
    || [...PASSWORD_CHANGE_API_PATHS].some((path) => matchesExactPath(pathname, path));
}

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
    const currentAccount = session.subject === 'admin'
      || session.roles?.some((role) => ['ADMIN', 'REVIEWER', 'USER'].includes(role));
    const location = session.mustChangePassword === true ? PROFILE_PATH : '/workbench/personal';
    return currentAccount ? { type: 'redirect', location } : { type: 'next' };
  }
  if (PUBLIC_PATHS.has(url.pathname)) return { type: 'next' };
  if (session?.mustChangePassword === true) {
    if (isPasswordChangePath(url.pathname)) return { type: 'next' };
    return url.pathname.startsWith('/api/')
      ? { type: 'forbidden' }
      : { type: 'redirect', location: PROFILE_PATH };
  }
  if (session?.subject === 'admin' || session?.roles?.includes('ADMIN')) return { type: 'next' };
  if (session && /^\/workbench\/all\/?$/u.test(url.pathname)) return { type: 'forbidden' };
  if (session?.subject === 'user') {
    const role = session.roles?.[0];
    const alwaysAllowed = url.pathname === '/profile'
      || url.pathname.startsWith('/api/profile')
      || url.pathname === '/api/auth/logout'
      || (['USER', 'REVIEWER'].includes(role) && url.pathname === '/api/workbench-statistics')
      || (['USER', 'REVIEWER'].includes(role) && url.pathname === '/api/human-quality-settings')
      || url.pathname.startsWith('/api/control-plane/');
    if (alwaysAllowed) return { type: 'next' };
    if (role === 'REVIEWER') {
      const allowed = url.pathname === '/'
        || url.pathname === '/workbench'
        || url.pathname.startsWith('/workbench/')
        || url.pathname === '/copy-qa'
        || url.pathname.startsWith('/copy-qa/');
      return allowed ? { type: 'next' } : { type: 'forbidden' };
    }
    if (role === 'USER') {
      const allowed = url.pathname === '/'
        || url.pathname === '/workbench'
        || url.pathname === '/workbench/personal';
      return allowed ? { type: 'next' } : { type: 'forbidden' };
    }
    return { type: 'forbidden' };
  }
  if (url.pathname.startsWith('/api/')) return { type: 'unauthorized' };

  const returnPath = `${url.pathname}${url.search}`;
  return { type: 'redirect', location: `/login?next=${encodeURIComponent(returnPath)}` };
}
