import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { apiHandler } from '../../_lib';
import { ApiError, notFound, parsePositiveId } from '../../../../src/admin/http.mjs';
import { adminKnowledgeRoot, withAdminStore } from '../../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiHandler(request, {}, async () => {
    const assetId = parsePositiveId((await context.params).id);
    const asset = withAdminStore((store: any) => store.getVisualKnowledgeAsset(assetId));
    if (!asset) notFound('知识库图片不存在');
    const root = resolve(adminKnowledgeRoot());
    const path = resolve(root, asset.relativePath);
    const relation = relative(root, path);
    if (!relation || relation.startsWith('..')) notFound('知识库图片路径无效');
    let content: Buffer;
    try {
      content = await readFile(path);
    } catch {
      throw new ApiError(404, 'NOT_FOUND', '知识库图片文件不存在');
    }
    return new Response(Uint8Array.from(content).buffer, {
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': String(content.byteLength),
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}
