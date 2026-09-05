import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../_lib';
import { withAdminStore } from '../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const modelRefSchema = z.string().trim().min(3).max(200).refine(
  (value) => value.includes('/') && !/\s/u.test(value) && !/^openai-codex\//iu.test(value),
  '模型必须使用 provider/model 格式',
);

const proxyUrlSchema = z.string().trim().min(1).max(500).refine((value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}, '代理必须是无账号密码的 HTTP(S) URL');

const dotsBaseUrlSchema = z.literal('https://note3-prev-api.askdiandian.com');
const dotsModelSchema = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, 'Dots 模型名称格式无效');

const modelApiPatchSchema = z.object({
  agentProvider: z.enum(['CODEX', 'OPENCLAW']).nullable().optional(),
  textModel: modelRefSchema.nullable().optional(),
  screeningModel: modelRefSchema.nullable().optional(),
  reviewModel: modelRefSchema.nullable().optional(),
  visionModel: modelRefSchema.nullable().optional(),
  qualityModel: modelRefSchema.nullable().optional(),
  imageModel: modelRefSchema.nullable().optional(),
  modelProxyUrl: proxyUrlSchema.nullable().optional(),
  imageProxyUrl: proxyUrlSchema.nullable().optional(),
  imageTimeoutMs: z.number().int().min(30_000).max(540_000).nullable().optional(),
  copyGenerationProvider: z.enum(['OPENCLAW', 'DOTS']).nullable().optional(),
  copyGenerationThinking: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).nullable().optional(),
  dotsBaseUrl: dotsBaseUrlSchema.nullable().optional(),
  dotsModel: dotsModelSchema.nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, '至少修改一项模型 API 配置');

const settingsPatchSchema = z.object({
  qualityRepairEnabled: z.boolean().optional(),
  qualityRepairTriggerScore: z.number().int().min(0).max(2).optional(),
  qualityRepairTargetScore: z.number().int().min(1).max(3).optional(),
  qualityRepairMaxAttempts: z.number().int().min(0).max(2).optional(),
  aiDisclosureEnabled: z.boolean().optional(),
  aiDisclosureText: z.string().trim().min(1).max(12).optional(),
  modelApi: modelApiPatchSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, '至少修改一项配置');

export function GET(request: Request) {
  return apiHandler(request, {}, () => ok(
    withAdminStore((store: any) => store.getProductionSettings()),
  ));
}

export async function PATCH(request: Request) {
  return apiHandler(request, { mutation: true }, async () => {
    const patch = await parseJson(request, settingsPatchSchema);
    return ok(withAdminStore((store: any) => store.updateProductionSettings(patch)));
  });
}
