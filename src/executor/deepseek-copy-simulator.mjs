import { generateCopy, toCopyGenerationResponse } from '../copy-generation.mjs';
import { createDeepSeekResponsesClient } from '../deepseek-responses-client.mjs';

const COPY_PROGRESS = Object.freeze({
  QUERY_REVIEW: 5,
  RESEARCH: 20,
  ORIGINAL_GENERATION: 45,
});

function publishedTextPrompt(snapshot) {
  const prompt = snapshot?.prompts?.TEXT_SYSTEM;
  if (!prompt?.content) throw new Error('published TEXT_SYSTEM prompt is unavailable on control plane');
  return prompt.content;
}

function taskWithKnowledge(task, snapshot) {
  const knowledge = (snapshot?.knowledge ?? [])
    .filter((item) => item.kind === 'COPY')
    .map((item) => {
      if (typeof item.content === 'string') return item.content;
      if (typeof item.content?.text === 'string') return item.content.text;
      if (typeof item.content?.summary === 'string') return item.content.summary;
      return '';
    })
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 8_000);
  if (!knowledge) return task;
  const existing = String(task.input?.referenceText ?? '').trim();
  return {
    ...task,
    input: {
      ...task.input,
      referenceText: [existing, `中心知识库：\n${knowledge}`].filter(Boolean).join('\n\n').slice(0, 12_000),
    },
  };
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
  const sourceTask = taskWithKnowledge(snapshot.task, snapshot);
  const generated = await generate({
    client,
    task: sourceTask,
    systemPrompt: publishedTextPrompt(snapshot),
    imageCount: snapshot.task.requestedImageCount,
    autoReviseOnReject: false,
    textReviewEnabled: false,
    onStageChange: async (stage) => controlPlane.updateProgress(execution.id, {
      stage,
      progressPercent: COPY_PROGRESS[stage] ?? 0,
      message: `DeepSeek 模拟执行文案阶段：${stage}`,
      details: { simulation: true, provider: 'DEEPSEEK' },
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
