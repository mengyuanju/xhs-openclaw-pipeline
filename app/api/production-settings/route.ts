import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../_lib';
import { withAdminStore } from '../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const settingsPatchSchema = z.object({
  qualityRepairEnabled: z.boolean().optional(),
  qualityRepairTriggerScore: z.number().int().min(0).max(2).optional(),
  qualityRepairTargetScore: z.number().int().min(1).max(3).optional(),
  qualityRepairMaxAttempts: z.number().int().min(0).max(2).optional(),
  aiDisclosureEnabled: z.boolean().optional(),
  aiDisclosureText: z.string().trim().min(1).max(12).optional(),
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
