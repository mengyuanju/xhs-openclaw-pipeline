import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../_lib';
import { withAdminStore } from '../../../src/admin/runtime.mjs';
import { readWebSearchSettings, updateWebSearchSettings } from '../../../src/admin/web-search-settings-service.mjs';
import { createControlPlaneClient } from '../../../src/control-plane/client.mjs';
import { controlPlaneUrl } from '../../../src/control-plane/next-runtime.mjs';
import { forwardControlPlaneRequest } from '../../../src/control-plane/next-api-error.mjs';
import { sessionActorHeaders } from '../../../src/control-plane/session-actor-headers.mjs';
import { DEEPSEEK_MODEL_ID_PATTERN } from '../../../src/web-search-config.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  webSearchProvider: z.enum(['CODEX', 'DEEPSEEK', 'DOUBAO']).nullable().optional(),
  webSearchProviderOrder: z.array(z.enum(['DOUBAO', 'DEEPSEEK', 'CODEX']))
    .min(1).max(3).refine((providers) => new Set(providers).size === providers.length,
      '搜索服务不能重复').nullable().optional(),
  deepseekSearchModel: z.string().trim().min(1).max(128)
    .regex(DEEPSEEK_MODEL_ID_PATTERN, 'DeepSeek 模型 ID 格式无效').nullable().optional(),
  webSearchTimeoutMs: z.number().int().min(5_000).max(120_000).nullable().optional(),
  webSearchResultLimit: z.number().int().min(1).max(10).nullable().optional(),
  doubaoIcpHostOnly: z.boolean().nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, '至少修改一项搜索配置');

type SearchPatch = z.infer<typeof patchSchema>;

async function settingsRequest(session: any, patch?: SearchPatch) {
  const baseUrl = controlPlaneUrl();
  if (baseUrl) {
    const options = { controlPlane: createControlPlaneClient({
      baseUrl,
      headers: sessionActorHeaders(session),
    }) };
    return forwardControlPlaneRequest(() => patch
      ? updateWebSearchSettings(options, patch)
      : readWebSearchSettings(options));
  }
  return withAdminStore((store: any) => patch
    ? updateWebSearchSettings({ store }, patch)
    : readWebSearchSettings({ store }));
}

export function GET(request: Request) {
  return apiHandler(request, {}, async (session) => ok(await settingsRequest(session)));
}

export function PATCH(request: Request) {
  return apiHandler(request, { mutation: true }, async (session) => ok(
    await settingsRequest(session, await parseJson(request, patchSchema)),
  ));
}
