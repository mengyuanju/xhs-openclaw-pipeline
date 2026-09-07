import { businessPrompt, promptRuntimeSnapshot } from './prompt-runtime.mjs';
import { fullPageInstructionForLayout } from './layout-contract.mjs';
import { imageControlsPrompt } from './image-layout-controls.mjs';
import { DELIVERY_IMAGE_WIDTH, DELIVERY_IMAGE_HEIGHT, GENERATION_IMAGE_WIDTH, GENERATION_IMAGE_HEIGHT } from './image-output-contract.mjs';

export function buildGovernedImageTaskPrompt({ post, plan, visualPage, imageIndex, imageCount, variables = {}, complianceDisclosure = 'AI生成' }) {
  if (!Number.isInteger(imageIndex) || imageIndex < 1 || imageIndex > imageCount) throw new RangeError('imageIndex must be within the delivery image range');
  const data = { title: post.title, body: post.body, pageIndex: imageIndex, imageCount,
    page: visualPage, originalVisualDirection: plan.prompt, requiredDisclosure: complianceDisclosure || null };
  const contract = `使用原文案锁定的 allowedVisibleText，逐字显示 headline、subtitle、bullets、labels，不得增删、改写、翻译、编号或移动到其他页。合规标识为独立必需文字：${complianceDisclosure || '关闭，不添加'}。来源与正文用于事实核对，不得照搬其他正文段落上图。生成一张严格竖版3:4、宽${GENERATION_IMAGE_WIDTH}×高${GENERATION_IMAGE_HEIGHT}像素的完整图文PNG，生图时即按此画布构图，不得依靠裁剪、拉伸或补边凑比例。${DELIVERY_IMAGE_WIDTH}×${DELIVERY_IMAGE_HEIGHT}是程序后续等比缩小的交付尺寸，不是模型生成尺寸。${fullPageInstructionForLayout(visualPage.layoutTemplate, visualPage.catalogTemplate)}`;
  const prompt = promptRuntimeSnapshot() ? businessPrompt('IMAGE_SYSTEM', { contract, data, variables })
    : `<program_contract>\n${contract}\n</program_contract>\n<untrusted_task_data>\n${JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')}\n</untrusted_task_data>`;
  return prompt + imageControlsPrompt(post, plan);
}

export function preserveImageSystemPrompt(content) {
  // The managed IMAGE_SYSTEM is composed with the page by buildGovernedImageTaskPrompt.
  return promptRuntimeSnapshot() ? '' : String(content ?? '');
}
