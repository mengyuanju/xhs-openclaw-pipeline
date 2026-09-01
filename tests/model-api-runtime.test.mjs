import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { screenImportRowsWithOpenClaw } from '../src/admin/demand-screening-service.mjs';
import { createOpenClawClient } from '../src/openclaw.mjs';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('model API runtime configuration', () => {
  it('uses production model and proxy overrides for OpenClaw text calls', async () => {
    let invocation;
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      modelApi: {
        textModel: 'openai/gpt-5.6-terra',
        reviewModel: 'openai/gpt-5.4',
        modelProxyUrl: 'http://127.0.0.1:7897',
      },
      runner(command, args, options) {
        invocation = { command, args, options };
        return { status: 0, stdout: JSON.stringify({ final: 'reviewed' }), stderr: '' };
      },
    });

    const result = await client.runReview({ prompt: 'Review bounded untrusted text.' });

    assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], 'openai/gpt-5.4');
    assert.equal(invocation.options.shell, false);
    assert.equal(invocation.options.HTTPS_PROXY, undefined);
    assert.equal(invocation.options.env.HTTPS_PROXY, 'http://127.0.0.1:7897');
    assert.equal(result.model, 'openai/gpt-5.4');
  });

  it('uses the production screening model for Excel demand detection', async () => {
    let submittedModel;
    const rows = [{
      rowNumber: 2,
      query: '租房桌面怎么低成本整理？',
      input: {},
      errors: [],
      screening: null,
    }];
    const screened = await screenImportRowsWithOpenClaw({
      rows,
      modelApi: { screeningModel: 'openai/gpt-5.6-terra' },
      openclaw: {
        async runText({ model }) {
          submittedModel = model;
          return {
            model,
            rawText: JSON.stringify({
              decisions: [{ rowNumber: 2, demandLevel: 'STRONG', reason: '需要真实经验支撑' }],
            }),
          };
        },
      },
    });

    assert.equal(submittedModel, 'openai/gpt-5.6-terra');
    assert.equal(screened[0].screening.model, 'openai/gpt-5.6-terra');
  });

  it('wires the same production configuration into every live entry point', async () => {
    const [copyRoute, pipeline, cli, importRoute, visualRoute, imageEditWorker] = await Promise.all([
      source('app/api/copy-generations/route.ts'),
      source('src/pipeline.mjs'),
      source('src/cli.mjs'),
      source('app/api/import-batches/route.ts'),
      source('app/api/visual-analyses/route.ts'),
      source('src/admin/image-edit-worker.mjs'),
    ]);

    assert.match(copyRoute, /createOpenClawClient\(\{ modelApi/u);
    assert.match(pipeline, /createOpenClawClient\(\{ modelApi: productionSettings\.modelApi \}\)/u);
    assert.match(pipeline, /model: effectiveModelApi\.qualityModel/u);
    assert.match(cli, /effectiveModelApiConfig\(productionSettings\.modelApi, env\)/u);
    assert.match(importRoute, /screenImportRowsWithOpenClaw\(\{ rows: parsed\.rows, modelApi \}\)/u);
    assert.match(visualRoute, /analyzeVisualImage\(\{[\s\S]*modelApi,/u);
    assert.match(imageEditWorker, /createOpenClawClient\(\{ modelApi: productionSettings\.modelApi \}\)/u);
  });
});
