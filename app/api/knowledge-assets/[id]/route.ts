import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { apiHandler } from '../../_lib';
import { ApiError, notFound, parsePositiveId } from '../../../../src/admin/http.mjs';
import { adminKnowledgeRoot, withAdminStore } from '../../../../src/admin/runtime.mjs';
import { controlPlaneUrl } from '../../../../src/control-plane/next-runtime.mjs';
import { knowledgeActorHeaders } from '../../../../src/admin/knowledge-runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiHandler(request, { roles: ['ADMIN', 'REVIEWER'] }, async (session) => {
    const assetId = parsePositiveId((await context.params).id);
    const remoteRoot = controlPlaneUrl();
    if (remoteRoot) {
      const response = await fetch(`${remoteRoot}/v1/knowledge-versions/${assetId}/asset`, {
        headers: knowledgeActorHeaders(session), cache: 'no-store', signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new ApiError(response.status, 'KNOWLEDGE_ASSET_ERROR', '知识库图片读取失败');
      return new Response(response.body, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
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
