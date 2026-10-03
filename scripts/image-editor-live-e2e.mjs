import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { inspectDevelopmentConfiguration, databaseIdentity } from './start-development.mjs';
import { hashUserPassword } from '../server/src/user-auth.mjs';
import { createImageEditingService } from '../server/src/image-editing.mjs';
import { createStandaloneImageEditor } from '../server/src/standalone-image-editor.mjs';
import { processImageEdit } from '../server/src/image-edit-renderer.mjs';

// This deliberately does not run a queue scanner, migrate a database, or load a model client.
// All mutable fixtures are owned by two newly created random development-only test accounts.
const args = process.argv.slice(2);
assert.ok(args.every(arg => arg === '--with-production-proof' || /^--report-prefix=[a-z0-9][a-z0-9-]{0,64}$/u.test(arg)), 'Unknown E2E argument');
const reportNames = args.filter(arg => arg.startsWith('--report-prefix='));
assert.ok(reportNames.length <= 1, 'Only one report prefix is allowed');
const reportPrefix = reportNames[0]?.slice('--report-prefix='.length) ?? 'image-editor-live-e2e';
const configuration = inspectDevelopmentConfiguration({ environment: {} });
const development = databaseIdentity(configuration.controlPlaneEnvironment.DATABASE_URL);
assert.equal(development.host, 'loopback');
assert.equal(development.database, 'xhs_control');
assert.notEqual(development.database, 'xhs_control_prod');
assert.equal(configuration.safeConfig.web.url, 'http://127.0.0.1:3002');
assert.equal(configuration.controlPlaneEnvironment.PROGRAMMATIC_IMAGE_WORKER_MODE, 'external');
const origin = configuration.safeConfig.web.url;
const centerUrl = configuration.safeConfig.controlPlane.url;
const reportFile = resolve(`reports/${reportPrefix}.json`);
const report = {
  startedAt: new Date().toISOString(), status: 'running', page: `${origin}/image-editor`,
  database: development.database, productionConnectionOpened: false, productionWrites: false,
  inputImages: 'Synthetic PNG fixtures rendered with Sharp; no model generated these images',
  modelCalls: 0, blockedModelRequests: 0, steps: [], assertions: [], expectedNegatives: [],
  browserErrors: [], unexpectedApiErrors: [], cleanup: {}, lazyLoading: {}, productionProof: [],
};
const password = `E2e!${randomBytes(24).toString('base64url')}`;
const observerPassword = `E2e!${randomBytes(24).toString('base64url')}`;
const suffix = randomBytes(9).toString('hex');
const username = `lazy_e2e_${suffix}`;
const observerUsername = `lazy_observe_${suffix}`;
const workerId = `image-editor-e2e-${suffix}`;
const pool = new pg.Pool({ connectionString: configuration.controlPlaneEnvironment.DATABASE_URL,
  max: 3, application_name: 'image-editor-scoped-e2e', statement_timeout: 30_000 });
const ownedWorkspaces = new Set();
const ownedUploads = new Set();
const ownedEdits = new Set();
const claims = new Map();
const createdAccounts = [];
const staticResponses = [];
const pendingResponses = new Set();
let account, observer, browser, page, phase = 'setup';
let imageService, standalone, fixtureWorkspace;

