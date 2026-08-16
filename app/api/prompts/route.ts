import { apiHandler, ok } from '../_lib';
import { withAdminStore } from '../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return apiHandler(request, {}, () => ok(withAdminStore((store: any) => store.listPromptTemplates())));
}
