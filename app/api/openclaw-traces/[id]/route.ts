import { apiHandler } from '../../_lib';
import { notFound, parsePositiveId } from '../../../../src/admin/http.mjs';
import { adminDatabasePath, adminOpenClawRoot } from '../../../../src/admin/runtime.mjs';
import {
  collectOpenClawCodexTrace,
  OpenClawTraceNotFoundError,
} from '../../../../src/openclaw-trace-export.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiHandler(request, {}, async () => {
    const jobId = parsePositiveId((await context.params).id);
    let report;
    try {
      report = collectOpenClawCodexTrace({
        databasePath: adminDatabasePath(),
        openClawRoot: adminOpenClawRoot(),
        jobId,
      });
    } catch (error) {
      if (error instanceof OpenClawTraceNotFoundError) notFound('链路任务不存在');
      throw error;
    }
    const body = `${JSON.stringify(report, null, 2)}\n`;
    return new Response(body, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(body, 'utf8')),
        'Content-Disposition': `attachment; filename="openclaw-codex-trace-job-${jobId}.json"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}
