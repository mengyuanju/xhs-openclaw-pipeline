import { apiHandler, ok } from '../_lib';
import { assertRequestSize } from '../../../src/admin/http.mjs';
import { analyzeVisualImage } from '../../../src/admin/visual-knowledge-service.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request) {
  return apiHandler(request, { mutation: true }, async () => {
    assertRequestSize(request, 11 * 1024 * 1024);
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw new TypeError('请选择需要分析的图片');
    if (file.size > 10 * 1024 * 1024) throw new RangeError('图片不能超过 10 MiB');
    const result = await analyzeVisualImage({
      buffer: Buffer.from(await file.arrayBuffer()),
      mimeType: file.type,
      fileName: file.name,
    });
    return ok(result);
  });
}
