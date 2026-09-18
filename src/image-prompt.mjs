import { internalPrompt } from './prompt-runtime.mjs';
import { businessPrompt, promptRuntimeSnapshot, hasPublishedPrompt } from './prompt-runtime.mjs';
import { fullPageInstructionForLayout } from './layout-contract.mjs';
import { imageControlsPrompt } from './image-layout-controls.mjs';
import { DELIVERY_IMAGE_WIDTH, DELIVERY_IMAGE_HEIGHT, GENERATION_IMAGE_WIDTH, GENERATION_IMAGE_HEIGHT } from './image-output-contract.mjs';

export function buildGovernedImageTaskPrompt({ post, plan, visualPage, imageIndex, imageCount, variables = {}, complianceDisclosure = 'AI生成' }) {
  if (!Number.isInteger(imageIndex) || imageIndex < 1 || imageIndex > imageCount) throw new RangeError('imageIndex must be within the delivery image range');
  const data = { title: post.title, body: post.body, pageIndex: imageIndex, imageCount,
    page: visualPage, originalVisualDirection: plan.prompt,
    systemDisclosure: complianceDisclosure || null };
  const disclosureRule = complianceDisclosure
    ? internalPrompt('INTERNAL_IMAGE_DISCLOSURE_OVERLAY', { slot1: (complianceDisclosure) })
    : internalPrompt('INTERNAL_IMAGE_NO_DISCLOSURE');
  const contract = internalPrompt('INTERNAL_IMAGE_PAGE_OUTPUT', { slot1: (disclosureRule), slot2: (GENERATION_IMAGE_WIDTH), slot3: (GENERATION_IMAGE_HEIGHT), slot4: (DELIVERY_IMAGE_WIDTH), slot5: (DELIVERY_IMAGE_HEIGHT), slot6: (fullPageInstructionForLayout(visualPage.layoutTemplate, visualPage.catalogTemplate)) });
  const prompt = promptRuntimeSnapshot() || hasPublishedPrompt('IMAGE_SYSTEM') ? businessPrompt('IMAGE_SYSTEM', { contract, data, variables })
    : `<program_contract>\n${contract}\n</program_contract>\n<untrusted_task_data>\n${JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')}\n</untrusted_task_data>`;
  return prompt + imageControlsPrompt(post, plan);
}

export function preserveImageSystemPrompt(content) {
  // The managed IMAGE_SYSTEM is composed with the page by buildGovernedImageTaskPrompt.
  return promptRuntimeSnapshot() || hasPublishedPrompt('IMAGE_SYSTEM') ? '' : String(content ?? '');
}
