import { z } from 'zod';
import { normalizeImageSettings, normalizePageLayout } from '../../../server/src/image-options.mjs';
import { planningMetadata } from '../../../server/src/planning-catalog.mjs';

export const imageSettingsSchema = z.unknown().transform((value, context) => {
  try { return normalizeImageSettings(value as Record<string, unknown>); }
  catch (error) { context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : '图片配置无效' }); return z.NEVER; }
});
export function validatePageOptions(value: { kind: string; layout?: unknown; pageTypeId?: string; pageType?: unknown; layoutPreset?: unknown }, context: z.RefinementCtx) {
  try { planningMetadata(value); }
  catch (error) { context.addIssue({ code: 'custom', path: ['pageType'], message: error instanceof Error ? error.message : '规划描述无效' }); }
  try { if (value.layout !== undefined) normalizePageLayout(value.layout, value.kind); }
  catch (error) { context.addIssue({ code: 'custom', path: ['layout'], message: error instanceof Error ? error.message : '布局配置无效' }); }
}

export const imagePlanSchema = z.object({
  kind: z.enum(['hero', 'steps', 'checklist', 'comparison', 'detail', 'summary']),
  headline: z.string().trim().min(1).max(18),
  subtitle: z.string().trim().min(1).max(30),
  bullets: z.array(z.string().trim().min(1).max(40)).min(2).max(5),
  prompt: z.string().trim().min(10).max(1_000),
  layout: z.unknown().optional(),
  pageTypeId: z.string().optional(),
  pageType: z.unknown().optional(),
  layoutPreset: z.unknown().optional(),
}).strict().superRefine(validatePageOptions);
