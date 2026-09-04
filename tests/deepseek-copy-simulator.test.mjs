import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDeepSeekResponsesClient,
  DEEPSEEK_SIMULATION_MODEL,
} from '../src/deepseek-responses-client.mjs';
import { executeDeepSeekCopySimulation } from '../src/executor/deepseek-copy-simulator.mjs';

function responsePayload(text) {
  return {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
  };
}

test('DeepSeek simulation client uses the fixed model and server-side web search', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const text = calls.length === 1
      ? '{"decision":"PASS"}'
      : JSON.stringify({
        summary: '检索资料摘要',
        sources: [{
          title: '权威来源',
          url: 'https://example.com/reference',
          snippet: '支持摘要的来源要点',
          siteName: 'Example',
        }],
      });
    return new Response(JSON.stringify(responsePayload(text)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = createDeepSeekResponsesClient({ apiKey: 'test-secret-value', fetchImpl });

  const text = await client.runText({ prompt: 'return JSON' });
  const search = await client.runWebSearch({ query: '测试选题', limit: 3 });

  assert.equal(text.model, DEEPSEEK_SIMULATION_MODEL);
  assert.equal(search.provider, 'deepseek');
  assert.equal(search.result.sources[0].url, 'https://example.com/reference');
  assert.ok(calls.every((call) => call.url === 'https://api.deepseek.com/responses'));
  assert.ok(calls.every((call) => call.body.model === 'deepseek-v4-pro'));
  assert.equal(calls[0].body.tools, undefined);
  assert.deepEqual(calls[1].body.tools, [{ type: 'web_search' }]);
  assert.deepEqual(calls[1].body.tool_choice, { type: 'web_search' });
  assert.ok(calls.every((call) => !call.init.body.includes('test-secret-value')));
});

test('DeepSeek copy simulation reuses the copy contract and completes into manual review', async () => {
  const progress = [];
  let completed;
  const review = { decision: 'PASS', summary: 'Query 可以执行', issues: [] };
  const post = {
    title: '测试标题',
    body: '测试正文',
    tags: ['测试'],
    imagePlan: [{ kind: 'hero', headline: '封面', subtitle: '测试', bullets: ['要点一', '要点二'], prompt: '测试画面' }],
    sources: [],
    expressionReferences: [],
    riskFlags: [],
    fabricatedExperience: false,
    unverifiedClaims: [],
  };
  const controlPlane = {
    updateProgress: async (_executionId, value) => { progress.push(value); },
    completeCopy: async (executionId, result) => {
      completed = { executionId, result };
      return result;
    },
  };
  const claim = {
    execution: {
      id: '8d6ff5da-53ba-4b52-81a7-b0ab94895376',
      snapshot: {
        task: { query: '测试选题', input: {}, requestedImageCount: 'auto' },
        prompts: { TEXT_SYSTEM: { content: '编辑提示词' } },
        knowledge: [],
      },
    },
  };
  const generate = async (options) => {
    await options.onStageChange('QUERY_REVIEW');
    await options.onStageChange('RESEARCH');
    await options.onStageChange('ORIGINAL_GENERATION');
    assert.equal(options.autoReviseOnReject, false);
    assert.equal(options.textReviewEnabled, false);
    return {
      post,
      model: 'deepseek-v4-pro',
      originalPost: post,
      reviewedPost: post,
      originalModel: 'deepseek-v4-pro',
      reviewedModel: 'deepseek-v4-pro',
      revisionAttempted: false,
      researchSnapshot: null,
      timing: null,
      stageReviews: { query: review, originalText: review, reviewedText: review, text: review },
    };
  };

  await executeDeepSeekCopySimulation({
    claim,
    controlPlane,
    client: {},
    generate,
  });

  assert.deepEqual(progress.map((item) => item.progressPercent), [5, 20, 45]);
  assert.ok(progress.every((item) => item.details.simulation === true));
  assert.equal(completed.executionId, claim.execution.id);
  assert.equal(completed.result.original.model, 'deepseek-v4-pro');
  assert.equal(completed.result.generation.reviews.query.source, 'DEEPSEEK_SIMULATION');
  assert.deepEqual(completed.result.simulation, {
    enabled: true,
    provider: 'DEEPSEEK_RESPONSES',
    model: 'deepseek-v4-pro',
  });
});
