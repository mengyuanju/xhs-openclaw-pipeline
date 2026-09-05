import { generateCopy, toCopyGenerationResponse } from '../copy-generation.mjs';
import { createDeepSeekResponsesClient } from '../deepseek-responses-client.mjs';

const COPY_PROGRESS = Object.freeze({
  QUERY_REVIEW: 5,
  KNOWLEDGE_MATCH: 12,
  RESEARCH: 20,
  ORIGINAL_GENERATION: 45,
});

function publishedTextPrompt(snapshot) {
  const prompt = snapshot?.prompts?.TEXT_SYSTEM;
  if (!prompt?.content) throw new Error('published TEXT_SYSTEM prompt is unavailable on control plane');
  return prompt.content;
}

function markSimulationReview(review) {
  if (!review || typeof review !== 'object') return review;
  return {
    ...review,
    source: 'DEEPSEEK_SIMULATION',
    summary: `DeepSeek 模拟执行：${String(review.summary ?? '').trim()}`,
  };
}

export async function executeDeepSeekCopySimulation({
  claim,
  controlPlane,
  environment = process.env,
  client = createDeepSeekResponsesClient({ apiKey: environment.DEEPSEEK_API_KEY }),
  generate = generateCopy,
}) {
  const { execution } = claim;
  const snapshot = execution.snapshot;
  const generated = await generate({
    client,
    task: snapshot.task,
    copyKnowledge: snapshot.knowledge ?? [],
    systemPrompt: publishedTextPrompt(snapshot),
    imageCount: snapshot.task.requestedImageCount,
    autoReviseOnReject: false,
    textReviewEnabled: false,
    onStageChange: async (stage, details = {}) => controlPlane.updateProgress(execution.id, {
      stage,
      progressPercent: COPY_PROGRESS[stage] ?? 0,
      message: stage === 'KNOWLEDGE_MATCH' ? 'DeepSeek 模拟执行：正在匹配优秀文案案例' : `DeepSeek 模拟执行文案阶段：${stage}`,
      details: { ...details, simulation: true, provider: 'DEEPSEEK' },
    }),
  });
  const stageReviews = {
    ...generated.stageReviews,
    query: markSimulationReview(generated.stageReviews?.query),
  };
  const result = toCopyGenerationResponse({
    query: snapshot.task.query,
    input: snapshot.task.input,
    requestedImageCount: snapshot.task.requestedImageCount,
    ...generated,
    stageReviews,
  });
  result.simulation = {
    enabled: true,
    provider: 'DEEPSEEK_RESPONSES',
    model: 'deepseek-v4-pro',
  };
  return controlPlane.completeCopy(execution.id, result);
}
