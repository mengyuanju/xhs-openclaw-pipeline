// Recover a previously established isolated functional database for coordinated UI audits.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { access, readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PostgresControlPlaneRepository } from '../server/src/postgres-repository.mjs';
import { createControlPlaneApp } from '../server/src/http-server.mjs';

const connectionString = process.env.XHS_FUNCTIONAL_HOLD_DATABASE;
const storageRoot = await realpath(resolve(process.env.XHS_FUNCTIONAL_HOLD_STORAGE ?? ''));
assert.equal(new URL(connectionString).hostname, '127.0.0.1'); assert.notEqual(new URL(connectionString).port, '5432');
assert.ok(storageRoot.startsWith(await realpath(tmpdir()) + '\\xhs-functional-100-'));
const reportRoot = resolve('reports/full-functional-2026-10-02');
const productionMode = process.env.XHS_FUNCTIONAL_HOLD_MODE === 'production';
const distDir = process.env.XHS_FUNCTIONAL_HOLD_DIST_DIR ?? '.next-functional-100-hold';
const repository = new PostgresControlPlaneRepository({ connectionString });
assert.equal((await repository.pool.query('SELECT count(*)::int n FROM tasks')).rows[0].n, 100);
assert.equal((await repository.getUserByUsername('functional-helper')).role, 'ADMIN');
const app = createControlPlaneApp({ repository, storageRoot, storageOptimizationEnabled: false,
  logger: { info() {}, error() {} }, analyzeCopy: async () => { throw Error('No model calls in recovered synthetic audit'); },
  analyzeVisual: async () => { throw Error('No model calls in recovered synthetic audit'); } });
const center = await new Promise(done => { const s = app.listen(Number(process.env.XHS_FUNCTIONAL_HOLD_CENTER_PORT ?? 0), '127.0.0.1', () => done(s)); });
const centerUrl = `http://127.0.0.1:${center.address().port}`;
const portServer = createServer(); await new Promise(done => portServer.listen(0, '127.0.0.1', done));
const port = Number(process.env.XHS_FUNCTIONAL_HOLD_WEB_PORT ?? portServer.address().port); await new Promise(done => portServer.close(done)); const origin = `http://127.0.0.1:${port}`;
const originalFiles = new Map(await Promise.all(['tsconfig.json', 'next-env.d.ts'].map(async f => [f, await readFile(f, 'utf8')])));
const next = spawn(process.execPath, ['node_modules/next/dist/bin/next', productionMode ? 'start' : 'dev', '-H', '127.0.0.1', '-p', String(port)], {
  shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: productionMode ? 'production' : 'development',
    XHS_NEXT_DIST_DIR: distDir, CONTROL_PLANE_URL: centerUrl, XHS_SESSION_SECRET: randomUUID() + randomUUID(),
    XHS_PREVIEW_BASE_URL: '', PREVIEW_BASE_URL: ' ', PREVIEW_API_KEY: ' ', DEEPSEEK_API_KEY: ' ', XHS_DOTS_API_KEY: ' ',
    XHS_SEARCH_MACHINE_TOKEN: ' ', NEXT_TELEMETRY_DISABLED: '1' } });
let logs = ''; next.stdout.on('data', c => { logs += c; }); next.stderr.on('data', c => { logs += c; });
const releaseSignal = join(storageRoot, 'release-functional-hold');
const evidence = { startedAt: new Date().toISOString(), origin, centerUrl, releaseSignal, storageRoot,
  isolatedDatabasePort: new URL(connectionString).port, existingServicesTouched: false, modelCalls: 0, taskCountAtStart: 100,
  nextMode: productionMode ? 'production' : 'development', distDir };
try {
  const deadline = Date.now() + 180000;
  while (!await fetch(origin + '/login', { signal: AbortSignal.timeout(15000) }).then(r => r.ok, () => false)) {
    assert.equal(next.exitCode, null, 'Recovered Next service failed'); assert.ok(Date.now() < deadline, 'Recovered Next startup timeout');
    await new Promise(done => setTimeout(done, 500));
  }
  await writeFile(join(reportRoot, 'functional-active-environment.json'), JSON.stringify(evidence, null, 2));
  console.log('FUNCTIONAL_HOLD_READY ' + JSON.stringify(evidence));
  const end = Date.now() + 3 * 60 * 60_000;
  while (!await access(releaseSignal).then(() => true, () => false) && Date.now() < end) await new Promise(done => setTimeout(done, 500));
} finally {
  next.kill(); await new Promise(done => next.once('exit', done)); await new Promise(done => center.close(done));
  await app.context.disposeControlPlaneResources?.(); await repository.pool.end();
  for (const [file, original] of originalFiles) { const current = await readFile(file, 'utf8');
    if (file === 'next-env.d.ts' && current.includes(`./${distDir}/`)) await writeFile(file, original);
    if (file === 'tsconfig.json' && current.replace(`,\n    "${distDir}/types/**/*.ts",\n    "${distDir}/dev/types/**/*.ts"`, '') === original) await writeFile(file, original); }
  evidence.closedAt = new Date().toISOString(); await writeFile(join(reportRoot, 'functional-active-environment.json'), JSON.stringify(evidence, null, 2));
  await writeFile(join(reportRoot, 'functional-hold-next.log'), logs.replace(/([?&](?:password|currentPassword|newPassword|deletionPassword)=)[^&\s]*/gu, '$1[REDACTED]'));
}
