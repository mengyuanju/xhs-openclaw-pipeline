import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgentClient } from '../src/agent-client.mjs';

test('production factory chooses Codex without looking for an OpenClaw installation', () => {
  const client = createAgentClient({ environment: { XHS_WEB_SEARCH_PROVIDER: 'CODEX' } });
  assert.equal(client.provider, 'codex');
  for (const method of ['checkReady', 'runText', 'runReview', 'runVision', 'runWebSearch', 'runImage', 'runImageEdit']) {
    assert.equal(typeof client[method], 'function');
  }
});

test('DeepSeek search wraps Codex without changing generation provider', () => {
  const client = createAgentClient({ environment: { XHS_WEB_SEARCH_PROVIDER: 'DEEPSEEK' } });
  assert.equal(client.provider, 'codex');
  assert.deepEqual(client.webSearchProviders, ['deepseek']);
});
