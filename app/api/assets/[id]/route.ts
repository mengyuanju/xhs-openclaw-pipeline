import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { apiHandler } from '../../_lib';
import { ApiError, notFound, parsePositiveId } from '../../../../src/admin/http.mjs';
import { adminAssetRoot, withAdminStore } from '../../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiHandler(request, {}, async () => {
    const id = parsePositiveId((await context.params).id);
    const asset = withAdminStore((store: any) => store.getAsset(id));
    if (!asset) notFound('图片不存在');
    const root = resolve(adminAssetRoot());
    const path = resolve(root, asset.relativePath);
    const relation = relative(root, path);
    if (!relation || relation.startsWith('..')) notFound('图片路径无效');
    let content: Buffer;
    try {
      content = await readFile(path);
    } catch {
      throw new ApiError(404, 'NOT_FOUND', '图片文件不存在');
    }
    const body = Uint8Array.from(content).buffer;
    return new Response(body, {
      headers: {
        'Content-Type': asset.mimeType,
        'Content-Length': String(content.byteLength),
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}
