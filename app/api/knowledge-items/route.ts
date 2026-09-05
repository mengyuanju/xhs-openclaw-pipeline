import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../_lib';
import { ApiError, assertRequestSize } from '../../../src/admin/http.mjs';
import { adminKnowledgeRoot } from '../../../src/admin/runtime.mjs';
import { withKnowledgeStore } from '../../../src/admin/knowledge-runtime.mjs';
import { createVisualKnowledgeWithOptionalImage } from '../../../src/admin/visual-knowledge-service.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const itemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(['PHOTO_HERO', 'STEP_GUIDE', 'CHECKLIST', 'COMPARISON', 'TIMELINE', 'TRAVEL_GUIDE', 'EMOTION_STORY', 'PRODUCT_DISPLAY']),
  generationTarget: z.enum(['MODEL_IMAGE', 'LOCAL_CARD']),
  retentionMode: z.enum(['PROMPT_ONLY', 'IMAGE_AND_PROMPT']),
  rightsStatus: z.enum(['SELF_OWNED', 'LICENSED', 'INTERNAL_ANALYSIS_ONLY', 'UNKNOWN']),
  sourceImageSha256: z.string().regex(/^[a-f0-9]{64}$/).or(z.literal('')).optional(),
  promptTemplate: z.string().trim().min(1).max(2_000),
  negativePrompt: z.string().trim().max(600).default(''),
  styleTags: z.array(z.string().trim().min(1).max(50)).max(20),
  categories: z.array(z.string().trim().min(1).max(50)).max(20),
  layoutRules: z.record(z.string(), z.unknown()),
  qualityScore: z.number().min(1).max(5),
  analysisModel: z.string().trim().max(200).default(''),
}).strict();

function validateFormJson(value: FormDataEntryValue | null) {
  if (typeof value !== 'string') throw new TypeError('缺少视觉配方数据');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError('视觉配方 JSON 无法解析');
  }
  const result = itemSchema.safeParse(parsed);
  if (!result.success) {
    throw new ApiError(400, 'INVALID_INPUT', '视觉配方数据无效', result.error.issues);
  }
  return result.data;
}

export function GET(request: Request) {
  return apiHandler(request, { roles: ['ADMIN', 'REVIEWER'] }, async () => {
    const url = new URL(request.url);
    return ok(await withKnowledgeStore((store: any) => store.listVisualKnowledge({
      page: url.searchParams.get('page'),
      pageSize: url.searchParams.get('pageSize'),
      status: url.searchParams.get('status') || undefined,
      type: url.searchParams.get('type') || undefined,
      query: url.searchParams.get('query') || undefined,
    })));
  });
}

export function POST(request: Request) {
  return apiHandler(request, { mutation: true, roles: ['ADMIN', 'REVIEWER'] }, async () => {
    const contentType = request.headers.get('content-type')?.toLowerCase() || '';
    if (contentType.startsWith('application/json')) {
      const input = await parseJson(request, itemSchema);
      const created = await withKnowledgeStore((store: any) => createVisualKnowledgeWithOptionalImage({
        store,
        knowledgeRoot: adminKnowledgeRoot(),
        input,
      }));
      return ok(created, { status: 201 });
    }
    if (!contentType.startsWith('multipart/form-data')) {
      throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '请求必须使用 JSON 或 multipart/form-data');
    }
    assertRequestSize(request, 11 * 1024 * 1024);
    const form = await request.formData();
    const input = validateFormJson(form.get('data'));
    const file = form.get('file');
    if (!(file instanceof File)) throw new TypeError('保留图片模式必须选择图片');
    if (file.size > 10 * 1024 * 1024) throw new RangeError('图片不能超过 10 MiB');
    const buffer = Buffer.from(await file.arrayBuffer());
    const created = await withKnowledgeStore((store: any) => createVisualKnowledgeWithOptionalImage({
      store,
      knowledgeRoot: adminKnowledgeRoot(),
      input,
      buffer,
      mimeType: file.type,
    }));
    return ok(created, { status: 201 });
  });
}
