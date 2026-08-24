import { basename } from 'node:path';

import { apiHandler, ok } from '../_lib';
import { ApiError, assertRequestSize } from '../../../src/admin/http.mjs';
import { screenImportRowsWithOpenClaw } from '../../../src/admin/demand-screening-service.mjs';
import { parseExcelImport } from '../../../src/admin/excel-import.mjs';
import { withAdminStore } from '../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return apiHandler(request, {}, () => {
    const url = new URL(request.url);
    return ok(withAdminStore((store: any) => store.listImportBatches({
      page: url.searchParams.get('page'),
      pageSize: url.searchParams.get('pageSize'),
      status: url.searchParams.get('status') || undefined,
    })));
  });
}

export function POST(request: Request) {
  return apiHandler(request, { mutation: true }, async () => {
    assertRequestSize(request, 6 * 1024 * 1024);
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw new TypeError('请选择 .xlsx 文件');
    if (file.size > 5 * 1024 * 1024) throw new RangeError('Excel 文件不能超过 5 MiB');
    const parsed = await parseExcelImport({
      buffer: Buffer.from(await file.arrayBuffer()),
      fileName: file.name,
    });
    let screenedRows;
    try {
      screenedRows = await screenImportRowsWithOpenClaw({ rows: parsed.rows });
    } catch {
      throw new ApiError(
        502,
        'OPENCLAW_SCREENING_FAILED',
        'OpenClaw 需求检测失败，请检查模型配置或稍后重试',
      );
    }
    const requestedName = String(form.get('name') || '').trim();
    const name = requestedName || basename(file.name, '.xlsx');
    const detail = withAdminStore((store: any) => {
      const batch = store.createImportBatch({ name, sourceFileName: file.name, rows: screenedRows });
      return store.getImportBatch(batch.id);
    });
    if (!detail) throw new ApiError(500, 'IMPORT_CREATE_FAILED', '导入批次创建失败');
    return ok(detail, { status: 201 });
  });
}
