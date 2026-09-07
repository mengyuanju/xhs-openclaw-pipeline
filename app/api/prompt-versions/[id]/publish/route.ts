import { apiHandler, ok } from '../../../_lib';
import { parsePositiveId } from '../../../../../src/admin/http.mjs';
import { withAdminStore } from '../../../../../src/admin/runtime.mjs';
import { assertPromptPublishable } from '../../../../../src/admin/prompt-preview.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiHandler(request, { mutation: true }, async () => {
    const id = parsePositiveId((await context.params).id);
    return ok(withAdminStore((store: any) => {
      const template = store.listPromptTemplates().find((item: any) => item.versions.some((version: any) => version.id === id));
      const version = template?.versions.find((item: any) => item.id === id);
      if (version) assertPromptPublishable(template.kind, version.content);
      return store.publishPromptVersion(id);
    }));
  });
}
