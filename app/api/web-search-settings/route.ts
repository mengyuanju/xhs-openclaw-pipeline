import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../_lib';
import { withAdminStore } from '../../../src/admin/runtime.mjs';
import { readWebSearchSettings, updateWebSearchSettings } from '../../../src/admin/web-search-settings-service.mjs';
import { createControlPlaneClient } from '../../../src/control-plane/client.mjs';
import { controlPlaneUrl } from '../../../src/control-plane/next-runtime.mjs';
import { forwardControlPlaneRequest } from '../../../src/control-plane/next-api-error.mjs';
import { sessionActorHeaders } from '../../../src/control-plane/session-actor-headers.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  webSearchProvider: z.enum(['OPENCLAW', 'DEEPSEEK']).nullable().optional(),
  deepseekSearchModel: z.enum(['deepseek-v4-pro', 'deepseek-v4-flash']).nullable().optional(),
  webSearchTimeoutMs: z.number().int().min(5_000).max(120_000).nullable().optional(),
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
