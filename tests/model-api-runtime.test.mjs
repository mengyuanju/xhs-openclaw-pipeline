import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { createAgentClient } from '../src/agent-client.mjs';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('model API runtime configuration', () => {
  it('uses production review model and proxy in the Codex process', async () => {
    let invocation;
    const client = createAgentClient({
      executable: 'fake-codex', environment: { XHS_WEB_SEARCH_PROVIDER: 'CODEX' },
      runtime: { run: operation => operation({ onSpawn() {} }) },
      modelApi: { reviewModel: 'openai/gpt-5.4', modelProxyUrl: 'http://127.0.0.1:7897' },
      asyncRunner: async (command, args, options) => {
        invocation = { command, args, options };
        return { status: 0, stdout: [
          { type: 'item.completed', item: { type: 'agent_message', text: '{"rawText":"reviewed"}' } },
          { type: 'turn.completed' },
        ].map(JSON.stringify).join('\n') };
      },
    });
    const result = await client.runReview({ prompt: 'Review bounded untrusted text.' });
    assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], 'gpt-5.4');
    assert.equal(invocation.options.env.HTTPS_PROXY, 'http://127.0.0.1:7897');
    assert.equal(result.model, 'openai/gpt-5.4');
    assert.equal(result.rawText, 'reviewed');
  });

  it('wires the same production configuration into every live entry point', async () => {
    const [pipeline, cli, visualRoute, imageEditWorker] = await Promise.all([
      source('src/pipeline.mjs'),
      source('src/cli.mjs'),
      source('app/api/visual-analyses/route.ts'),
      source('src/admin/image-edit-worker.mjs'),
    ]);

    assert.match(pipeline, /createAgentClient\(\{ modelApi: productionSettings\.modelApi \}\)/u);
    assert.match(pipeline, /model: effectiveModelApi\.qualityModel/u);
    assert.match(cli, /effectiveModelApiConfig\(productionSettings\.modelApi, env\)/u);
    assert.match(visualRoute, /analyzeVisualImage\(\{[\s\S]*modelApi,/u);
    assert.match(imageEditWorker, /createAgentClient\(\{ modelApi: productionSettings\.modelApi \}\)/u);
  });
});
