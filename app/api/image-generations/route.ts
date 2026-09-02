import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../_lib';
import { ApiError } from '../../../src/admin/http.mjs';
import { adminOutputRoot } from '../../../src/admin/runtime.mjs';
import {
  StandaloneImageConfirmationError,
  assertStandaloneImageConfirmation,
  generateStandaloneImages,
  listStandaloneImageRuns,
} from '../../../src/standalone-image-generation.mjs';
import {
  imageGenerationApiError,
  imageGenerationRuntime,
  withImageGenerationLock,
} from './_runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const imageKindSchema = z.enum([
  'hero',
  'steps',
  'checklist',
  'comparison',
  'detail',
  'summary',
]);

const imagePlanSchema = z.object({
  kind: imageKindSchema,
  headline: z.string().trim().min(1).max(18),
  subtitle: z.string().trim().min(1).max(30),
  bullets: z.array(z.string().trim().min(1).max(40)).min(2).max(5),
  prompt: z.string().trim().min(10).max(1_000),
}).strict();

const imageGenerationSchema = z.object({
  runId: z.string().uuid().optional(),
  query: z.string().trim().min(1).max(500),
  copy: z.object({
    title: z.string().trim().min(1).max(25),
    body: z.string().trim().min(200).max(700),
    tags: z.array(z.string().trim().min(2).max(20).regex(/^#[^#\s]+$/u)).min(3).max(8),
  }).strict(),
  imagePlan: z.array(imagePlanSchema).min(3).max(5),
  mode: z.enum(['MOCK', 'LIVE']),
  confirmation: z.literal('LIVE_IMAGE_COST_ACCEPTED').optional(),
}).strict().superRefine((value, context) => {
  if (value.imagePlan[0]?.kind !== 'hero') {
    context.addIssue({ code: 'custom', path: ['imagePlan', 0, 'kind'], message: '首图必须为 hero' });
  }
  value.imagePlan.slice(1).forEach((plan, index) => {
    if (plan.kind === 'hero') {
      context.addIssue({
        code: 'custom',
        path: ['imagePlan', index + 1, 'kind'],
        message: 'hero 只能用于首图',
      });
    }
    if (plan.kind !== 'checklist' && plan.bullets.some((bullet) => [...bullet].length > 30)) {
      context.addIssue({
        code: 'custom',
        path: ['imagePlan', index + 1, 'bullets'],
        message: '非 checklist 页面每条要点最多 30 字',
      });
    }
  });
});

export async function GET(request: Request) {
  return apiHandler(request, {}, async () => {
    const rawLimit = new URL(request.url).searchParams.get('limit');
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ApiError(400, 'VALIDATION_ERROR', '历史记录数量必须是 1–100 的整数');
    }
    const history = await listStandaloneImageRuns({
      outputRoot: adminOutputRoot(),
      limit,
    });
    return ok(history, {
      headers: { 'Cache-Control': 'no-store' },
    });
  });
}

export function POST(request: Request) {
  return apiHandler(request, { mutation: true }, async () => {
    const input = await parseJson(request, imageGenerationSchema, {
      maxBytes: 64 * 1024,
      validationCode: 'VALIDATION_ERROR',
    });
    try {
      assertStandaloneImageConfirmation(input.mode, input.confirmation);
    } catch (error) {
      if (error instanceof StandaloneImageConfirmationError) {
        throw new ApiError(400, 'LIVE_CONFIRMATION_REQUIRED', 'Live 图片生成必须先确认模型费用');
      }
      throw new ApiError(400, 'VALIDATION_ERROR', 'Mock 模式不接受 Live 费用确认');
    }
    try {
      const result = await withImageGenerationLock(() => generateStandaloneImages({
        source: {
          query: input.query,
          copy: input.copy,
          imagePlan: input.imagePlan,
        },
        mode: input.mode,
        runtime: imageGenerationRuntime({ live: input.mode === 'LIVE' }),
        outputRoot: adminOutputRoot(),
        runId: input.runId,
      }));
      return ok(result, { status: 201 });
    } catch (error) {
      throw imageGenerationApiError(error);
    }
  });
}
