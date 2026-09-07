import { z } from 'zod';
import { apiHandler, ok, parseJson } from '../_lib';
import { withAdminStore } from '../../../src/admin/runtime.mjs';
import { ApiError } from '../../../src/admin/http.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return apiHandler(request, {}, () => ok(withAdminStore((store: any) => store.getLayoutCatalog())));
}
export function POST(request: Request) {
  return apiHandler(request, { mutation: true }, async () => {
    const input = await parseJson(request, z.object({ operation: z.enum(['BUILTIN', 'IMPORT', 'REPLACE']), expectedRevision: z.string().length(64), templates: z.array(z.unknown()).optional(), catalog: z.unknown().optional() }).strict(), { maxBytes: 1_000_000 });
    try { return ok(withAdminStore((store: any) => store.updateLayoutCatalog(input))); }
    catch (error: any) { if (error.code === 'CATALOG_CONFLICT') throw new ApiError(409, error.code, error.message); throw error; }
  });
}
