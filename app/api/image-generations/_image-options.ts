import { z } from 'zod';
import { normalizeImageSettings, normalizePageLayout } from '../../../server/src/image-options.mjs';

export const imageSettingsSchema = z.unknown().transform((value, context) => {
  try { return normalizeImageSettings(value as Record<string, unknown>); }
  catch (error) { context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : '图片配置无效' }); return z.NEVER; }
});
export function validatePageOptions(value: { kind: string; layout?: unknown }, context: z.RefinementCtx) {
  if (value.layout === undefined) return;
  try { normalizePageLayout(value.layout, value.kind); }
  catch (error) { context.addIssue({ code: 'custom', path: ['layout'], message: error instanceof Error ? error.message : '布局配置无效' }); }
}
