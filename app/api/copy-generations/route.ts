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
import { withAdminStore, adminOutputRoot } from '../../../src/admin/runtime.mjs';
import { withPromptExecution } from '../../../src/admin/prompt-execution.mjs';
import { createCopyGenerationClient } from '../../../src/copy-generation-client.mjs';
import { loadPromptConfiguration } from '../_prompt-runtime';

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

const copyBatchSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
}).strict();

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
  autoReviseOnReject: z.boolean().default(false),
  batch: copyBatchSchema.optional(),
  confirmation: z.literal('LIVE_MODEL_COST_ACCEPTED'),
}).strict();


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
    const batchId = url.searchParams.get('batchId');
    if (batchId !== null && !z.string().uuid().safeParse(batchId).success) {
      throw new ApiError(400, 'INVALID_BATCH_ID', '批次 ID 无效');
    }
    const result = withAdminStore((store: any) => ({
      ...store.listStandaloneCopyGenerations({
        page: url.searchParams.get('page'),
        pageSize: url.searchParams.get('pageSize'),
        batchId,
      }),
      jobs: store.listStandaloneCopyGenerationJobs({ limit: 20, batchId }),
      batches: store.listStandaloneCopyGenerationBatches({ limit: 20 }),
    }));
    return ok({
      ...result,
      data: result.data.map(toCopyGenerationResponse),
    });
  });
}

export function POST(request: Request) {
  return apiHandler(request, { mutation: true }, async (session) => {
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
        batch: input.batch,
      }));
      jobId = job.id;
      const runtime = await loadPromptConfiguration(session);
      const client = createCopyGenerationClient({ modelApi: runtime.productionSettings.modelApi });
      const generated = await withPromptExecution({ outputRoot: adminOutputRoot(), configuration: runtime,
        kind: 'COPY', query: input.query }, () => generateCopy({
        client,
        task: { query: input.query, input: input.input },
        systemPrompt: runtime.systemPrompt,
        promptRuntime: runtime.promptRuntime,
        planningCatalog: runtime.productionSettings.planningCatalog,
        copyKnowledge: runtime.knowledge,
        imageCount: input.imageCount,
        autoReviseOnReject: input.autoReviseOnReject,
        textReviewEnabled: Boolean(runtime.promptRuntime),
        onStageChange: (stage) => withAdminStore((store: any) =>
          store.updateStandaloneCopyGenerationJobStage(jobId, stage === 'KNOWLEDGE_MATCH' ? 'ORIGINAL_GENERATION' : stage)),
      }));
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
