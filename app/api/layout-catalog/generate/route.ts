import { z } from 'zod';
import { apiHandler, ok, parseJson } from '../../_lib';
import { withAdminStore, adminOutputRoot } from '../../../../src/admin/runtime.mjs';
import { readPromptConfiguration } from '../../../../src/admin/prompt-runtime-service.mjs';
import { generateAndImportLayouts } from '../../../../src/admin/layout-catalog-service.mjs';
import { ApiError } from '../../../../src/admin/http.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: Request) {
  return apiHandler(request, { mutation: true }, async () => {
    const input = await parseJson(request, z.object({ brief: z.string().trim().min(1).max(2000), expectedRevision: z.string().length(64) }).strict());
    try {
      return ok(await withAdminStore(async (store: any) => generateAndImportLayouts({ input, outputRoot: adminOutputRoot(),
        configuration: await readPromptConfiguration({ store }), readCatalog: () => store.getLayoutCatalog(), updateCatalog: (change: any, options: any) => store.updateLayoutCatalog(change, options) })));
    } catch (error: any) { if (error.code === 'CATALOG_CONFLICT') throw new ApiError(409, error.code, error.message); throw error; }
  });
}
