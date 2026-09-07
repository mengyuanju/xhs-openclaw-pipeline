import { z } from 'zod';
import { apiHandler, ok, parseJson } from '../../../_lib';
import { adminOutputRoot } from '../../../../../src/admin/runtime.mjs';
import { convertStandaloneImageRun } from '../../../../../src/standalone-image-generation.mjs';
import { imageSettingsSchema } from '../../_image-options';
import { imageGenerationApiError } from '../../_runtime';

export const runtime = 'nodejs';
export function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  return apiHandler(request, { mutation: true }, async () => {
    const { runId } = await context.params;
    const input = await parseJson(request, z.object({ imageSettings: imageSettingsSchema }).strict());
    try { return ok(await convertStandaloneImageRun({ outputRoot: adminOutputRoot(), sourceRunId: runId, imageSettings: input.imageSettings }), { status: 201 }); }
    catch (error) { throw imageGenerationApiError(error); }
  });
}
