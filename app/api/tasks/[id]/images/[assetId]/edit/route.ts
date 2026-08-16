import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../../../../../_lib';
import { createImageRevision } from '../../../../../../../src/admin/asset-service.mjs';
import { parsePositiveId } from '../../../../../../../src/admin/http.mjs';
import { adminAssetRoot, withAdminStore } from '../../../../../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const operationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rotate'), degrees: z.union([z.literal(90), z.literal(180), z.literal(270)]) }).strict(),
  z.object({ type: z.literal('crop-3x4') }).strict(),
  z.object({ type: z.literal('ai-edit'), instruction: z.string().trim().min(1).max(1_000) }).strict(),
]);

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; assetId: string }> },
) {
  return apiHandler(request, { mutation: true }, async () => {
    const params = await context.params;
    const taskId = parsePositiveId(params.id);
    const assetId = parsePositiveId(params.assetId);
    const operation = await parseJson(request, operationSchema);
    if (operation.type === 'ai-edit') {
      const editRequest = withAdminStore((store: any) => store.createImageEditRequest(taskId, {
        sourceAssetId: assetId,
        instruction: operation.instruction,
      }));
      return ok(editRequest, { status: 202 });
    }
    const asset = await withAdminStore((store: any) => createImageRevision({
      store,
      taskId,
      assetId,
      operation,
      uploadRoot: adminAssetRoot(),
    }));
    return ok(asset, { status: 201 });
  });
}
