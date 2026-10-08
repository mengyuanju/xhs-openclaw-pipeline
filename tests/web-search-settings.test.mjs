import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { normalizeModelApiSettings, effectiveModelApiConfig } from '../src/model-api-config.mjs';
import { resolveWebSearchConfig } from '../src/web-search-config.mjs';
import { createProductionSettingsStore, initializeProductionSettingsSchema } from '../src/admin/production-settings-store.mjs';
import { readWebSearchSettings, updateWebSearchSettings } from '../src/admin/web-search-settings-service.mjs';
import { createCopyGenerationClient } from '../src/copy-generation-client.mjs';

test('unconfigured search defaults to the verified DeepSeek web-search model while explicit Codex remains available', () => {
  assert.deepEqual(resolveWebSearchConfig({}), {
    provider: 'DEEPSEEK', model: 'deepseek-v4-pro', timeoutMs: 120_000, resultLimit: 5,
  });
  assert.equal(effectiveModelApiConfig({}, {}).webSearchProvider, 'DEEPSEEK');
  assert.deepEqual(resolveWebSearchConfig({}, { webSearchProvider: 'CODEX' }), { provider: 'CODEX', resultLimit: 5 });
  assert.deepEqual(resolveWebSearchConfig({ XHS_WEB_SEARCH_PROVIDER: 'CODEX' }), { provider: 'CODEX', resultLimit: 5 });
  assert.equal(effectiveModelApiConfig({}, {}).webSearchResultLimit, 5);
});

test('clearing a saved search override restores the verified DeepSeek model without changing generation settings', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeProductionSettingsSchema(db);
    const store = createProductionSettingsStore(db);
    const options = { store, environment: {} };
    store.updateProductionSettings({ modelApi: { textModel: 'openai/gpt-5.6-sol' } });
    await updateWebSearchSettings(options, { webSearchProvider: 'CODEX' });
    assert.equal((await readWebSearchSettings(options)).effective.provider, 'CODEX');
    const restored = await updateWebSearchSettings(options, { webSearchProvider: null, deepseekSearchModel: null });
    assert.deepEqual(restored.effective, { provider: 'DEEPSEEK', model: 'deepseek-v4-pro', timeoutMs: 120_000, resultLimit: 5 });
    assert.equal(store.getProductionSettings().settings.modelApi.textModel, 'openai/gpt-5.6-sol');
    assert.equal(restored.apiKeyConfigured, false);
  } finally { db.close(); }
});

test('saved search settings override executor environment and null restores inheritance', () => {
  const settings = normalizeModelApiSettings({ webSearchProvider: 'DEEPSEEK', deepseekSearchModel: 'deepseek-v5-search-preview', webSearchTimeoutMs: 15000 });
  const environment = { XHS_WEB_SEARCH_PROVIDER: 'CODEX', XHS_DEEPSEEK_SEARCH_MODEL: 'deepseek-v4-pro' };
  assert.deepEqual(resolveWebSearchConfig(environment, settings), { provider: 'DEEPSEEK', model: 'deepseek-v5-search-preview', timeoutMs: 15000, resultLimit: 5 });
  assert.equal(effectiveModelApiConfig(settings, environment).webSearchProvider, 'DEEPSEEK');
  assert.equal(resolveWebSearchConfig(environment, { webSearchProvider: null }).provider, 'CODEX');
  assert.throws(() => normalizeModelApiSettings({ webSearchProvider: 'typo' }));
  assert.equal(normalizeModelApiSettings({ deepseekSearchModel: 'future-model' }).deepseekSearchModel, 'future-model');
  for (const model of ['', 'bad model', `deepseek-${'x'.repeat(121)}`]) {
    assert.throws(() => normalizeModelApiSettings({ deepseekSearchModel: model }), /model identifier/u);
  }
  assert.throws(() => normalizeModelApiSettings({ webSearchTimeoutMs: 1 }));
  for (const invalid of [0, 11, 1.5, '5']) {
    assert.throws(() => normalizeModelApiSettings({ webSearchResultLimit: invalid }), /webSearchResultLimit/u);
  }
  assert.deepEqual(resolveWebSearchConfig({}, { webSearchProvider: 'CODEX', webSearchResultLimit: 9 }), {
    provider: 'CODEX', resultLimit: 9,
  });
});

