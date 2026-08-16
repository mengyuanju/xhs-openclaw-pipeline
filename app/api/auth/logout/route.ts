import { apiHandler } from '../../_lib';
import { serializeAdminSessionCookie } from '../../../../src/admin/auth.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request) {
  return apiHandler(request, { mutation: true }, () => {
    const response = Response.json({ data: { authenticated: false } });
    response.headers.set('cache-control', 'no-store');
    response.headers.set('set-cookie', serializeAdminSessionCookie('', {
      clear: true,
      secure: new URL(request.url).protocol === 'https:',
    }));
    return response;
  });
}
