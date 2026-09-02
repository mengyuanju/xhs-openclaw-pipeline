import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../../../_lib';
import { toCopyGenerationResponse } from '../../../../../src/copy-generation.mjs';
import { notFound, parsePositiveId } from '../../../../../src/admin/http.mjs';
import { withAdminStore } from '../../../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const manualReviewSchema = z.object({
  decision: z.literal('APPROVED'),
}).strict();

export function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return apiHandler(request, { mutation: true }, async (session: any) => {
    await parseJson(request, manualReviewSchema, { maxBytes: 1_024 });
    const generationId = parsePositiveId((await context.params).id);
    const reviewedBy = session.subject === 'admin' ? 'admin' : `user:${session.username}`;
    const saved = withAdminStore((store: any) => store.approveStandaloneCopyGeneration(
      generationId,
      { reviewedBy },
    ));
    if (!saved) notFound('文案记录不存在');
    return ok(toCopyGenerationResponse(saved));
  });
}