function safeError(error) {
  return String(error?.message ?? error).replaceAll(password, '[redacted]')
    .replaceAll(observerPassword, '[redacted]').replace(/postgres(?:ql)?:\/\/[^\s)]+/gu, '[database URL]');
}
function check(condition, description) {
  assert.ok(condition, description);
  report.assertions.push(description);
}
async function step(description, action) {
  const started = Date.now();
  console.log(description);
  await action();
  report.steps.push({ description, durationMs: Date.now() - started });
}
function actorHeaders(actor) {
  return { 'content-type': 'application/json', 'x-actor-user-id': String(actor.id),
    'x-actor-username': actor.username, 'x-actor-role': 'USER',
    'x-actor-credential-version': String(actor.credential_version) };
}
function actorIdentity(actor) {
  return { userId: Number(actor.id), username: actor.username, role: 'USER',
    credentialVersion: actor.credential_version };
}
async function centerRequest(path, { actor = account, body, method = body ? 'POST' : 'GET', expectedStatus } = {}) {
  const response = await fetch(`${centerUrl}${path}`, { method, headers: actorHeaders(actor),
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  const payload = await response.json().catch(() => null);
  if (expectedStatus !== undefined) {
    assert.equal(response.status, expectedStatus, `Unexpected status on ${method} ${path}`);
    report.expectedNegatives.push({ path, method, status: response.status, code: payload?.error?.code });
  } else assert.ok(response.ok, `${method} ${path}: ${response.status} ${payload?.error?.code ?? ''}`);
  return payload?.data;
}
async function waitUntil(predicate, description, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(done => setTimeout(done, 200));
  }
  throw new Error(`Timed out: ${description}`);
}
async function ownEdit(editId) {
  const row = (await pool.query(`SELECT e.id,e.task_id,e.operation,w.owner_id,e.created_by
    FROM image_edit_requests e JOIN standalone_image_workspaces w ON w.task_id=e.task_id WHERE e.id=$1`, [editId])).rows[0];
  assert.ok(row && ownedWorkspaces.has(Number(row.task_id)) && Number(row.owner_id) === Number(account.id));
  assert.equal(row.operation, 'SVG_DISCLOSURE');
  assert.equal(row.created_by, account.username);
  ownedEdits.add(editId);
  return row;
}
async function claimOnly(editId) {
  await ownEdit(editId);
  let claimed;
  await waitUntil(async () => {
    claimed = await imageService.claimProgrammatic(workerId, { editId });
    return Boolean(claimed);
  }, 'specific test SVG execution capacity', 45_000);
  assert.equal(claimed.id, editId);
  assert.equal(claimed.operation, 'SVG_DISCLOSURE');
  assert.equal(claimed.execution_id, null);
  claims.set(editId, claimed);
  return claimed;
}
async function renderOnly(claimed) {
  assert.ok(ownedEdits.has(claimed.id));
  const forbiddenModel = new Proxy({}, { get(_target, name) {
    return async () => { report.modelCalls += 1; throw new Error(`Model calls forbidden (${String(name)})`); };
  } });
  const result = await processImageEdit({ service: imageService,
    storageRoot: configuration.safeConfig.controlPlane.storageRoot, workerId, edit: claimed,
    environment: {}, agentClient: forbiddenModel });
  assert.equal(result.status, 'PREVIEW_READY', result.error ?? 'Programmatic renderer did not complete');
  claims.delete(claimed.id);
  const receipt = await centerRequest(`/v1/image-editor/edits/${claimed.id}`);
  check(receipt.result?.validation?.passed === true, 'Actual SVG result passes its image validation');
  check(receipt.result.validation.billedImageGeneration === false && receipt.result.validation.generationAttempts === 0,
    'Actual result reports zero billed image generation');
  report.programmaticResults ??= [];
  report.programmaticResults.push({ editId: claimed.id, assetId: Number(receipt.result.asset_id),
    status: receipt.status, sha256: receipt.result.validation.integrity.sha256,
    width: receipt.result.validation.dimensions.width, height: receipt.result.validation.dimensions.height,
    renderer: receipt.result.validation.renderer.engine,
    badgeVariant: receipt.result.validation.renderer.style.variant,
    badgeColor: receipt.result.validation.renderer.style.backgroundColor });
  return receipt;
}
async function login(context, webOrigin, actorUsername = username, actorPassword = password) {
  const loginPage = await context.newPage();
  await loginPage.goto(`${webOrigin}/login`, { waitUntil: 'domcontentloaded' });
  await loginPage.getByLabel('账号', { exact: true }).fill(actorUsername);
  await loginPage.getByLabel('密码', { exact: true }).fill(actorPassword);
  await loginPage.getByRole('button', { name: '进入后台', exact: true }).click();
  await loginPage.waitForURL('**/workbench/personal', { timeout: 45_000 });
  await loginPage.close();
}
function watchPage(target, webOrigin, collection = staticResponses, phaseSource = () => phase) {
  target.on('pageerror', error => report.browserErrors.push({ phase: phaseSource(), error: safeError(error) }));
  target.on('response', response => {
    const url = new URL(response.url());
    if (url.origin !== webOrigin) return;
    if (url.pathname.startsWith('/api/') && response.status() >= 400) {
      if ((url.pathname.endsWith('/image-editor/workspaces') || url.pathname.includes('/image-editor/uploads/')) && response.status() === 400 && phaseSource() === 'invalid-dimensions') {
        report.expectedNegatives.push({ path: url.pathname, status: response.status(), source: 'browser upload dimensions' });
      } else report.unexpectedApiErrors.push({ phase: phaseSource(), path: url.pathname, status: response.status() });
    }
    if (url.pathname.startsWith('/_next/static/') && /\.js$/u.test(url.pathname)) {
      const phaseAtResponse = phaseSource();
      const capture = response.body().then(body => collection.push({ path: url.pathname,
        phase: phaseAtResponse, bytes: body.byteLength, status: response.status(),
        containsEditorBody: body.includes(Buffer.from('data-disclosure-preview')) && body.includes(Buffer.from('保存并提交生图')),
        containsStandaloneName: body.includes(Buffer.from('StandaloneImageEditor')),
      })).catch(() => {});
      pendingResponses.add(capture); capture.finally(() => pendingResponses.delete(capture));
    }
  });
}
async function fenceRequests(context, webOrigin) {
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== webOrigin) {
      if (!['data:', 'blob:'].includes(url.protocol)) return route.abort();
      return route.continue();
    }
    if (url.pathname.startsWith('/api/control-plane/') && !['GET', 'HEAD'].includes(request.method())) {
      try {
        const path = url.pathname.replace('/api/control-plane', '');
        const binaryStage = /^\/v1\/image-editor\/uploads\/([0-9a-f-]{36})\/([1-5])$/u.exec(path);
        if (binaryStage && request.method() === 'POST') {
          ownedUploads.add(binaryStage[1]);
          report.binaryUploads ??= [];
          report.binaryUploads.push({ index: Number(binaryStage[2]), bytes: request.postDataBuffer()?.length ?? 0 });
          return route.continue();
        }
        const body = request.postDataJSON() ?? {};
        if (/^\/v1\/image-editor\/uploads\/[0-9a-f-]{36}$/u.test(path) && request.method() === 'DELETE') {
          assert.ok(ownedUploads.has(path.split('/')[4]));
        } else if (path === '/v1/image-editor/workspaces') {
          assert.ok(Array.isArray(body.images) || Array.isArray(body.uploads) && ownedUploads.has(body.requestId));
          if (body.uploads) check(!body.images, 'Workspace commit contains upload receipts and no base64 images');
        } else if (path === '/v1/image-editor/workspaces/delete') {
          assert.ok(body.workspaceIds.every(id => ownedWorkspaces.has(id)));
        } else if (/^\/v1\/image-editor\/workspaces\/\d+\/image-edits(?:\/batch)?$/u.test(path)) {
          const taskId = Number(path.split('/')[4]);
          assert.ok(ownedWorkspaces.has(taskId), 'Unowned workspace mutation');
          for (const edit of body.edits ?? [body]) {
            assert.equal(edit.operation, 'SVG_DISCLOSURE', 'Model operation blocked');
            assert.ok(!edit.confirmation, 'Billable confirmation blocked');
          }
        } else if (/^\/v1\/image-editor\/edits\/[^/]+\/(?:accept|reject|cancel|retry)$/u.test(path)) {
          assert.ok(ownedEdits.has(path.split('/')[4]), 'Unowned edit mutation');
        } else throw new Error('Non-SVG or unexpected mutation blocked');
      } catch (error) {
        report.blockedModelRequests += 1;
        report.unexpectedApiErrors.push({ phase, path: url.pathname, guard: safeError(error) });
        return route.abort();
      }
    }
    await route.continue();
  });
}
async function newPage(context) {
  const target = await context.newPage();
  target.setDefaultTimeout(30_000);
  watchPage(target, origin);
  return target;
}
async function currentWorkspace() {
  return centerRequest(`/v1/image-editor/workspaces/${fixtureWorkspace.id}`);
}
async function verifyIsolation(editId, assetId) {
  await centerRequest(`/v1/image-editor/workspaces/${fixtureWorkspace.id}`, { actor: observer, expectedStatus: 403 });
  await centerRequest(`/v1/image-editor/assets/${assetId}`, { actor: observer, expectedStatus: 403 });
  await centerRequest(`/v1/image-editor/edits/${editId}`, { actor: observer, expectedStatus: 403 });
  const observerList = await centerRequest('/v1/image-editor/workspaces?queue=true', { actor: observer });
  check(observerList.total === 0 && observerList.items.length === 0, 'Different account cannot list the private test workspace');
  await centerRequest(`/v1/tasks/${fixtureWorkspace.id}`, { expectedStatus: 404 });
  check(true, 'Standalone workspace remains isolated from the business task API');
}
async function availablePort() {
  const socket = createServer();
  await new Promise(done => socket.listen(0, '127.0.0.1', done));
  const port = socket.address().port;
  await new Promise(done => socket.close(done));
  return port;
}
async function productionProof(directory, label) {
  await readFile(resolve(directory, 'BUILD_ID'), 'utf8');
  const port = await availablePort(), webOrigin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], {
    shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...configuration.webEnvironment, NODE_ENV: 'production', XHS_NEXT_DIST_DIR: directory,
      DATABASE_URL: configuration.controlPlaneEnvironment.DATABASE_URL,
      XHS_SESSION_SECRET: randomBytes(48).toString('base64url') },
  });
  let context;
  let output = '';
  child.stdout.on('data', value => { output = (output + value).slice(-3000); });
  child.stderr.on('data', value => { output = (output + value).slice(-3000); });
  try {
    await waitUntil(async () => {
      if (child.exitCode !== null) throw new Error(`Isolated Next ${label} stopped: ${safeError(output)}`);
      return fetch(`${webOrigin}/login`).then(response => response.ok, () => false);
    }, `production ${label} server`, 45_000);
    context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === webOrigin ? route.continue() : route.abort());
    await login(context, webOrigin);
    const proofPage = await context.newPage();
    const resources = [];
    let proofPhase = 'list';
    watchPage(proofPage, webOrigin, resources, () => `production-${label}-${proofPhase}`);
    await proofPage.goto(`${webOrigin}/image-editor`, { waitUntil: 'networkidle' });
    await proofPage.getByRole('region', { name: '图片编辑列表' }).getByText(`编辑器按需加载 ${suffix}`, { exact: true }).waitFor();
    await Promise.allSettled([...pendingResponses]);
    const initial = resources.filter(resource => resource.phase.endsWith('-list'));
    proofPhase = 'open';
    await proofPage.getByRole('region', { name: '图片编辑列表' }).getByRole('button', { name: '查看 / 编辑', exact: true }).click();
    await proofPage.getByRole('region', { name: '图片编辑组件' }).waitFor();
    await proofPage.waitForLoadState('networkidle');
    await Promise.allSettled([...pendingResponses]);
    const opened = resources.filter(resource => resource.phase.endsWith('-open'));
    const evidence = { directory, initialJsRequests: initial.length,
      initialDecodedJsBytes: initial.reduce((sum, resource) => sum + resource.bytes, 0),
      initialEditorBodyChunks: initial.filter(resource => resource.containsEditorBody),
      openedAdditionalJsRequests: opened.length,
      openedEditorBodyChunks: opened.filter(resource => resource.containsEditorBody), resources };
    if (label === 'before') check(evidence.initialEditorBodyChunks.length > 0, 'Before build downloads editor body while showing only the list');
    else {
      check(evidence.initialEditorBodyChunks.length === 0, 'After production build does not download editor body for the list');
      check(evidence.openedEditorBodyChunks.length > 0, 'After production build downloads editor body only when workspace opens');
      const editorPath = evidence.openedEditorBodyChunks[0].path;
      const state = await context.storageState();
      const delayedContext = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 1050 } });
      let releaseChunk;
      const chunkGate = new Promise(done => { releaseChunk = done; });
      let delayedRequests = 0;
      try {
        await delayedContext.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.origin !== webOrigin) return route.abort();
          if (url.pathname === editorPath) { delayedRequests += 1; await chunkGate; }
          await route.continue();
        });
        const delayedPage = await delayedContext.newPage();
        delayedPage.on('pageerror', error => report.browserErrors.push({ phase: 'production-after-delayed-chunk', error: safeError(error) }));
        await delayedPage.goto(`${webOrigin}/image-editor`, { waitUntil: 'networkidle' });
        await delayedPage.getByRole('region', { name: '图片编辑列表' }).getByRole('button', { name: '查看 / 编辑', exact: true }).click();
        await delayedPage.getByRole('status').filter({ hasText: '正在加载图片编辑器' }).waitFor();
        check(await delayedPage.getByRole('heading', { name: '编辑图片', exact: true }).isVisible(),
          'Editor header remains usable while its JavaScript chunk is delayed');
        releaseChunk();
        await delayedPage.getByRole('region', { name: '图片编辑组件' }).waitFor();
        check(delayedRequests > 0, 'Deferred production editor shows a loading state until its actual chunk arrives');
      } finally { releaseChunk(); await delayedContext.close(); }
      const failureContext = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 1050 } });
      let abortChunk = true, failedChunkRequests = 0;
      const expectedLoadErrors = [];
      try {
        await failureContext.route('**/*', route => {
          const url = new URL(route.request().url());
          if (url.origin !== webOrigin) return route.abort();
          if (abortChunk && url.pathname === editorPath) { failedChunkRequests += 1; return route.abort('failed'); }
          return route.continue();
        });
        const failurePage = await failureContext.newPage();
        failurePage.on('pageerror', error => expectedLoadErrors.push(safeError(error)));
        await failurePage.goto(`${webOrigin}/image-editor?workspace=${fixtureWorkspace.id}`, { waitUntil: 'domcontentloaded' });
        await failurePage.getByRole('alert').filter({ hasText: '图片编辑器暂时无法打开' }).waitFor();
        check(failedChunkRequests > 0, 'A failed editor chunk presents the explicit recoverable error');
        abortChunk = false;
        await failurePage.getByRole('button', { name: '重新加载编辑器', exact: true }).click();
        await failurePage.getByRole('region', { name: '图片编辑组件' }).waitFor();
        check(new URL(failurePage.url()).searchParams.get('workspace') === String(fixtureWorkspace.id),
          'Reload recovery retains the selected workspace URL and restores its editor');
        evidence.chunkRecovery = { failedChunkRequests, recovered: true, expectedLoadErrors };
        report.expectedNegatives.push({ source: 'deliberately aborted editor JavaScript chunk', failedChunkRequests, recovered: true });
      } finally { await failureContext.close(); }
    }
    report.productionProof.push(evidence);
  } finally {
    await context?.close();
    child.kill();
    await new Promise(done => { if (child.exitCode !== null) done(); else child.once('exit', done); });
  }
}

