import { readFile } from 'node:fs/promises';

export const DEFAULT_PRODUCTION_SETTINGS = Object.freeze({
  qualityRepairEnabled: true,
  qualityRepairTriggerScore: 1,
  qualityRepairTargetScore: 2,
  qualityRepairMaxAttempts: 2,
  aiDisclosureEnabled: true,
  aiDisclosureText: 'AI生成',
  modelApi: Object.freeze({
    webSearchProvider: null,
    deepseekSearchModel: null,
    webSearchTimeoutMs: null,
    textModel: null,
    screeningModel: null,
    reviewModel: null,
    visionModel: null,
    qualityModel: null,
    imageModel: null,
    modelProxyUrl: null,
    imageProxyUrl: null,
    imageTimeoutMs: null,
    copyGenerationProvider: null,
    copyGenerationThinking: null,
    dotsBaseUrl: null,
    dotsModel: null,
  }),
});

const PROMPT_DEFINITIONS = Object.freeze([
  ['xiaohongshu-text', '小红书文案系统提示词', 'TEXT_SYSTEM', 'text-system.md'],
  ['xiaohongshu-image', '小红书配图系统提示词', 'IMAGE_SYSTEM', 'image-system.md'],
  ['xiaohongshu-image-edit', '小红书图片编辑系统提示词', 'IMAGE_EDIT_SYSTEM', 'image-edit-system.md'],
]);

export async function loadDefaultPrompts() {
  return Promise.all(PROMPT_DEFINITIONS.map(async ([slug, name, kind, filename]) => ({
    slug,
    name,
    kind,
    content: (await readFile(new URL(`../prompts/${filename}`, import.meta.url), 'utf8')).trim(),
  })));
}
