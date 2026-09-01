import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../../../_lib';
import { parsePositiveId } from '../../../../../src/admin/http.mjs';
import { withAdminStore } from '../../../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const stageDecisionSchema = z.object({
  stage: z.enum(['COPY', 'IMAGE']),
  decision: z.enum(['APPROVED', 'REJECTED']),
  reasonCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/)).max(20).default([]),
  note: z.string().trim().max(2_000).default(''),
  expectedVersion: z.number().int().positive(),
}).strict();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiHandler(request, { mutation: true, roles: ['COPY_REVIEWER'] }, async (session) => {
    const assignmentId = parsePositiveId((await context.params).id);
    const input = await parseJson(request, stageDecisionSchema);
    return ok(withAdminStore((store: any) => store.decideReviewTaskStage(session, assignmentId, input)));
  });
}
