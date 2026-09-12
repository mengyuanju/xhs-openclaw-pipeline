import { generateCopy, toCopyGenerationResponse } from '../copy-generation.mjs';
import { createDeepSeekResponsesClient } from '../deepseek-responses-client.mjs';
import { promptRuntimeFromSnapshot } from '../admin/prompt-runtime-service.mjs';
import { guardExecutionCalls } from './execution-signal.mjs';

const COPY_PROGRESS = Object.freeze({
  QUERY_REVIEW: 5,
  KNOWLEDGE_MATCH: 12,
  RESEARCH: 20,
  ORIGINAL_GENERATION: 45,
  COPY_LENGTH_REPAIR: 55,
  COPY_CONTRACT_REPAIR: 55,
});
const COPY_STAGE_MESSAGES = Object.freeze({
  KNOWLEDGE_MATCH: '正在匹配优秀文案案例',
  COPY_LENGTH_REPAIR: '首稿长度未通过，正在仅修复正文',
  COPY_CONTRACT_REPAIR: '首稿格式未通过，正在修复失败字段',
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
  signal,
}) {
  const { execution } = claim;
  const snapshot = execution.snapshot;
  const generated = await generate({
    client: signal ? guardExecutionCalls(client, signal, { model: true }) : client,
    promptRuntime: promptRuntimeFromSnapshot(snapshot),
    task: snapshot.task,
    copyKnowledge: snapshot.knowledge ?? [],
    systemPrompt: publishedTextPrompt(snapshot),
    imageCount: snapshot.task.requestedImageCount,
    autoReviseOnReject: false,
    textReviewEnabled: Boolean(promptRuntimeFromSnapshot(snapshot)),
    onStageChange: async (stage, details = {}) => controlPlane.updateProgress(execution.id, {
      stage,
      progressPercent: COPY_PROGRESS[stage] ?? 0,
      message: `DeepSeek 模拟执行：${COPY_STAGE_MESSAGES[stage] ?? `正在执行文案阶段：${stage}`}`,
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
