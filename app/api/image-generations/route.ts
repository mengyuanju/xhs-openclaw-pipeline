import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../_lib';
import { ApiError } from '../../../src/admin/http.mjs';
import { adminOutputRoot, withAdminStore } from '../../../src/admin/runtime.mjs';
import { createOpenClawClient } from '../../../src/openclaw.mjs';
import {
  StandaloneImageAlignmentError,
  StandaloneImageConfirmationError,
  StandaloneImageGenerationError,
  assertStandaloneImageConfirmation,
  generateStandaloneImages,
} from '../../../src/standalone-image-generation.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let imageGenerationInProgress = false;

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

function imageGenerationRuntime({ live }: { live: boolean }) {
  return withAdminStore((store: any) => {
    const productionSettings = store.getProductionSettings().settings;
    if (!live) return { productionSettings };
    const template = store.listPromptTemplates()
      .find((candidate: any) => candidate.kind === 'IMAGE_SYSTEM');
    const published = template?.versions
      .find((version: any) => version.status === 'PUBLISHED');
    if (!published?.content) {
      throw new StandaloneImageGenerationError('已发布的图片系统提示词不可用');
    }
    const visualReference = store.listVisualKnowledge({ status: 'PUBLISHED', pageSize: 100 }).data
      .filter((item: any) => item.generationTarget === 'MODEL_IMAGE' && item.publishedVersion)
      .sort((left: any, right: any) => (
        right.publishedVersion.qualityScore - left.publishedVersion.qualityScore
      ))[0]?.publishedVersion ?? null;
    return {
      productionSettings,
      imageSystemPrompt: published.content,
      visualReference,
      client: createOpenClawClient({ modelApi: productionSettings.modelApi }),
    };
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
    if (imageGenerationInProgress) {
      throw new ApiError(
        409,
        'IMAGE_GENERATION_IN_PROGRESS',
        '已有独立图片试验正在运行，请等待当前请求完成',
      );
    }
    imageGenerationInProgress = true;
    try {
      const result = await generateStandaloneImages({
        source: {
          query: input.query,
          copy: input.copy,
          imagePlan: input.imagePlan,
        },
        mode: input.mode,
        runtime: imageGenerationRuntime({ live: input.mode === 'LIVE' }),
        outputRoot: adminOutputRoot(),
        runId: input.runId,
      });
      return ok(result, { status: 201 });
    } catch (error) {
      if (error instanceof StandaloneImageAlignmentError) {
        throw new ApiError(422, 'IMAGE_ALIGNMENT_FAILED', error.message);
      }
      if (error instanceof StandaloneImageGenerationError) {
        throw new ApiError(502, 'IMAGE_GENERATION_FAILED', error.message);
      }
      if (error instanceof TypeError || error instanceof RangeError) {
        throw new ApiError(400, 'VALIDATION_ERROR', '图片试验输入不符合生产契约');
      }
      throw error;
    } finally {
      imageGenerationInProgress = false;
    }
  });
}
