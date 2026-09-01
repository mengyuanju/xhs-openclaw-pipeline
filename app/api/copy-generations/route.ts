import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../_lib';
import {
  CopyGenerationContractError,
  CopyGenerationRejectedError,
  CopyGenerationResearchError,
  CopyGenerationTransportError,
  CopyGenerationUnchangedError,
  generateCopy,
  toCopyGenerationResponse,
} from '../../../src/copy-generation.mjs';
import { ApiError } from '../../../src/admin/http.mjs';
import { withAdminStore } from '../../../src/admin/runtime.mjs';
import { createCopyGenerationClient } from '../../../src/copy-generation-client.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let copyGenerationInProgress = false;

const referenceUrlSchema = z.string().trim().min(1).max(500).refine((value) => {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}, '参考链接必须是无账号密码的 HTTP(S) URL');

const copyGenerationSchema = z.object({
  query: z.string().trim().min(1).max(500),
  input: z.object({
    category: z.string().trim().min(1).max(100).optional(),
    targetAudience: z.string().trim().min(1).max(200).optional(),
    referenceText: z.string().trim().min(1).max(12_000).optional(),
    referenceUrls: z.array(referenceUrlSchema).max(8).optional(),
    metadata: z.record(z.string().max(100), z.unknown()).optional(),
  }).strict().default({}),
  imageCount: z.union([
    z.literal('auto'),
    z.number().int().min(3).max(5),
  ]).default('auto'),
  confirmation: z.literal('LIVE_MODEL_COST_ACCEPTED'),
}).strict();

function copyGenerationRuntime() {
  return withAdminStore((store: any) => {
    const template = store.listPromptTemplates()
      .find((candidate: any) => candidate.kind === 'TEXT_SYSTEM');
    const published = template?.versions
      .find((version: any) => version.status === 'PUBLISHED');
    if (!published?.content) throw new Error('published text system prompt is unavailable');
    return {
      systemPrompt: published.content,
      modelApi: store.getProductionSettings().settings.modelApi,
    };
  });
}

function copyGenerationJobFailureMessage(error: unknown) {
  if (error instanceof CopyGenerationRejectedError
    || error instanceof CopyGenerationResearchError
    || error instanceof CopyGenerationTransportError
    || error instanceof CopyGenerationUnchangedError
    || error instanceof CopyGenerationContractError) {
    return error.message;
  }
  return '文案生成失败，请稍后重试';
}

export function GET(request: Request) {
  return apiHandler(request, {}, () => {
    const url = new URL(request.url);
    const result = withAdminStore((store: any) => ({
      ...store.listStandaloneCopyGenerations({
        page: url.searchParams.get('page'),
        pageSize: url.searchParams.get('pageSize'),
      }),
      jobs: store.listStandaloneCopyGenerationJobs({ limit: 20 }),
    }));
    return ok({
      ...result,
      data: result.data.map(toCopyGenerationResponse),
    });
  });
}

export function POST(request: Request) {
  return apiHandler(request, { mutation: true }, async () => {
    const input = await parseJson(request, copyGenerationSchema, { maxBytes: 32 * 1024 });
    if (copyGenerationInProgress) {
      throw new ApiError(
        409,
        'COPY_GENERATION_IN_PROGRESS',
        '已有文案正在生成，请等待当前请求完成',
      );
    }
    copyGenerationInProgress = true;
    let jobId: number | null = null;
    try {
      const job = withAdminStore((store: any) => store.createStandaloneCopyGenerationJob({
        query: input.query,
      }));
      jobId = job.id;
      const runtime = copyGenerationRuntime();
      const client = createCopyGenerationClient({ modelApi: runtime.modelApi });
      const generated = await generateCopy({
        client,
        task: { query: input.query, input: input.input },
        systemPrompt: runtime.systemPrompt,
        imageCount: input.imageCount,
      });
      const saved = withAdminStore((store: any) => store.saveStandaloneCopyGeneration({
        jobId,
        query: input.query,
        input: input.input,
        requestedImageCount: input.imageCount,
        ...generated,
      }));
      jobId = null;
      return ok(toCopyGenerationResponse(saved), { status: 201 });
    } catch (error) {
      if (jobId !== null) {
        withAdminStore((store: any) => store.failStandaloneCopyGenerationJob(
          jobId,
          copyGenerationJobFailureMessage(error),
        ));
      }
      if (error instanceof CopyGenerationRejectedError) {
        throw new ApiError(
          422,
          error.stage === 'QUERY' ? 'QUERY_REJECTED' : 'TEXT_REJECTED',
          error.message,
          { review: error.review },
        );
      }
      if (error instanceof CopyGenerationResearchError) {
        throw new ApiError(502, 'RESEARCH_FAILED', error.message, {
          research: error.snapshot,
        });
      }
      if (error instanceof CopyGenerationUnchangedError) {
        throw new ApiError(502, 'COPY_REVISION_UNCHANGED', error.message);
      }
      if (error instanceof CopyGenerationTransportError) {
        throw new ApiError(503, 'MODEL_TRANSPORT_FAILED', error.message, {
          stage: error.stage,
        });
      }
      if (error instanceof CopyGenerationContractError) {
        throw new ApiError(502, 'COPY_CONTRACT_FAILED', error.message);
      }
      throw error;
    } finally {
      copyGenerationInProgress = false;
    }
  });
}
