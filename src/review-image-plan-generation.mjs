import { internalPrompt } from './prompt-runtime.mjs';
import { businessPrompt } from './prompt-runtime.mjs';
import { parseDynamicImagePlanOutput, postOutputSchema } from './post-contract.mjs';

const MAX_ATTEMPTS = 2;

function reviewImagePlanSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['imagePlan'],
    properties: {
      imagePlan: postOutputSchema('auto').properties.imagePlan,
    },
  };
}

export function buildReviewImagePlanPrompt(copy, previousError = null) {
  const prompt = businessPrompt('COPY_IMAGE_PLAN_SYSTEM', {
    contract: internalPrompt('INTERNAL_REVIEW_IMAGE_PLAN_OUTPUT'),
    data: {
      title: copy.title,
      body: copy.body,
      tags: copy.tags,
    },
  });
  if (!previousError) return prompt;
  const validationError = String(previousError?.message ?? previousError).replace(/\s+/gu, ' ').slice(0, 500);
  return internalPrompt('INTERNAL_REVIEW_IMAGE_PLAN_RETRY', { slot1: (prompt), slot2: (JSON.stringify({ validationError })) });
}

export class ReviewImagePlanGenerationError extends Error {
  constructor(cause) {
    super('图片文案规划连续两次未通过格式校验，请稍后重试', { cause });
    this.name = 'ReviewImagePlanGenerationError';
    this.code = 'IMAGE_PLAN_GENERATION_FAILED';
  }
}

export async function generateReviewImagePlan({ client, copy }) {
  if (typeof client?.runText !== 'function') throw new TypeError('Model text client is required');
  let lastError;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const generated = await client.runText({
      prompt: buildReviewImagePlanPrompt(copy, attempt === 0 ? null : lastError),
      outputSchema: reviewImagePlanSchema(),
    });
    try {
      return {
        imagePlan: parseDynamicImagePlanOutput(generated.rawText),
        model: generated.model ?? null,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new ReviewImagePlanGenerationError(lastError);
}
