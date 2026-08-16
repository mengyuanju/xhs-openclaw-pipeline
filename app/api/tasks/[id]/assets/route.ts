import { apiHandler, ok } from '../../../_lib';
import { saveUploadedImage } from '../../../../../src/admin/asset-service.mjs';
import { assertRequestSize, parsePositiveId } from '../../../../../src/admin/http.mjs';
import { adminAssetRoot, withAdminStore } from '../../../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiHandler(request, { mutation: true }, async () => {
    assertRequestSize(request, 11 * 1024 * 1024);
    const taskId = parsePositiveId((await context.params).id);
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw new TypeError('请选择图片文件');
    if (file.size > 10 * 1024 * 1024) throw new RangeError('图片不能超过 10 MiB');
    const buffer = Buffer.from(await file.arrayBuffer());
    const asset = await withAdminStore((store: any) => saveUploadedImage({
      store,
      taskId,
      buffer,
      fileName: file.name,
      mimeType: file.type,
      uploadRoot: adminAssetRoot(),
    }));
    return ok(asset, { status: 201 });
  });
}