test('local search saves preserve generation settings and allow resetting to the environment', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeProductionSettingsSchema(db);
    const store = createProductionSettingsStore(db);
    store.updateProductionSettings({ modelApi: { textModel: 'openai/gpt-5.6-terra' }, aiDisclosureEnabled: false });
    const options = { store, environment: { DEEPSEEK_API_KEY: 'local-test-secret' } };
    const record = await updateWebSearchSettings(options, { webSearchProvider: 'DEEPSEEK', deepseekSearchModel: 'deepseek-v4-pro', webSearchResultLimit: 8 });
    assert.equal(record.settings.webSearchProvider, 'DEEPSEEK');
    assert.equal(record.effective.resultLimit, 8);
    assert.equal(store.getProductionSettings().settings.modelApi.webSearchResultLimit, 8);
    assert.equal(record.apiKeyConfigured, true);
    assert.ok(!JSON.stringify(record).includes('local-test-secret'));
    assert.equal(store.getProductionSettings().settings.modelApi.textModel, 'openai/gpt-5.6-terra');
    store.updateProductionSettings({ modelApi: { textModel: 'openai/gpt-5.6-sol' } });
    assert.equal((await readWebSearchSettings(options)).settings.deepseekSearchModel, 'deepseek-v4-pro');
    await updateWebSearchSettings(options, { webSearchProvider: null });
    assert.equal((await readWebSearchSettings(options)).settings.webSearchProvider, null);
    const inherited = await updateWebSearchSettings(options, { webSearchResultLimit: null });
    assert.equal(inherited.effective.resultLimit, 5);
  } finally { db.close(); }
});

test('central search saves merge only search fields and never claim remote key readiness', async () => {
  let production = { key: 'production', value: { custom: 'keep', modelApi: { textModel: 'openai/gpt-5.6-sol' } }, version: 4 };
  const options = {
    environment: { DEEPSEEK_API_KEY: 'frontend-only-secret' },
    controlPlane: {
      async listSettings() { return [production]; },
      async updateSetting(key, value, options) {
        assert.deepEqual(options, { expectedVersion: 4 });
        production = { key, value, version: 5 };
        return production;
      },
    },
  };
  const saved = await updateWebSearchSettings(options, { webSearchProvider: 'DEEPSEEK', webSearchResultLimit: 10 });
  assert.equal(production.value.custom, 'keep');
  assert.equal(production.value.modelApi.textModel, 'openai/gpt-5.6-sol');
  assert.equal(saved.scope, 'central');
  assert.equal(saved.settings.webSearchResultLimit, 10);
  assert.equal(production.value.modelApi.webSearchResultLimit, 10);
  assert.equal(Object.hasOwn(production.value.modelApi, 'webSearchProviderOrder'), false);
  assert.equal(Object.hasOwn(production.value.modelApi, 'doubaoIcpHostOnly'), false);
  assert.equal(saved.apiKeyConfigured, null);
  assert.ok(!JSON.stringify(saved).includes('frontend-only-secret'));
  await assert.rejects(updateWebSearchSettings(options, { apiKey: 'must-not-save' }));
  await assert.rejects(updateWebSearchSettings(options, { webSearchResultLimit: 11 }), /webSearchResultLimit/u);
  await assert.rejects(updateWebSearchSettings(options, {}));
  assert.equal(production.version, 5);
});

test('saved search configuration reaches the production copy client independently of environment', async () => {
  let body;
  const modelApi = normalizeModelApiSettings({ webSearchProvider: 'DEEPSEEK', deepseekSearchModel: 'deepseek-v5-search-preview' });
  const client = createCopyGenerationClient({
    modelApi,
    environment: { XHS_WEB_SEARCH_PROVIDER: 'CODEX', DEEPSEEK_API_KEY: 'test-secret' },
    agentClient: { runWebSearch() { assert.fail('must use the saved provider'); } },
    async fetchImpl(_url, init) {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ status: 'completed', output: [
        { type: 'web_search_call', status: 'completed' },
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ summary: '资料', sources: [{ url: 'https://example.gov/guide' }] }) }] },
      ] }));
    },
  });
  assert.equal((await client.runWebSearch({ query: '选题' })).provider, 'deepseek');
  assert.equal(body.model, 'deepseek-v5-search-preview');
});

