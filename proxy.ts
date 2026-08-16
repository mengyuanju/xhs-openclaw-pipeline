import { NextResponse, type NextRequest } from 'next/server';

import { evaluateAdminProxyRequest } from './src/admin/proxy-policy.mjs';

export function proxy(request: NextRequest) {
  const decision = evaluateAdminProxyRequest(request);
  if (decision.type === 'next') return NextResponse.next();
  if (decision.type === 'redirect' && typeof decision.location === 'string') {
    return NextResponse.redirect(new URL(decision.location, request.url));
  }
  if (decision.type === 'unauthorized') {
    return Response.json({
      error: { code: 'AUTH_REQUIRED', message: 'Please sign in to continue' },
    }, { status: 401 });
  }
  return new Response('Forbidden', {
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
