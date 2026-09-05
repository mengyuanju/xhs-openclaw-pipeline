import { z } from 'zod';

import { apiHandler, parseJson } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  sourceCopy: z.string().trim().min(1).max(20_000),
  analysisPrompt: z.string().trim().min(1).max(8_000),
}).strict();

export async function POST(request: Request) {
  return apiHandler(request, { mutation: true, roles: ['ADMIN', 'REVIEWER'] }, async () => {
    await parseJson(request, bodySchema, { maxBytes: 128 * 1024 });
    return new Response(null, {
      status: 308,
      headers: { Location: '/api/control-plane/v1/copy-knowledge/analyze' },
    });
  });
}
