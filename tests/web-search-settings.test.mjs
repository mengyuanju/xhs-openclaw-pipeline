import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { normalizeModelApiSettings, effectiveModelApiConfig } from '../src/model-api-config.mjs';
import { resolveWebSearchConfig } from '../src/web-search-config.mjs';
import { createProductionSettingsStore, initializeProductionSettingsSchema } from '../src/admin/production-settings-store.mjs';
import { readWebSearchSettings, updateWebSearchSettings } from '../src/admin/web-search-settings-service.mjs';
import { createCopyGenerationClient } from '../src/copy-generation-client.mjs';

test('unconfigured search defaults to DeepSeek flash while explicit OpenClaw remains available', () => {
  assert.deepEqual(resolveWebSearchConfig({}), {
    provider: 'DEEPSEEK', model: 'deepseek-v4-flash', timeoutMs: 120_000,
  });
  assert.equal(effectiveModelApiConfig({}, {}).webSearchProvider, 'DEEPSEEK');
  assert.deepEqual(resolveWebSearchConfig({}, { webSearchProvider: 'OPENCLAW' }), { provider: 'OPENCLAW' });
  assert.deepEqual(resolveWebSearchConfig({ XHS_WEB_SEARCH_PROVIDER: 'OPENCLAW' }), { provider: 'OPENCLAW' });
});

test('clearing a saved search override restores DeepSeek flash without changing generation settings', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeProductionSettingsSchema(db);
    const store = createProductionSettingsStore(db);
    const options = { store, environment: {} };
    store.updateProductionSettings({ modelApi: { textModel: 'openai/gpt-5.6-sol' } });
    await updateWebSearchSettings(options, { webSearchProvider: 'OPENCLAW' });
    assert.equal((await readWebSearchSettings(options)).effective.provider, 'OPENCLAW');
    const restored = await updateWebSearchSettings(options, { webSearchProvider: null, deepseekSearchModel: null });
    assert.deepEqual(restored.effective, { provider: 'DEEPSEEK', model: 'deepseek-v4-flash', timeoutMs: 120_000 });
    assert.equal(store.getProductionSettings().settings.modelApi.textModel, 'openai/gpt-5.6-sol');
    assert.equal(restored.apiKeyConfigured, false);
  } finally { db.close(); }
});

test('saved search settings override executor environment and null restores inheritance', () => {
  const settings = normalizeModelApiSettings({ webSearchProvider: 'DEEPSEEK', deepseekSearchModel: 'deepseek-v4-flash', webSearchTimeoutMs: 15000 });
  const environment = { XHS_WEB_SEARCH_PROVIDER: 'OPENCLAW', XHS_DEEPSEEK_SEARCH_MODEL: 'deepseek-v4-pro' };
  assert.deepEqual(resolveWebSearchConfig(environment, settings), { provider: 'DEEPSEEK', model: 'deepseek-v4-flash', timeoutMs: 15000 });
  assert.equal(effectiveModelApiConfig(settings, environment).webSearchProvider, 'DEEPSEEK');
  assert.equal(resolveWebSearchConfig(environment, { webSearchProvider: null }).provider, 'OPENCLAW');
  assert.throws(() => normalizeModelApiSettings({ webSearchProvider: 'typo' }));
  assert.throws(() => normalizeModelApiSettings({ deepseekSearchModel: 'unknown' }));
  assert.throws(() => normalizeModelApiSettings({ webSearchTimeoutMs: 1 }));
});

test('local search saves preserve generation settings and allow resetting to the environment', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeProductionSettingsSchema(db);
    const store = createProductionSettingsStore(db);
    store.updateProductionSettings({ modelApi: { textModel: 'openai/gpt-5.6-terra' }, aiDisclosureEnabled: false });
    const options = { store, environment: { DEEPSEEK_API_KEY: 'local-test-secret' } };
    const record = await updateWebSearchSettings(options, { webSearchProvider: 'DEEPSEEK', deepseekSearchModel: 'deepseek-v4-flash' });
    assert.equal(record.settings.webSearchProvider, 'DEEPSEEK');
    assert.equal(record.apiKeyConfigured, true);
    assert.ok(!JSON.stringify(record).includes('local-test-secret'));
    assert.equal(store.getProductionSettings().settings.modelApi.textModel, 'openai/gpt-5.6-terra');
    store.updateProductionSettings({ modelApi: { textModel: 'openai/gpt-5.6-sol' } });
    assert.equal((await readWebSearchSettings(options)).settings.deepseekSearchModel, 'deepseek-v4-flash');
    await updateWebSearchSettings(options, { webSearchProvider: null });
    assert.equal((await readWebSearchSettings(options)).settings.webSearchProvider, null);
  } finally { db.close(); }
});

test('central search saves merge only search fields and never claim remote key readiness', async () => {
  let production = { key: 'production', value: { custom: 'keep', modelApi: { textModel: 'openai/gpt-5.6-sol' } }, version: 4 };
  const options = {
    environment: { DEEPSEEK_API_KEY: 'frontend-only-secret' },
    controlPlane: {
      async listSettings() { return [production]; },
      async updateSetting(key, value) { production = { key, value, version: 5 }; return production; },
    },
  };
  const saved = await updateWebSearchSettings(options, { webSearchProvider: 'DEEPSEEK' });
  assert.equal(production.value.custom, 'keep');
  assert.equal(production.value.modelApi.textModel, 'openai/gpt-5.6-sol');
  assert.equal(saved.scope, 'central');
  assert.equal(saved.apiKeyConfigured, null);
  assert.ok(!JSON.stringify(saved).includes('frontend-only-secret'));
  await assert.rejects(updateWebSearchSettings(options, { apiKey: 'must-not-save' }));
  await assert.rejects(updateWebSearchSettings(options, {}));
  assert.equal(production.version, 5);
});

test('saved search configuration reaches the production copy client independently of environment', async () => {
  let body;
  const modelApi = normalizeModelApiSettings({ webSearchProvider: 'DEEPSEEK', deepseekSearchModel: 'deepseek-v4-flash' });
  const client = createCopyGenerationClient({
    modelApi,
    environment: { XHS_WEB_SEARCH_PROVIDER: 'OPENCLAW', DEEPSEEK_API_KEY: 'test-secret' },
    openclaw: { runWebSearch() { assert.fail('must use the saved provider'); } },
    async fetchImpl(_url, init) {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ status: 'completed', output: [
        { type: 'web_search_call', status: 'completed' },
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ summary: '资料', sources: [{ url: 'https://example.gov/guide' }] }) }] },
      ] }));
    },
  });
  assert.equal((await client.runWebSearch({ query: '选题' })).provider, 'deepseek');
  assert.equal(body.model, 'deepseek-v4-flash');
});
