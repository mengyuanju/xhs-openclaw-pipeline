import { ApiError } from '../../../src/admin/http.mjs';
import { withAdminStore } from '../../../src/admin/runtime.mjs';
import { createOpenClawClient } from '../../../src/openclaw.mjs';
import {
  StandaloneImageAlignmentError,
  StandaloneImageCancellationError,
  StandaloneImageGenerationError,
} from '../../../src/standalone-image-generation.mjs';

type ActiveImageGeneration = { runId: string; controller: AbortController };
type ImageGenerationState = { active: ActiveImageGeneration | null };
const runtimeState = globalThis as typeof globalThis & {
  __xhsStandaloneImageGenerationState?: ImageGenerationState;
};
const imageGenerationState = runtimeState.__xhsStandaloneImageGenerationState ??= { active: null };

export function imageGenerationRuntime() {
  return withAdminStore((store: any) => {
    const productionSettings = store.getProductionSettings().settings;
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

export async function withImageGenerationLock<T>(
  runId: string,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (imageGenerationState.active) {
    throw new ApiError(
      409,
      'IMAGE_GENERATION_IN_PROGRESS',
      '已有独立图片试验正在运行，请等待当前请求完成',
    );
  }
  const controller = new AbortController();
  imageGenerationState.active = { runId, controller };
  try {
    return await action(controller.signal);
  } finally {
    if (imageGenerationState.active?.controller === controller) imageGenerationState.active = null;
  }
}

export function cancelActiveImageGeneration(runId: string): boolean {
  if (imageGenerationState.active?.runId !== runId) return false;
  imageGenerationState.active.controller.abort(new StandaloneImageCancellationError());
  return true;
}

export function imageGenerationApiError(error: unknown): Error {
  if (error instanceof StandaloneImageCancellationError) {
    return new ApiError(409, error.code, error.message);
  }
  if (error instanceof StandaloneImageAlignmentError) {
    if (error.code === 'ALIGNMENT_RESPONSE_INVALID') {
      return new ApiError(502, 'IMAGE_ALIGNMENT_RESPONSE_INVALID', error.message);
    }
    if (error.code === 'ALIGNMENT_SERVICE_FAILED') {
      return new ApiError(502, 'IMAGE_ALIGNMENT_SERVICE_FAILED', error.message);
    }
    return new ApiError(422, 'IMAGE_ALIGNMENT_FAILED', error.message);
  }
  if (error instanceof StandaloneImageGenerationError) {
    return new ApiError(502, 'IMAGE_GENERATION_FAILED', error.message);
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return new ApiError(400, 'VALIDATION_ERROR', '图片试验输入不符合生产契约');
  }
  return error instanceof Error ? error : new Error('unknown image generation failure');
}
