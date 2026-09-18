// Run after next build (set TEST_NEXT_DIST_DIR for an isolated build).
// Uses a synthetic session and a local fake center; never calls model providers.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ADMIN_SESSION_COOKIE, createSessionToken } from '../../src/admin/auth.mjs';
import { PROMPT_CATALOG } from '../../src/prompt-catalog.mjs';
import { defaultBusinessPrompt } from '../../src/prompt-runtime.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const distDirectory = process.env.TEST_NEXT_DIST_DIR || '.next';

test('production traces include the prompt files needed by both the page and API', async () => {
  const promptFiles = ['prompts/post.md'];
  for (const directory of ['prompts/internal', 'prompts/business', 'server/prompts']) {
    for (const filename of await readdir(join(projectRoot, directory))) {
      if (filename.endsWith('.md')) promptFiles.push(`${directory}/${filename}`);
    }
  }
  for (const route of ['prompts/page.js.nft.json', 'api/prompt-runtime/route.js.nft.json']) {
    const tracePath = join(projectRoot, distDirectory, 'server/app', route);
    const trace = JSON.parse(await readFile(tracePath, 'utf8'));
    const files = new Set(trace.files.map(file => resolve(dirname(tracePath), file)));
    for (const file of promptFiles) assert.ok(files.has(resolve(projectRoot, file)), `${route} is missing ${file}`);
  }
});

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

test('production Next renders the prompt catalog and reads every bundled default through the API', {
  timeout: 60_000,
}, async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'xhs-prompt-next-'));
  const secret = randomBytes(32).toString('hex');
  const unexpectedRequests = [];
  const center = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const allowed = request.method === 'GET' && ['/v1/prompts', '/v1/settings', '/v1/knowledge'].includes(pathname);
    if (!allowed) unexpectedRequests.push(`${request.method} ${pathname}`);
    response.writeHead(allowed ? 200 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify(allowed ? { data: [] } : { error: { message: 'Unexpected fixture request' } }));
  });
  let child;
  let logs = '';
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    center.closeAllConnections();
    await new Promise((done) => center.close(done));
    const withinTemp = relative(resolve(tmpdir()), temporaryRoot);
    assert.ok(withinTemp && !withinTemp.startsWith('..') && !withinTemp.includes(':'));
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  const centerPort = await listen(center);
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((done) => probe.close(done));
  child = spawn(process.execPath, [join(projectRoot, 'node_modules/next/dist/bin/next'),
    'start', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: projectRoot, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
      XHS_NEXT_DIST_DIR: distDirectory,
      CONTROL_PLANE_URL: `http://127.0.0.1:${centerPort}`, EXECUTOR_NODE_ID: 'prompt-regression',
      XHS_SESSION_SECRET: secret, XHS_DB_PATH: join(temporaryRoot, 'queue.db'),
      XHS_OUTPUT_ROOT: join(temporaryRoot, 'output'), XHS_ASSET_ROOT: join(temporaryRoot, 'assets'),
      XHS_KNOWLEDGE_ROOT: join(temporaryRoot, 'knowledge') },
  });
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  child.on('error', error => { logs += error.message; });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    assert.equal(child.exitCode, null, logs);
    ready = await fetch(`${base}/login`, { signal: AbortSignal.timeout(1000) })
      .then(response => response.ok).catch(() => false);
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, logs);
  const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${createSessionToken(secret, { actor: {
    userId: 1, username: 'prompt-regression', roles: ['ADMIN'], credentialVersion: 1,
  } })}` };
  const page = await fetch(`${base}/prompts`, { headers, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  const html = await page.text();
  assert.equal(page.status, 200, logs);
  assert.ok(html.includes('Central prompt versions'), logs);
  for (const item of PROMPT_CATALOG) assert.ok(html.includes(item.kind), `Missing SSR prompt: ${item.kind}\n${logs}`);

  const response = await fetch(`${base}/api/prompt-runtime`, { headers, signal: AbortSignal.timeout(10_000) });
  const payload = await response.json();
  assert.equal(response.status, 200, `${JSON.stringify(payload)}\n${logs}`);
  assert.equal(payload.data.source, 'CENTER');
  assert.deepEqual(payload.data.catalog.map(({ kind, candidate }) => ({ kind, candidate })),
    PROMPT_CATALOG.map(({ kind }) => ({ kind, candidate: defaultBusinessPrompt(kind) })));
  assert.deepEqual(unexpectedRequests, []);
  assert.doesNotMatch(logs, /ERR_INVALID_ARG_TYPE/);
});
