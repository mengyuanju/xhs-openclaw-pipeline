import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';

it('worker run API requires explicit live-cost confirmation and bounds work by queue state', async () => {
  const route = await readFile(
    new URL('../app/api/worker-runs/route.ts', import.meta.url),
    'utf8',
  );

  assert.match(route, /LIVE_MODEL_COST_ACCEPTED/);
  assert.match(route, /MAX_WEB_WORKER_TASKS/);
  assert.match(route, /mutation:\s*true/);
  assert.match(route, /tasks\.pending/);
  assert.match(route, /tasks\.processing/);
  assert.match(route, /webWorkerLauncher\.start/);
  assert.match(route, /status:\s*202/);
});
