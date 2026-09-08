import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgentClient } from '../src/agent-client.mjs';
import { effectiveModelApiConfig, normalizeModelApiSettings } from '../src/model-api-config.mjs';
import { resolveWebSearchConfig } from '../src/web-search-config.mjs';

test('retired provider settings resolve to Codex without loading or executing OpenClaw', () => {
  const modelApi = { agentProvider: 'OPENCLAW', copyGenerationProvider: 'OPENCLAW', webSearchProvider: 'OPENCLAW' };
  const normalized = normalizeModelApiSettings(modelApi);
  assert.equal(normalized.agentProvider, 'CODEX');
  assert.equal(normalized.copyGenerationProvider, 'CODEX');
  assert.equal(normalized.webSearchProvider, 'CODEX');
  const client = createAgentClient({ modelApi, environment: {}, runtime: { assertAvailable() {}, run() { assert.fail('no model calls'); } } });
  assert.equal(client.provider, 'codex');
});

test('new configuration uses canonical provider names and keeps independent services', () => {
  const config = effectiveModelApiConfig({}, {});
  assert.equal(config.agentProvider, 'CODEX');
  assert.equal(config.copyGenerationProvider, 'CODEX');
  assert.equal(config.webSearchProvider, 'DEEPSEEK');
  assert.equal(effectiveModelApiConfig({ copyGenerationProvider: 'DOTS' }, {}).copyGenerationProvider, 'DOTS');
  assert.equal(resolveWebSearchConfig({ XHS_WEB_SEARCH_PROVIDER: 'CODEX' }).provider, 'CODEX');
});
