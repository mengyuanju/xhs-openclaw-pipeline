import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCodexClient } from '../src/codex.mjs';

test('Codex records local permit wait separately from model execution time', async (t) => {
  let time = 1000;
  t.mock.method(Date, 'now', () => time);
  const client = createCodexClient({ executable: 'fake', environment: { XHS_WEB_SEARCH_PROVIDER: 'CODEX' },
    runtime: { async run(operation) { time += 3000; return operation({ onSpawn() {} }); } },
    asyncRunner: async () => { time += 9000; return { status: 0, stdout: [
      { type: 'item.completed', item: { type: 'agent_message', text: '{"rawText":"ok"}' } },
      { type: 'turn.completed' },
    ].map(JSON.stringify).join('\n') }; },
  });
  const result = await client.runText({ prompt: 'fake' });
  assert.equal(result.execution.queueWaitMs, 3000);
});
