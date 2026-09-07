import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminStore } from '../src/admin/admin-store.mjs';
import { preparePromptDrafts, readPromptConfiguration, savePromptPolicy } from '../src/admin/prompt-runtime-service.mjs';
import { PROMPT_CATALOG } from '../src/prompt-catalog.mjs';

test('activation requires published stages and never publishes candidates implicitly', async () => {
  const store = createAdminStore(':memory:');
  try {
    await assert.rejects(savePromptPolicy({ visualPlanningEnabled: false }, { store }), /请先发布/);
    assert.equal(store.getPromptRuntimeSettings(), null);
    for (const template of store.listPromptTemplates()) if (template.versions[0].status === 'DRAFT') store.publishPromptVersion(template.versions[0].id);
    await savePromptPolicy({ visualPlanningEnabled: false, copyKnowledgeThreshold: 80 }, { store });
    const config = await readPromptConfiguration({ store });
    assert.equal(config.promptRuntime.settings.copyKnowledgeThreshold, 80);
    assert.equal(config.promptRuntime.source, 'LOCAL');
    assert.ok(config.promptRuntime.prompts.IMAGE_ALIGNMENT_SYSTEM.versionId);
  } finally { store.close(); }
});

test('center configuration cannot silently fall back to local rules', async () => {
  await assert.rejects(readPromptConfiguration({ controlPlane: {
    listPrompts: async () => { throw new Error('center unavailable'); }, listSettings: async () => [], listKnowledge: async () => [],
  }, store: { listPromptTemplates() { throw new Error('must not read local'); } } }), /center unavailable/);
});

test('preparing candidates preserves existing center versions and does not publish', async () => {
  const writes = [];
  const controlPlane = { listPrompts: async () => [{ kind: 'TEXT_SYSTEM', versions: [{ content: '人工原文', status: 'PUBLISHED' }] }],
    createPromptVersion: async (value) => { writes.push(value); return value; },
    publishPromptVersion() { throw new Error('must not publish'); } };
  await preparePromptDrafts({ controlPlane });
  assert.equal(writes.length, PROMPT_CATALOG.length - 1);
  assert.ok(writes.every((item) => item.kind !== 'TEXT_SYSTEM'));
});