test('ordered providers retain legacy primary while resolving fallback configuration', () => {
  const environment = { XHS_WEB_SEARCH_PROVIDER: 'CODEX', XHS_DEEPSEEK_SEARCH_MODEL: 'deepseek-v5-search-preview' };
  const settings = normalizeModelApiSettings({
    webSearchProvider: 'CODEX',
    webSearchProviderOrder: ['DOUBAO', 'DEEPSEEK'],
    webSearchTimeoutMs: 20_000,
    doubaoIcpHostOnly: false,
  });
  assert.equal(settings.webSearchProvider, 'DOUBAO');
  assert.deepEqual(resolveWebSearchConfig(environment, settings), {
    provider: 'DOUBAO', providers: ['DOUBAO', 'DEEPSEEK'],
    model: 'deepseek-v5-search-preview', timeoutMs: 20_000, resultLimit: 5,
    doubaoSearchMode: 'GLOBAL',
    doubaoIcpHostOnly: false,
  });
  assert.deepEqual(effectiveModelApiConfig(settings, environment).webSearchProviderOrder,
    ['DOUBAO', 'DEEPSEEK']);
  assert.deepEqual(resolveWebSearchConfig({}, { webSearchProvider: 'DOUBAO' }), {
    provider: 'DOUBAO', timeoutMs: 120_000, resultLimit: 5,
    doubaoSearchMode: 'GLOBAL', doubaoIcpHostOnly: true,
  });
  assert.equal(resolveWebSearchConfig({}, { webSearchProvider: 'DOUBAO',
    doubaoSearchMode: 'CUSTOM' }).doubaoSearchMode, 'CUSTOM');
  assert.throws(() => normalizeModelApiSettings({ doubaoSearchMode: 'WRONG' }), /doubaoSearchMode/u);
  assert.equal(resolveWebSearchConfig({ XHS_DEEPSEEK_SEARCH_TIMEOUT_MS: '5000' },
    { webSearchProvider: 'DOUBAO' }).timeoutMs, 120_000);
  for (const order of [[], ['DOUBAO', 'DOUBAO'], ['UNKNOWN'], ['DOUBAO', 'DEEPSEEK', 'CODEX', 'OTHER']]) {
    assert.throws(() => normalizeModelApiSettings({ webSearchProviderOrder: order }), /webSearchProviderOrder/u);
  }
  assert.throws(() => normalizeModelApiSettings({ doubaoIcpHostOnly: 'false' }), /doubaoIcpHostOnly/u);
});

test('ordered settings expose only key readiness and legacy single-provider patches turn off failover', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeProductionSettingsSchema(db);
    const store = createProductionSettingsStore(db);
    const options = { store, environment: {
      DOUBAO_SEARCH_API_KEY: 'test-doubao-secret', DEEPSEEK_API_KEY: '',
    } };
    const ordered = await updateWebSearchSettings(options, {
      webSearchProviderOrder: ['DOUBAO', 'DEEPSEEK'], doubaoIcpHostOnly: false,
    });
    assert.deepEqual(ordered.settings.webSearchProviderOrder, ['DOUBAO', 'DEEPSEEK']);
    assert.equal(ordered.settings.webSearchProvider, 'DOUBAO');
    assert.deepEqual(ordered.providerKeyConfigured, { DEEPSEEK: false, DOUBAO: true });
    assert.ok(!JSON.stringify(ordered).includes('test-doubao-secret'));
    assert.equal(store.getProductionSettings().settings.modelApi.webSearchProvider, 'DOUBAO');
    const legacy = await updateWebSearchSettings(options, { webSearchProvider: 'CODEX' });
    assert.equal(legacy.settings.webSearchProvider, 'CODEX');
    assert.equal(legacy.settings.webSearchProviderOrder, null);
    assert.deepEqual(legacy.effective, { provider: 'CODEX', resultLimit: 5 });
    const explicitGlobal = await updateWebSearchSettings(options, { webSearchProvider: 'DOUBAO',
      doubaoSearchMode: 'GLOBAL' });
    assert.equal(explicitGlobal.effective.doubaoSearchMode, 'GLOBAL');
    const restoredCustom = await updateWebSearchSettings(options, { doubaoSearchMode: null });
    assert.equal(restoredCustom.settings.doubaoSearchMode, 'CUSTOM');
    assert.equal(restoredCustom.effective.doubaoSearchMode, 'CUSTOM');
  } finally { db.close(); }
});

test('central ordered save synchronizes the legacy primary without persisting executor keys', async () => {
  let production = { key: 'production', value: { modelApi: { webSearchProvider: 'CODEX' } } };
  const options = {
    environment: { DOUBAO_SEARCH_API_KEY: 'frontend-only-secret' },
    controlPlane: {
      async listSettings() { return [production]; },
      async updateSetting(key, value) { production = { key, value }; return production; },
    },
  };
  const saved = await updateWebSearchSettings(options, { webSearchProviderOrder: ['DEEPSEEK', 'DOUBAO'] });
  assert.deepEqual(production.value.modelApi.webSearchProviderOrder, ['DEEPSEEK', 'DOUBAO']);
  assert.equal(production.value.modelApi.webSearchProvider, 'DEEPSEEK');
  assert.deepEqual(saved.providerKeyConfigured, { DEEPSEEK: null, DOUBAO: null });
  assert.ok(!JSON.stringify(production).includes('frontend-only-secret'));
  await updateWebSearchSettings(options, { webSearchProviderOrder: null });
  assert.equal(Object.hasOwn(production.value.modelApi, 'webSearchProviderOrder'), false);
});
