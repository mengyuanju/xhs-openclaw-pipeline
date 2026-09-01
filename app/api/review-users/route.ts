import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../_lib';
import { hashAdminPassword } from '../../../src/admin/auth.mjs';
import { withAdminStore } from '../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const roleSchema = z.enum(['QC_LEAD', 'QUERY_REVIEWER', 'COPY_REVIEWER']);
const createUserSchema = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,49}$/),
  displayName: z.string().trim().min(1).max(80),
  password: z.string().min(12).max(1_024),
  roles: z.array(roleSchema).min(1).max(3),
}).strict();

export function GET(request: Request) {
  return apiHandler(request, { roles: ['ADMIN', 'QC_LEAD'] }, (session) => {
    const search = new URL(request.url).searchParams;
    return ok(withAdminStore((store: any) => store.listReviewUsers(session, {
      status: search.get('status') || undefined,
      page: search.get('page') || 1,
      pageSize: search.get('pageSize') || 100,
    })));
  });
}

export async function POST(request: Request) {
  return apiHandler(request, { mutation: true, roles: ['ADMIN'] }, async (session) => {
    const input = await parseJson(request, createUserSchema);
    const passwordHash = await hashAdminPassword(input.password);
    const user = withAdminStore((store: any) => store.createReviewUser(session, {
      username: input.username,
      displayName: input.displayName,
      passwordHash,
      roles: input.roles,
    }));
    return ok(user, { status: 201 });
  });
}
