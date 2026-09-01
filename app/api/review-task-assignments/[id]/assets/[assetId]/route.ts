import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { apiHandler } from '../../../../_lib';
import { ApiError, notFound, parsePositiveId } from '../../../../../../src/admin/http.mjs';
import { adminAssetRoot, withAdminStore } from '../../../../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; assetId: string }> },
) {
  return apiHandler(request, { roles: ['ADMIN', 'QC_LEAD', 'COPY_REVIEWER'] }, async (session) => {
    const params = await context.params;
    const assignmentId = parsePositiveId(params.id);
    const assetId = parsePositiveId(params.assetId);
    const asset = withAdminStore((store: any) => store.authorizeReviewTaskAsset(session, assignmentId, assetId));
    if (!asset) notFound('图片不存在');
    const root = resolve(adminAssetRoot());
    const path = resolve(root, asset.relativePath);
    const relation = relative(root, path);
    if (!relation || relation.startsWith('..') || isAbsolute(relation)) notFound('图片路径无效');
    let content: Buffer;
    try {
      content = await readFile(path);
    } catch {
      throw new ApiError(404, 'NOT_FOUND', '图片文件不存在');
    }
    return new Response(Uint8Array.from(content).buffer, {
      headers: {
        'Content-Type': asset.mimeType,
        'Content-Length': String(content.byteLength),
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}
