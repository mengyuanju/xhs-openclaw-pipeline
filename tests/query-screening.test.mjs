import test from 'node:test';
import assert from 'node:assert/strict';
import { createPromptRuntime, defaultBusinessPrompt, normalizePromptPolicy, withPromptRuntime } from '../src/prompt-runtime.mjs';
import { PROMPT_CATALOG, promptTemplatesForEditing } from '../src/prompt-catalog.mjs';
import { runQueryReview, isReusableStageReview, queryReviewSubject } from '../src/content-stage-review.mjs';
import { generateCopy, toCopyGenerationResponse } from '../src/copy-generation.mjs';
import { createMockPost } from '../src/pipeline.mjs';
import { createAdminStore } from '../src/admin/admin-store.mjs';
import { readPromptConfiguration, savePromptPolicy } from '../src/admin/prompt-runtime-service.mjs';
import { executeCopyClaim } from '../src/executor/agent.mjs';

const task = { query: '租房桌面怎么低成本整理？', input: {} };
const rejection = { schemaVersion: 1, decision: 'REJECT', summary: '不满足管理员选题规则',
  issues: [{ code: 'QUERY_NOT_ADMITTED', severity: 'BLOCKING', message: '不属于本次允许的选题范围' }] };
const runtime = (queryReviewEnabled) => createPromptRuntime({ settings: { queryReviewEnabled },
  prompts: Object.fromEntries(PROMPT_CATALOG.filter(({ kind }) => kind !== 'QUERY_REVIEW_SYSTEM')
    .map(({ kind }) => [kind, { content: defaultBusinessPrompt(kind), versionId: 1 }])) });

test('new settings default to visual planning on and Query screening off while preserving saved switches', () => {
  assert.equal(normalizePromptPolicy({}).visualPlanningEnabled, true);
  assert.equal(normalizePromptPolicy({}).queryReviewEnabled, false);
  assert.equal(normalizePromptPolicy({ visualPlanningEnabled: false }).visualPlanningEnabled, false);
  assert.equal(normalizePromptPolicy({ visualPlanningEnabled: false }).queryReviewEnabled, false);
  assert.equal(normalizePromptPolicy({ queryReviewEnabled: true }).queryReviewEnabled, true);
  assert.equal(normalizePromptPolicy({ queryReviewEnabled: false }).queryReviewEnabled, false);
  for (const queryReviewEnabled of ['false', 0, null]) {
    assert.throws(() => normalizePromptPolicy({ queryReviewEnabled }), /queryReviewEnabled/);
  }
});

test('disabled Query screening needs no published reviewer and records a skip without model use', async () => {
  const result = await withPromptRuntime(runtime(false), () => runQueryReview({ task,
    client: { runReview() { assert.fail('disabled Query screening must not spend model quota'); } } }));
  assert.equal(result.skipped, true);
  assert.equal(result.source, 'DISABLED');
  assert.equal(result.model, null);
  assert.equal(result.stage, 'QUERY');
  assert.match(result.summary, /已关闭.*未.*审核/);
  assert.equal(isReusableStageReview(result, { stage: 'QUERY', subject: queryReviewSubject(task) }), false,
    'a skipped review must not become a real passed review when the switch is enabled later');
});

test('enabled Query screening sends the exact published rules and still stops rejected generation', async () => {
  const content = '管理员自定义 Query 规则：只接收租房收纳选题。';
  const promptRuntime = createPromptRuntime({ settings: { queryReviewEnabled: true }, prompts: { QUERY_REVIEW_SYSTEM: { content, versionId: 42 } } });
  let reviewed = 0;
  await assert.rejects(generateCopy({ task, promptRuntime, textReviewEnabled: false, client: {
    async runReview({ prompt }) { reviewed += 1; assert.ok(prompt.includes(content));
      return { rawText: JSON.stringify(rejection), model: 'fake-review' }; },
    runWebSearch() { assert.fail('rejected queries must stop before research'); },
    runText() { assert.fail('rejected queries must stop before generation'); },
  } }), (error) => error.name === 'CopyGenerationRejectedError');
  assert.equal(reviewed, 1);
});

test('disabled Query screening continues research and generation with zero review time', async () => {
  const stages = [];
  let researched = false;
  const post = createMockPost(3);
  const generated = await generateCopy({ task, promptRuntime: runtime(false), textReviewEnabled: false,
    onStageChange: (stage) => stages.push(stage), client: {
      runReview() { assert.fail('disabled reviewers must not run'); },
      async runWebSearch({ query, provider }) { researched = true; return { provider, result: {
        content: `${query} 的公开资料`, results: [{ title: '整理资料', url: 'https://example.com/reference', snippet: '收纳步骤' }],
      } }; },
      async runText() { return { rawText: JSON.stringify(post), model: 'fake-text' }; },
    } });
  assert.equal(researched, true);
  assert.ok(!stages.includes('QUERY_REVIEW'));
  assert.ok(stages.includes('ORIGINAL_GENERATION'));
  assert.equal(generated.stageReviews.query.skipped, true);
  assert.equal(generated.timing.queryReviewMs, 0);
  const response = toCopyGenerationResponse(generated);
  assert.equal(response.generation.reviews.query.skipped, true);
  assert.equal(response.copy.body, post.body);
});

