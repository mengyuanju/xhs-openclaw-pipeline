import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';

it('committed import batches expose a confirmed asynchronous generation action', async () => {
  const [workbench, launchPanel, styles] = await Promise.all([
    readFile(new URL('../app/imports/import-workbench.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/imports/queue-generation-panel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/globals.css', import.meta.url), 'utf8'),
  ]);

  assert.match(workbench, /QueueGenerationPanel/);
  assert.match(workbench, /batch\.status === 'COMMITTED'/);
  assert.match(launchPanel, /\/api\/worker-runs/);
  assert.match(launchPanel, /window\.confirm/);
  assert.match(launchPanel, /2 次文本模型/);
  assert.match(launchPanel, /3–5 次图片模型/);
  assert.match(launchPanel, /3–5 次视觉验收/);
  assert.match(launchPanel, /最多 2 条任务同时生产/);
  assert.match(launchPanel, /Math\.ceil\(boundedMax \/ TASK_CONCURRENCY\)/);
  assert.match(launchPanel, /result\.concurrency/);
  assert.match(launchPanel, /单条通常/);
  assert.match(launchPanel, /本次最多约/);
  assert.match(launchPanel, /首条完成后会自动形成估算/);
  assert.match(launchPanel, /timingStats/);
  assert.match(launchPanel, /href="\/tasks"/);
  assert.match(styles, /\.generation-panel \.notice \{[^}]*flex-basis: 100%/);
});
