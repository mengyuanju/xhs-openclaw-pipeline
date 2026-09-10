import {
  auditAuthAction,
  expireSessionCookies,
  getAdminSessionFromRequest,
  logoutAdmin,
} from '@/lib/server/auth';
import {
  assertSameOrigin,
  errorResponse,
  jsonResponse,
} from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    assertSameOrigin(request, { requireOrigin: true });
    const actor = await getAdminSessionFromRequest(request);
    await logoutAdmin(request);
    if (actor) {
      await auditAuthAction({
        actor,
        action: 'auth.logout',
        outcome: 'success',
      });
    }
    const response = jsonResponse({ loggedOut: true });
    for (const cookie of expireSessionCookies(request)) {
      response.headers.append('Set-Cookie', cookie);
    }
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