test('missing center Query template remains editable as an unpublished candidate without overwriting existing rules', () => {
  const existing = { id: 8, kind: 'TEXT_SYSTEM', name: '人工文案', versions: [{ id: 9, content: '保留人工原文' }] };
  const catalog = PROMPT_CATALOG.map((item) => ({ ...item, candidate: defaultBusinessPrompt(item.kind) }));
  const templates = promptTemplatesForEditing([existing], catalog);
  assert.equal(templates.find(({ kind }) => kind === 'TEXT_SYSTEM'), existing);
  const query = templates.find(({ kind }) => kind === 'QUERY_REVIEW_SYSTEM');
  assert.equal(query.id, null);
  assert.deepEqual(query.versions, []);
  assert.equal(query.candidate, defaultBusinessPrompt('QUERY_REVIEW_SYSTEM'));
  assert.ok(query.candidate.length > 20);
});

test('policy saves while Query rules are unpublished only when screening is off, and pins old executions', async () => {
  const store = createAdminStore(':memory:');
  try {
    for (const template of store.listPromptTemplates()) {
      if (template.kind !== 'QUERY_REVIEW_SYSTEM' && template.versions[0].status === 'DRAFT') {
        store.publishPromptVersion(template.versions[0].id);
      }
    }
    await savePromptPolicy({ queryReviewEnabled: false }, { store });
    const snapshot = (await readPromptConfiguration({ store })).promptRuntime;
    assert.equal(snapshot.settings.queryReviewEnabled, false);
    await assert.rejects(savePromptPolicy({ queryReviewEnabled: true }, { store }), /Query|选题/);
    const queryTemplate = store.listPromptTemplates().find(({ kind }) => kind === 'QUERY_REVIEW_SYSTEM');
    const edited = store.createPromptVersion({ templateId: queryTemplate.id, content: '只接受具体的整理需求，其他拒绝。' });
    store.publishPromptVersion(edited.id);
    await savePromptPolicy({ queryReviewEnabled: true }, { store });
    const current = (await readPromptConfiguration({ store })).promptRuntime;
    assert.equal(current.settings.queryReviewEnabled, true);
    assert.equal(current.prompts.QUERY_REVIEW_SYSTEM.content, '只接受具体的整理需求，其他拒绝。');
    assert.equal(snapshot.settings.queryReviewEnabled, false);
    assert.equal(snapshot.prompts.QUERY_REVIEW_SYSTEM, undefined);
  } finally { store.close(); }
});

test('the center executor honors the frozen Query switch and completes the copy with skipped evidence', async () => {
  const frozen = runtime(false);
  const stages = [];
  const snapshot = { task, knowledge: [], prompts: frozen.prompts,
    productionSettings: { production: { value: {} }, prompt_runtime: { value: frozen.settings } } };
  const response = await executeCopyClaim({ claim: { execution: { id: 'query-test', snapshot } },
    controlPlane: {
      updateProgress: async (_id, progress) => stages.push(progress.stage),
      completeCopy: async (_id, result) => result,
    }, client: {
      runReview() { assert.fail('the center executor must respect the frozen disabled policy'); },
      async runWebSearch({ provider }) { return { provider, result: { content: '整理步骤资料',
        results: [{ title: '整理资料', url: 'https://example.com/reference', snippet: '收纳步骤' }] } }; },
      async runText() { return { rawText: JSON.stringify(createMockPost(3)), model: 'fake-text' }; },
    } });
  assert.equal(response.generation.reviews.query.skipped, true);
  assert.equal(response.generation.timing.queryReviewMs, 0);
  assert.ok(!stages.includes('QUERY_REVIEW'));
  assert.ok(response.copy.body.length > 0);
});

test('center settings missing the Query switch use the new disabled default in both editor and execution', async () => {
  const config = await readPromptConfiguration({ controlPlane: {
    listPrompts: async () => [], listKnowledge: async () => [],
    listSettings: async () => [{ key: 'prompt_runtime', value: { visualPlanningEnabled: false } }],
  } });
  assert.equal(config.settings.queryReviewEnabled, false);
  assert.equal(config.promptRuntime.settings.queryReviewEnabled, false);
  assert.equal(config.settings.visualPlanningEnabled, false);
});
