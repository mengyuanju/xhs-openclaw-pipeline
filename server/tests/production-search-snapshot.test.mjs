import assert from 'node:assert/strict';
import test from 'node:test';

import { pinDefaultDoubaoSearchMode, resolveWebSearchConfig,
  snapshotProductionSearchMode } from '../../src/web-search-config.mjs';
import { DEFAULT_PRODUCTION_SETTINGS } from '../src/defaults.mjs';

test('new Doubao snapshots pin Custom while historical snapshots without mode remain Global', () => {
  assert.equal(Object.hasOwn(DEFAULT_PRODUCTION_SETTINGS.modelApi, 'doubaoSearchMode'), false);
  const legacy = { modelApi: { webSearchProvider: 'DOUBAO' } };
  assert.equal(resolveWebSearchConfig({}, legacy.modelApi).doubaoSearchMode, 'GLOBAL');
  const frozen = snapshotProductionSearchMode(legacy);
  assert.equal(frozen.modelApi.doubaoSearchMode, 'CUSTOM');
  assert.equal(resolveWebSearchConfig({}, frozen.modelApi).doubaoSearchMode, 'CUSTOM');
  assert.equal(Object.hasOwn(legacy.modelApi, 'doubaoSearchMode'), false);
});

test('snapshot capture keeps explicit Global and Custom choices and resolves null to Custom', () => {
  for (const mode of ['GLOBAL', 'CUSTOM']) {
    const original = { modelApi: { webSearchProvider: 'DOUBAO', doubaoSearchMode: mode } };
    assert.equal(snapshotProductionSearchMode(original), original);
    assert.equal(resolveWebSearchConfig({}, original.modelApi).doubaoSearchMode, mode);
  }
  const inherited = snapshotProductionSearchMode({ modelApi: { webSearchProvider: 'DOUBAO', doubaoSearchMode: null } });
  assert.equal(inherited.modelApi.doubaoSearchMode, 'CUSTOM');
});

test('new non-Doubao snapshots omit the field for older executors', () => {
  for (const provider of ['DEEPSEEK', 'CODEX', null]) {
    const original = { modelApi: { webSearchProvider: provider, doubaoSearchMode: 'CUSTOM' } };
    const frozen = snapshotProductionSearchMode(original);
    assert.equal(Object.hasOwn(frozen.modelApi, 'doubaoSearchMode'), false);
    assert.equal(original.modelApi.doubaoSearchMode, 'CUSTOM');
  }
  const fallback = snapshotProductionSearchMode({ modelApi: {
    webSearchProviderOrder: ['DEEPSEEK', 'DOUBAO'], doubaoSearchMode: null,
  } });
  assert.equal(fallback.modelApi.doubaoSearchMode, 'CUSTOM');
  assert.equal(pinDefaultDoubaoSearchMode({ modelApi: {} }).modelApi.doubaoSearchMode, 'CUSTOM');
});
