import assert from 'node:assert/strict';
import { test } from 'node:test';
import { effectiveModelApiConfig, normalizeModelApiSettings, publicModelApiStatus } from '../src/model-api-config.mjs';

test('agent runtime defaults to Codex while retaining independent copy and search choices', () => {
  const config = effectiveModelApiConfig({}, {});
  assert.equal(config.agentProvider, 'CODEX');
  assert.equal(config.copyGenerationProvider, 'OPENCLAW');
  const custom = effectiveModelApiConfig({ copyGenerationProvider: 'DOTS', webSearchProvider: 'DEEPSEEK' }, {});
  assert.equal(custom.agentProvider, 'CODEX');
  assert.equal(custom.copyGenerationProvider, 'DOTS');
  assert.equal(custom.webSearchProvider, 'DEEPSEEK');
});

test('saved runtime overrides environment and null restores inheritance for rollback', () => {
  const environment = { XHS_AGENT_PROVIDER: 'OPENCLAW' };
  assert.equal(effectiveModelApiConfig({}, environment).agentProvider, 'OPENCLAW');
  assert.equal(effectiveModelApiConfig({ agentProvider: 'CODEX' }, environment).agentProvider, 'CODEX');
  assert.equal(effectiveModelApiConfig({ agentProvider: null }, environment).agentProvider, 'OPENCLAW');
  assert.equal(normalizeModelApiSettings({ agentProvider: 'codex' }).agentProvider, 'CODEX');
});

test('invalid runtime is rejected and public status reports the selected provider without secrets', () => {
  assert.throws(() => normalizeModelApiSettings({ agentProvider: 'typo' }), /agentProvider/u);
  assert.throws(() => effectiveModelApiConfig({}, { XHS_AGENT_PROVIDER: 'typo' }), /agentProvider/u);
  const publicStatus = publicModelApiStatus({}, { CODEX_ACCESS_TOKEN: 'private-value' });
  assert.equal(publicStatus.agentProvider, 'CODEX');
  assert.ok(!JSON.stringify(publicStatus).includes('private-value'));
});
