import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgentClient } from '../src/agent-client.mjs';

test('production factory chooses Codex without looking for an OpenClaw installation', () => {
  const client = createAgentClient({ environment: { XHS_WEB_SEARCH_PROVIDER: 'OPENCLAW' } });
  assert.equal(client.provider, 'codex');
  for (const method of ['checkReady', 'runText', 'runReview', 'runVision', 'runWebSearch', 'runImage', 'runImageEdit']) {
    assert.equal(typeof client[method], 'function');
  }
});

test('explicit rollback instantiates OpenClaw and never starts Codex', async () => {
  const client = createAgentClient({ environment: { XHS_WEB_SEARCH_PROVIDER: 'OPENCLAW' }, modelApi: { agentProvider: 'OPENCLAW' },
    entryPath: 'C:/fake-openclaw/index.js', runner: () => ({ status: 0, stdout: '{"final":"old engine"}' }) });
  assert.equal((await client.runText({ prompt: 'test request' })).rawText, 'old engine');
  assert.equal(client.provider, 'openclaw');
});

test('DeepSeek search wraps either runtime without changing generation provider', () => {
  const client = createAgentClient({ environment: { XHS_WEB_SEARCH_PROVIDER: 'DEEPSEEK' } });
  assert.equal(client.provider, 'codex');
  assert.deepEqual(client.webSearchProviders, ['deepseek']);
});