try {
  await mkdir(resolve('reports'), { recursive: true });
  assert.equal((await pool.query('SELECT current_database() AS database')).rows[0].database, 'xhs_control');
  check(true, 'Development database and storage are separated from production before any fixture write');
  await waitUntil(async () => fetch(`${centerUrl}/health`).then(response => response.ok, () => false), 'development center health', 60_000);
  await waitUntil(async () => fetch(`${origin}/login`).then(response => response.ok, () => false), 'development web login', 60_000);
  imageService = createImageEditingService({ pool, storageRoot: configuration.safeConfig.controlPlane.storageRoot });
  standalone = createStandaloneImageEditor({ pool, storageRoot: configuration.safeConfig.controlPlane.storageRoot });
  for (const [name, secret] of [[username, password], [observerUsername, observerPassword]]) {
    const actor = (await pool.query(`INSERT INTO app_users(username,display_name,role,password_hash,must_change_password)
      VALUES($1,$2,'USER',$3,false) RETURNING id,username,credential_version`,
    [name, `按需加载验证 ${name === username ? '操作账号' : '隔离账号'}`, await hashUserPassword(secret)])).rows[0];
    createdAccounts.push(actor);
  }
  [account, observer] = createdAccounts;
  report.testAccountIds = createdAccounts.map(value => Number(value.id));
  browser = await chromium.launch({ channel: process.env.IMAGE_EDIT_BROWSER_CHANNEL ?? 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true });
  await fenceRequests(context, origin);
  await step('Log in with a new private development test account', () => login(context, origin));
  page = await newPage(context);
  phase = 'initial-list';
  await page.goto(`${origin}/image-editor`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '图片编辑', exact: true }).waitFor();
  await Promise.allSettled([...pendingResponses]);
  const initial = staticResponses.filter(resource => resource.phase === phase);
  report.lazyLoading.initialResources = initial;
  check(await page.getByRole('region', { name: '图片编辑组件' }).count() === 0, 'Editor is not mounted on the initial list');
  check(initial.every(resource => !resource.containsEditorBody), 'Initial development list does not download the editor body');
  await page.screenshot({ path: resolve(`reports/${reportPrefix}-list.png`), fullPage: true });

  await step('Verify the live upload proxy bounds a streaming body without Content-Length', async () => {
    const cookie = (await context.cookies(origin)).map(value => `${value.name}=${value.value}`).join('; ');
    let index = 0;
    const body = new ReadableStream({ pull(controller) {
      if (index++ < 6) controller.enqueue(new Uint8Array(1024 * 1024)); else controller.close();
    } });
    const response = await fetch(`${origin}/api/control-plane/v1/image-editor/uploads/${randomUUID()}/1`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'image/png' }, body, duplex: 'half',
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, 'PAYLOAD_TOO_LARGE');
    check(true, 'Actual Next upload proxy rejects an oversized streaming request without buffering all images');
  });

  const images = await Promise.all(['#e6f0ec', '#d5e7f6'].map(background => sharp({
    create: { width: 1086, height: 1448, channels: 4, background },
  }).png().toBuffer()));
  await step('Check upload validation and create a two-image private workspace', async () => {
    phase = 'upload-validation';
    await page.getByRole('button', { name: '新增图片', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const input = page.getByLabel('上传待编辑图片', { exact: true });
    await input.setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
    await dialog.getByRole('alert').filter({ hasText: 'PNG/JPEG/WebP' }).waitFor();
    report.expectedNegatives.push({ source: 'client upload type validation', networkWrite: false });
    await input.setInputFiles({ name: 'too-large.png', mimeType: 'image/png', buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
    await dialog.getByRole('alert').filter({ hasText: 'MiB' }).waitFor();
    report.expectedNegatives.push({ source: 'client upload size validation', networkWrite: false });
    phase = 'invalid-dimensions';
    const invalid = await sharp({ create: { width: 20, height: 20, channels: 4, background: 'white' } }).png().toBuffer();
    await input.setInputFiles({ name: 'invalid-dimensions.png', mimeType: 'image/png', buffer: invalid });
    await dialog.getByRole('alert').filter({ hasText: '1086' }).waitFor();
    phase = 'open-editor';
    await page.getByLabel('图片名称（可选）').fill(`编辑器按需加载 ${suffix}`);
    const uploadResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/control-plane/v1/image-editor/workspaces'
      && response.request().method() === 'POST' && response.status() === 201);
    await input.setInputFiles(images.map((buffer, index) => ({ name: `synthetic-page-${index + 1}.png`, mimeType: 'image/png', buffer })));
    fixtureWorkspace = (await (await uploadResponse).json()).data;
    ownedWorkspaces.add(fixtureWorkspace.id);
    report.workspaceIds = [...ownedWorkspaces];
    const stored = (await pool.query('SELECT owner_id FROM standalone_image_workspaces WHERE task_id=$1', [fixtureWorkspace.id])).rows[0];
    assert.equal(Number(stored.owner_id), Number(account.id));
    await page.getByRole('region', { name: '图片编辑组件' }).waitFor();
    await page.getByLabel('人工生成标识文字', { exact: true }).waitFor();
    await waitUntil(async () => !(await page.getByLabel('人工生成标识文字', { exact: true }).isDisabled()), 'editor initial history loaded');
    check(fixtureWorkspace.assets.length === 2, 'Actual upload creates two correctly sized source images');
    await Promise.allSettled([...pendingResponses]);
    report.lazyLoading.openedResources = staticResponses.filter(resource => resource.phase === phase);
    check(report.lazyLoading.openedResources.some(resource => resource.containsEditorBody), 'Opening a development workspace downloads the editor body');
    await page.getByRole('button', { name: '第 2 张', exact: true }).click();
    await waitUntil(async () => !(await page.getByLabel('人工生成标识文字', { exact: true }).isDisabled()), 'page 2 editor load');
    check(await page.getByLabel('选择第 2 页').isChecked(), 'Switching image pages uses the correct source and default selection');
    await page.getByRole('button', { name: '第 1 张', exact: true }).click();
    await waitUntil(async () => !(await page.getByLabel('人工生成标识文字', { exact: true }).isDisabled()), 'page 1 editor load');
    check(await page.getByLabel('选择第 1 页').isChecked(), 'Switching back resets the editor to page 1');
  });

  async function saveSvg(text, color, targetPage) {
    await page.getByRole('button', { name: '程序叠加（SVG + Sharp）', exact: true }).click();
    for (let number = 1; number <= fixtureWorkspace.assets.length; number += 1) {
      const checkbox = page.getByLabel(`选择第 ${number} 页`, { exact: true });
      if (number === targetPage) await checkbox.check(); else await checkbox.uncheck();
    }
    await page.getByLabel('人工生成标识文字', { exact: true }).fill(text);
    await page.getByRole('radio', { name: '自定义颜色', exact: true }).check();
    await page.getByLabel('程序标识颜色值', { exact: true }).fill(color);
    const style = page.getByRole('combobox', { name: '程序标识样式', exact: true });
    await style.click(); await page.getByRole('option', { name: '实心徽章', exact: true }).click();
    check(await page.getByText(/本次对已选 1 张图片生成程序标识，不调用模型/u).count() > 0,
      'Programmatic submission visibly requires no model cost confirmation');
    const submitted = page.waitForResponse(response => new URL(response.url()).pathname === `/api/control-plane/v1/image-editor/workspaces/${fixtureWorkspace.id}/image-edits`
      && response.request().method() === 'POST' && response.status() === 201);
    await page.getByRole('button', { name: '生成已选 1 张程序标识预览', exact: true }).click();
    const created = (await (await submitted).json()).data;
    await ownEdit(created.id);
    assert.equal(created.target_page, targetPage);
    assert.equal(created.config.overlay.text, text);
    assert.equal(created.config.overlay.badgeColor, color.toUpperCase());
    assert.equal(created.config.overlay.badgeVariant, 'solid-pill');
    assert.equal(created.execution_id, null);
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('region', { name: '图片编辑列表' }).getByText('准备处理', { exact: true }).waitFor();
    return created;
  }
  let firstEdit, ready;
  await step('Save SVG parameters through the actual page and check queued/running read-only states', async () => {
    phase = 'svg-submit-page-1';
    firstEdit = await saveSvg('人工生成', '#234567', 1);
    const claimed = await claimOnly(firstEdit.id);
    const list = page.getByRole('region', { name: '图片编辑列表' });
    await list.getByRole('button', { name: '刷新', exact: true }).click();
    await list.getByText('程序处理中', { exact: true }).waitFor();
    check(await list.getByRole('button', { name: '删除', exact: true }).isDisabled(), 'Running private workspace cannot be deleted');
    await list.getByRole('button', { name: '查看', exact: true }).click();
    await page.getByRole('heading', { name: '查看图片', exact: true }).waitFor();
    check(await page.getByLabel('人工生成标识文字', { exact: true }).isDisabled(), 'Running editor settings are read-only');
    check(await page.getByRole('button', { name: /生成已选 1 张程序标识预览/u }).isDisabled(), 'Running editor cannot resubmit');
    phase = 'svg-real-render';
    ready = await renderOnly(claimed);
    await page.getByRole('link', { name: '下载图片', exact: true }).waitFor();
    await waitUntil(async () => await page.getByRole('button', { name: '生成已选 1 张程序标识预览', exact: true }).isEnabled(), 'completed editor editable');
    await verifyIsolation(firstEdit.id, ready.result.asset_id);
  });
  await step('Verify actual result pixels, preview, download and parameters after reopening', async () => {
    phase = 'download-and-reopen';
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('link', { name: '下载图片', exact: true }).click();
    const download = await downloadEvent;
    const downloadFile = resolve(`reports/${reportPrefix}-result.png`);
    await download.saveAs(downloadFile);
    const bytes = await readFile(downloadFile);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), ready.result.validation.integrity.sha256);
    const metadata = await sharp(bytes).metadata();
    check(metadata.width === 1086 && metadata.height === 1448, 'Downloaded real rendered image retains exact dimensions');
    check(!bytes.equals(images[0]), 'Actual programmatic result differs from the original synthetic input');
    await page.getByRole('tab', { name: /^编辑记录/u }).click();
    await page.getByRole('button', { name: '在左侧对比', exact: true }).click();
    check(await page.getByRole('region', { name: '图片预览' }).locator('img').count() >= 2, 'Preview can compare source and actual result');
    await page.screenshot({ path: resolve(`reports/${reportPrefix}-preview.png`), fullPage: true });
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await page.getByRole('region', { name: '图片编辑列表' }).getByRole('button', { name: '查看 / 编辑', exact: true }).click();
    await waitUntil(async () => !(await page.getByLabel('人工生成标识文字', { exact: true }).isDisabled()), 'reopened editor hydrated');
    assert.equal(await page.getByLabel('人工生成标识文字', { exact: true }).inputValue(), '人工生成');
    assert.equal(await page.getByLabel('程序标识颜色值', { exact: true }).inputValue(), '#234567');
    assert.equal(await page.getByRole('combobox', { name: '程序标识样式', exact: true }).textContent(), '实心徽章');
    check(true, 'Reopening restores saved text, color and programmatic badge style');
  });
  async function adoptCurrentPreview(editId) {
    await page.getByRole('tab', { name: /^编辑记录/u }).click();
    await page.getByRole('button', { name: '采用此版本', exact: true }).first().click();
    await page.getByLabel('采用此版本操作原因', { exact: true }).fill('开发库按需加载端到端验证，实际程序结果符合要求');
    await page.getByRole('button', { name: '确认采用此版本', exact: true }).click();
    await waitUntil(async () => (await centerRequest(`/v1/image-editor/edits/${editId}`)).status === 'ACCEPTED', 'preview adoption');
  }
  await step('Adopt from history, switch to the second image and complete another real SVG edit', async () => {
    phase = 'adopt-and-repeat';
    await adoptCurrentPreview(firstEdit.id);
    const adopted = await currentWorkspace();
    check(adopted.runId !== fixtureWorkspace.runId && adopted.assets[0].id === ready.result.asset_id,
      'History adoption changes the current run and the correct image');
    await page.getByRole('button', { name: '第 2 张', exact: true }).click();
    await waitUntil(async () => !(await page.getByLabel('人工生成标识文字', { exact: true }).isDisabled()), 'second image editor');
    const secondEdit = await saveSvg('程序验证', '#345678', 2);
    await renderOnly(await claimOnly(secondEdit.id));
    await page.getByRole('region', { name: '图片编辑列表' }).getByRole('button', { name: '刷新', exact: true }).click();
    await page.getByRole('region', { name: '图片编辑列表' }).getByRole('button', { name: '查看 / 编辑', exact: true }).click();
    await page.getByRole('button', { name: '第 2 张', exact: true }).click();
    await waitUntil(async () => !(await page.getByLabel('人工生成标识文字', { exact: true }).isDisabled()), 'second result history');
    await adoptCurrentPreview(secondEdit.id);
    const completed = await currentWorkspace();
    check(completed.runs.length >= 3 && completed.assets[0].id !== fixtureWorkspace.assets[0].id
      && completed.assets[1].id !== fixtureWorkspace.assets[1].id, 'Both page edits are adopted and historical image runs remain available');
    const history = page.getByRole('combobox', { name: '历史图片版本', exact: true });
    await waitUntil(async () => history.isEnabled(), 'post-adoption editor history refresh');
    check(await history.isEnabled(), 'Historical versions remain selectable after lazy editor loading');
    await history.click();
    check(await page.getByRole('option').count() >= 2, 'Original and intermediate historical versions are listed');
    await page.keyboard.press('Escape');
    report.limits = ['Historical restore execution was not submitted because it can require a vision model; history selection and actual preview adoption were verified.'];
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('tab', { name: /^记录/u }).click();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile editor stays within the viewport');
    await page.screenshot({ path: resolve(`reports/${reportPrefix}-mobile.png`), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  });
  if (args.includes('--with-production-proof')) {
    await step('Compare before/after production JavaScript loading using the private workspace', async () => {
      await productionProof('.next-image-editor-before', 'before');
      await productionProof('.next-image-editor-e2e', 'after');
    });
  }
  await step('Soft delete only the private E2E workspace through the real page', async () => {
    phase = 'delete-own-workspace';
    await page.getByRole('region', { name: '图片编辑列表' }).getByRole('button', { name: '刷新', exact: true }).click();
    await page.getByRole('region', { name: '图片编辑列表' }).getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '确认删除', exact: true }).click();
    await page.getByText('暂无图片，点击右上角“新增图片”开始编辑。', { exact: true }).waitFor();
    await centerRequest(`/v1/image-editor/workspaces/${fixtureWorkspace.id}`, { expectedStatus: 404 });
    check(true, 'Private soft-deleted workspace is no longer readable');
  });
  await Promise.allSettled([...pendingResponses]);
  check(report.modelCalls === 0 && report.blockedModelRequests === 0, 'No model function or billable model request was made');
  const calls = Number((await pool.query(`SELECT count(*)::integer AS count FROM model_call_traces
    WHERE task_id=ANY($1::bigint[])`, [[...ownedWorkspaces]])).rows[0].count);
  check(calls === 0, 'Owned workspaces contain no model call traces');
  check(report.browserErrors.length === 0, 'Browser reported no unexpected JavaScript errors');
  check(report.unexpectedApiErrors.length === 0, 'Browser API errors are limited to explicitly verified upload negatives');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = safeError(error);
  if (page) await page.screenshot({ path: resolve(`reports/${reportPrefix}-failure.png`), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  report.cleanup.workspaces = [];
  if (imageService && standalone && account) {
    for (const claimed of claims.values()) {
      try { await imageService.fail(claimed, new Error('Scoped development E2E cleanup')); }
      catch (error) { report.cleanup.claimFailure = safeError(error); }
    }
    for (const taskId of ownedWorkspaces) {
      try {
        const row = (await pool.query('SELECT owner_id FROM standalone_image_workspaces WHERE task_id=$1', [taskId])).rows[0];
        assert.equal(Number(row?.owner_id), Number(account.id));
        await standalone.remove({ requestId: randomUUID(), workspaceIds: [taskId] }, actorIdentity(account));
        report.cleanup.workspaces.push({ taskId, softDeleted: true });
      } catch (error) { report.cleanup.workspaces.push({ taskId, softDeleted: false, error: safeError(error) }); }
    }
  }
  report.cleanup.accounts = [];
  for (const actor of createdAccounts) {
    try {
      const result = await pool.query(`UPDATE app_users SET status='DISABLED',credential_version=credential_version+1,
        version=version+1,updated_at=now() WHERE id=$1 AND username=$2 RETURNING id,status`, [actor.id, actor.username]);
      report.cleanup.accounts.push({ id: Number(actor.id), status: result.rows[0]?.status });
    } catch (error) { report.cleanup.accounts.push({ id: Number(actor.id), error: safeError(error) }); }
  }
  await pool.end().catch(() => {});
  report.finishedAt = new Date().toISOString();
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, steps: report.steps.length, modelCalls: report.modelCalls,
    browserErrors: report.browserErrors.length, unexpectedApiErrors: report.unexpectedApiErrors.length,
    failure: report.failure, report: reportFile, cleanup: report.cleanup }));
}
