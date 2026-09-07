import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../../../_lib';
import { ApiError } from '../../../../../src/admin/http.mjs';
import { adminOutputRoot } from '../../../../../src/admin/runtime.mjs';
import {
  StandaloneImageRecoveryError,
  retryStandaloneImageRun,
  readStandaloneImagePromptRuntime,
} from '../../../../../src/standalone-image-generation.mjs';
import {
  imageGenerationApiError,
  imageGenerationRuntime,
  withImageGenerationLock,
} from '../../_runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const retrySchema = z.object({
  runId: z.string().uuid(),
  confirmation: z.literal('LIVE_IMAGE_COST_ACCEPTED'),
}).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  return apiHandler(request, { mutation: true }, async (session) => {
    const input = await parseJson(request, retrySchema, {
      maxBytes: 4 * 1024,
      validationCode: 'VALIDATION_ERROR',
    });
    const { runId } = await context.params;
    try {
      const runtime = await imageGenerationRuntime(session);
      runtime.promptRuntime = await readStandaloneImagePromptRuntime(adminOutputRoot(), runId);
      const result = await withImageGenerationLock(input.runId, (signal) => withPromptExecution({ outputRoot: adminOutputRoot(),
        configuration: runtime, kind: 'IMAGE_RETRY', query: runId }, () => retryStandaloneImageRun({
        sourceRunId: runId,
        runId: input.runId,
        runtime,
        outputRoot: adminOutputRoot(),
        signal,
      })));
      return ok(result, { status: 201 });
    } catch (error) {
      if (error instanceof StandaloneImageRecoveryError) {
        throw new ApiError(409, error.code, error.message);
      }
      throw imageGenerationApiError(error);
    }
  });
}
import { withPromptExecution } from '../../../../../src/admin/prompt-execution.mjs';
