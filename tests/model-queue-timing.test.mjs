import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCodexClient } from '../src/codex.mjs';
import { createOpenClawClient } from '../src/openclaw.mjs';

test('Codex records local permit wait separately from model execution time', async (t) => {
  let time = 1000;
  t.mock.method(Date, 'now', () => time);
  const client = createCodexClient({ executable: 'fake', environment: { XHS_WEB_SEARCH_PROVIDER: 'OPENCLAW' },
    runtime: { async run(operation) { time += 3000; return operation({ onSpawn() {} }); } },
    asyncRunner: async () => { time += 9000; return { status: 0, stdout: [
      { type: 'item.completed', item: { type: 'agent_message', text: '{"rawText":"ok"}' } },
      { type: 'turn.completed' },
    ].map(JSON.stringify).join('\n') }; },
  });
  const result = await client.runText({ prompt: 'fake' });
  assert.equal(result.execution.queueWaitMs, 3000);
});

test('OpenClaw preserves serialization while reporting the second call queue wait', async (t) => {
  let time = 1000;
  t.mock.method(Date, 'now', () => time);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let calls = 0;
  const client = createOpenClawClient({ entryPath: 'fake-entry', asyncRunner: async () => {
    calls += 1;
    if (calls === 1) { entered.resolve(); await release.promise; }
    return { status: 0, stdout: '{"final":"fake"}', stderr: '' };
  } });
  const first = client.runText({ prompt: 'first' });
  await entered.promise;
  const second = client.runText({ prompt: 'second' });
  assert.equal(calls, 1);
  time += 4000;
  release.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.execution.queueWaitMs, 0);
  assert.equal(b.execution.queueWaitMs, 4000);
  assert.equal(calls, 2);
});
