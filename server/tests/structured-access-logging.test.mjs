import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createControlPlaneApp } from '../src/http-server.mjs';

test('access logs correlate response ids without recording request secrets', async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'control-plane-log-'));
  const lines = [];
  const logger = { info: (line) => lines.push(line), error: (line) => lines.push(line) };
  const app = createControlPlaneApp({
    storageRoot,
    logger,
    repository: { health: async () => ({ ok: true }) },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await app.context.disposeControlPlaneResources?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(storageRoot, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  const healthy = await fetch(`${origin}/health`, {
    headers: { cookie: 'session=never-log-this', authorization: 'Bearer never-log-this' },
  });
  const rejected = await fetch(`${origin}/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'password=never-log-this' },
    body: JSON.stringify({ password: 'never-log-this' }),
  });

  assert.equal(healthy.status, 200);
  assert.equal(rejected.status, 401);
  assert.equal(lines.length, 2);
  const records = lines.map(JSON.parse);
  assert.deepEqual(records.map((record) => record.requestId), [
    healthy.headers.get('x-request-id'), rejected.headers.get('x-request-id'),
  ]);
  assert.deepEqual(records.map((record) => record.status), [200, 401]);
  assert.deepEqual(records.map((record) => record.route), ['/health', '/v1/tasks']);
  assert.ok(records.every((record) => record.event === 'control_plane_access'
    && record.durationMs >= 0 && typeof record.timestamp === 'string'));
  assert.doesNotMatch(lines.join('\n'), /never-log-this|cookie|authorization|password/iu);
});
