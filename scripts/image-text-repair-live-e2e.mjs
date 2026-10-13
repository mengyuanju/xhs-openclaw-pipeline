import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { inspectDevelopmentConfiguration, databaseIdentity } from './start-development.mjs';
import { hashUserPassword } from '../server/src/user-auth.mjs';
import { decodeModelCallPayload } from '../server/src/model-call-payload-archive.mjs';
import { createControlPlaneClient } from '../src/control-plane/client.mjs';
import { executeImageEditClaim } from '../src/executor/agent.mjs';
import { guardExecutionCalls, runWithExecutionSignal } from '../src/executor/execution-signal.mjs';
import { safeTraceText, withModelCallTracing } from '../src/model-call-trace.mjs';
import { imageHash, assertOutsideMask, EDIT_WIDTH, EDIT_HEIGHT } from '../src/image-edit-pixels.mjs';
import { normalizeTextRepairs, renderTextRepairMask } from '../src/image-text-repair.mjs';
import { getTextRepairFontMetadata } from '../src/text-repair-font.mjs';

// Manual, quota-consuming development runner. Never included in npm test.
// Source requests/assets are read-only. Only a new private account, its uploaded
// workspaces, and this runner's unique executor may be mutated.
const SOURCE_TASKS = Object.freeze([1760, 1768, 1764]);
const UUID = /^[a-f0-9-]{36}$/iu;
const FEE_LABEL = '确认错字定位、复杂背景清理和视觉校验会调用模型并产生费用；参考字形与最终文字由标准字体绘制并由程序合成，完成后检查预览再采用。';

function validParagraphPadding(value) {
  assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= 16, 'Paragraph padding must be an integer from 0 to 16 pixels');
  return value;
}

export function parseLiveTextRepairOptions(args) {
  assert.ok(args.includes('--real-models'), 'Real model calls require explicit --real-models and prior user authorization');
  assert.ok(args.every(arg => arg === '--real-models' || /^--source-tasks=\d+(?:,\d+)*$/u.test(arg)
    || /^--timeout-ms=\d+$/u.test(arg) || /^--paragraph-padding=\d+$/u.test(arg)), 'Unknown live E2E argument');
  const sources = args.filter(arg => arg.startsWith('--source-tasks='));
  const timeouts = args.filter(arg => arg.startsWith('--timeout-ms='));
  const paddings = args.filter(arg => arg.startsWith('--paragraph-padding='));
  assert.ok(sources.length <= 1 && timeouts.length <= 1 && paddings.length <= 1, 'Duplicate live E2E option');
  const sourceTasks = sources.length ? sources[0].slice(15).split(',').map(Number) : [...SOURCE_TASKS];
  assert.ok(sourceTasks.length && new Set(sourceTasks).size === sourceTasks.length
    && sourceTasks.every(id => SOURCE_TASKS.includes(id)), 'Only the explicitly scoped historical source tasks are allowed');
  const timeoutMs = timeouts.length ? Number(timeouts[0].slice(13)) : 18 * 60_000;
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 60_000 && timeoutMs <= 30 * 60_000, 'Invalid model execution timeout');
  const paragraphPadding = validParagraphPadding(paddings.length ? Number(paddings[0].slice('--paragraph-padding='.length)) : 0);
  return { sourceTasks, timeoutMs, paragraphPadding, realModels: true };
}

export function paddedTextRepairParagraphs(repairs, padding = 0) {
  validParagraphPadding(padding);
  return normalizeTextRepairs(repairs).map(item => {
    const x = Math.max(0, item.region.x - padding), y = Math.max(0, item.region.y - padding);
    const right = Math.min(EDIT_WIDTH, item.region.x + item.region.width + padding);
    const bottom = Math.min(EDIT_HEIGHT, item.region.y + item.region.height + padding);
    return { ...item, region: { x, y, width: right - x, height: bottom - y } };
  });
}

function within(root, path) {
  const result = relative(root, path);
  return result !== '..' && !result.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(result);
}

function requestData(prompt) {
  const value = String(prompt ?? '').match(/<untrusted_image_text_repair_request>\s*([\s\S]*?)\s*<\/untrusted_image_text_repair_request>/u)?.[1];
  if (!value) return null;
  return JSON.parse(value);
}

async function waitUntil(predicate, label, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(done => setTimeout(done, 300));
  }
  throw new Error(`Timed out: ${label}`);
}

async function equalPixels(first, second) {
  const [a, b] = await Promise.all([first, second].map(bytes => sharp(bytes).ensureAlpha().raw().toBuffer()));
  return a.equals(b);
}

export async function drawTextRepairSelection(page, preview, region) {
  const dimensions = { width: EDIT_WIDTH, height: EDIT_HEIGHT };
  const scroll = await preview.evaluate((element, { region, dimensions }) => {
    let pane = element.parentElement;
    while (pane && !/auto|scroll/u.test(`${getComputedStyle(pane).overflowX} ${getComputedStyle(pane).overflowY}`)) pane = pane.parentElement;
    if (!pane) return { found: false };
    const image = element.getBoundingClientRect(), bounds = pane.getBoundingClientRect();
    const before = { x: pane.scrollLeft, y: pane.scrollTop };
    const center = { x: image.left + (region.x + region.width / 2) * image.width / dimensions.width,
      y: image.top + (region.y + region.height / 2) * image.height / dimensions.height };
    const visible = { left: Math.max(0, bounds.left + pane.clientLeft), top: Math.max(0, bounds.top + pane.clientTop),
      right: Math.min(innerWidth, bounds.left + pane.clientLeft + pane.clientWidth),
      bottom: Math.min(innerHeight, bounds.top + pane.clientTop + pane.clientHeight) };
    pane.scrollLeft += center.x - (visible.left + visible.right) / 2;
    pane.scrollTop += center.y - (visible.top + visible.bottom) / 2;
    return { found: true, before, after: { x: pane.scrollLeft, y: pane.scrollTop } };
  }, { region, dimensions });
  await preview.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const geometry = await preview.evaluate((element, { region, dimensions }) => {
    const box = element.getBoundingClientRect();
    const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/u.test(style.overflowX)) {
        clip.left = Math.max(clip.left, bounds.left + ancestor.clientLeft);
        clip.right = Math.min(clip.right, bounds.left + ancestor.clientLeft + ancestor.clientWidth);
      }
      if (/auto|scroll|hidden|clip/u.test(style.overflowY)) {
        clip.top = Math.max(clip.top, bounds.top + ancestor.clientTop);
        clip.bottom = Math.min(clip.bottom, bounds.top + ancestor.clientTop + ancestor.clientHeight);
      }
    }
    const point = (x, y) => {
      const result = { x: box.left + x * box.width / dimensions.width, y: box.top + y * box.height / dimensions.height };
      const hit = document.elementFromPoint(result.x, result.y);
      return { ...result, visible: result.x > clip.left && result.x < clip.right && result.y > clip.top && result.y < clip.bottom,
        unobstructed: hit === element || element.contains(hit), hit: hit?.tagName ?? null };
    };
    return { image: { x: box.x, y: box.y, width: box.width, height: box.height }, clip,
      start: point(region.x, region.y), end: point(region.x + region.width, region.y + region.height) };
  }, { region, dimensions });
  const evidence = { region, scroll, ...geometry };
  if (!geometry.image.width || !geometry.image.height || !geometry.start.visible || !geometry.end.visible
    || !geometry.start.unobstructed || !geometry.end.unobstructed) {
    throw Object.assign(new Error('Selected paragraph drag endpoints are clipped or obstructed; no pointer drag was attempted'), { selectionEvidence: evidence });
  }
  await page.mouse.move(geometry.start.x, geometry.start.y);
  await page.mouse.down();
  try { await page.mouse.move(geometry.end.x, geometry.end.y, { steps: 8 }); }
  finally { await page.mouse.up(); }
  return evidence;
}

export async function runLiveTextRepairE2E(options) {
  assert.equal(options?.realModels, true, 'Real model calls require explicit opt-in');
  const paragraphPadding = validParagraphPadding(options.paragraphPadding ?? 0);
  const paragraphPaddingExplanation = `Expand each source paragraph by ${paragraphPadding}px on all four edges and clamp to ${EDIT_WIDTH}x${EDIT_HEIGHT}; only the private copied UI selection changes, never the original request or asset.`;
  const configuration = inspectDevelopmentConfiguration();
  const database = databaseIdentity(configuration.controlPlaneEnvironment.DATABASE_URL);
  assert.equal(database.host, 'loopback');
  assert.equal(database.database, 'xhs_control');
  assert.equal(configuration.safeConfig.environment, 'development');
  assert.equal(configuration.safeConfig.controlPlane.url, 'http://127.0.0.1:4311');
  assert.equal(configuration.safeConfig.web.url, 'http://127.0.0.1:3002');
  assert.notEqual(configuration.safeConfig.controlPlane.storageRoot, configuration.safeConfig.productionGuard.storageRoot);
  const origin = configuration.safeConfig.web.url, centerUrl = configuration.safeConfig.controlPlane.url;
  const reportRoot = resolve(configuration.root, 'reports/text-repair-live-e2e');
  const suffix = randomBytes(9).toString('hex'), nodeId = `text-repair-e2e-${suffix}`;
  const username = `text_repair_e2e_${suffix}`, password = `E2e!${randomBytes(30).toString('base64url')}`;
  const secrets = [password, configuration.controlPlaneEnvironment.DATABASE_URL,
    ...Object.entries(configuration.controlPlaneEnvironment).filter(([key, value]) => /password|token|secret|api.?key/iu.test(key)
      && typeof value === 'string' && value.length >= 8).map(([, value]) => value)];
  const safe = value => safeTraceText(String(value ?? ''), secrets).text.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/giu, '[database URL]');
  function sanitize(value) {
    if (typeof value === 'string') return safe(value);
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/password|token|authorization|database.?url|connection.?string/iu.test(key))
      .map(([key, child]) => [key, sanitize(child)]));
    return value;
  }
  const report = { startedAt: new Date().toISOString(), status: 'running', environment: 'development', database: 'xhs_control',
    web: origin, center: centerUrl, realModels: true, sourceTaskIds: options.sourceTasks, paragraphPadding, paragraphPaddingExplanation,
    input: 'Actual PNG assets and repair selections copied from historical failed requests; sources are read-only',
    nodeId, cases: [], assertions: [], queueGuards: [], browserErrors: [], apiErrors: [], blockedMutations: [], cleanup: {} };
  const pool = new pg.Pool({ connectionString: configuration.controlPlaneEnvironment.DATABASE_URL,
    max: 3, application_name: 'text-repair-private-live-e2e', statement_timeout: 30_000 });
  const ownedTasks = new Set(), ownedEdits = new Set(), ownedUploads = new Set(), ownedExecutions = new Map();
  const httpEvidence = [], sources = [];
  let account, browser, page, activeCase, registered = false;
  const reportFile = join(reportRoot, `report-${suffix}.json`);

  function check(condition, description) {
    assert.ok(condition, description);
    (activeCase?.assertions ?? report.assertions).push(description);
  }
  function actorHeaders() {
    assert.ok(account, 'Private account is not initialized');
    return { 'content-type': 'application/json', 'x-actor-user-id': String(account.id),
      'x-actor-username': account.username, 'x-actor-role': 'USER',
      'x-actor-credential-version': String(account.credential_version) };
  }
  async function centerRequest(path, body) {
    assert.ok(/^\/v1\/image-editor\//u.test(path), 'Only standalone editor actor requests are allowed');
    if (body) {
      const match = /^\/v1\/image-editor\/edits\/([a-f0-9-]{36})\/cancel$/iu.exec(path);
      assert.ok(match && ownedEdits.has(match[1]), 'Cleanup may cancel only an owned fixture edit');
    }
    const response = await fetch(`${centerUrl}${path}`, { method: body ? 'POST' : 'GET', headers: actorHeaders(),
      body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    const payload = await response.json();
    assert.ok(response.ok, `${path}: HTTP ${response.status} ${payload?.error?.message ?? ''}`);
    return payload.data;
  }
  async function actorAsset(assetId) {
    assert.ok(Number.isSafeInteger(Number(assetId)) && Number(assetId) > 0);
    const response = await fetch(`${centerUrl}/v1/image-editor/assets/${assetId}`, {
      headers: actorHeaders(), redirect: 'error', signal: AbortSignal.timeout(30_000) });
    assert.ok(response.ok && response.headers.get('content-type')?.includes('image/png'), 'Owned asset download failed');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.length && bytes.length <= 30 * 1024 * 1024, 'Owned asset is outside expected limits');
    return bytes;
  }
  const controlPlane = createControlPlaneClient({ baseUrl: centerUrl, fetchImpl: async (url, init = {}) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, centerUrl, 'Executor HTTP escaped the development center');
    const executionId = /^\/v1\/executions\/([a-f0-9-]{36})\//iu.exec(parsed.pathname)?.[1];
    if (executionId) assert.ok(ownedExecutions.has(executionId), 'Executor HTTP attempted an unowned execution');
    if (init.method === 'POST' && ['/v1/nodes', '/v1/executions/claim-image'].includes(parsed.pathname)) {
      assert.equal(JSON.parse(init.body).nodeId, nodeId);
    }
    const response = await fetch(url, { ...init, redirect: 'error' });
    let checkpointKind;
    if (parsed.pathname.endsWith('/text-repair-checkpoint') && typeof init.body === 'string') checkpointKind = JSON.parse(init.body).kind;
    httpEvidence.push({ method: init.method ?? 'GET', path: parsed.pathname, status: response.status, ...(checkpointKind ? { checkpointKind } : {}) });
    return response;
  } });

  async function guardQueue(label) {
    const [edits, tasks, executions, peers] = await Promise.all([
      pool.query("SELECT id,task_id,status FROM image_edit_requests WHERE status IN ('QUEUED','RUNNING') AND NOT(id=ANY($1::uuid[]))", [[...ownedEdits]]),
      pool.query("SELECT id,state FROM tasks WHERE state IN ('IMAGE_QUEUED','IMAGE_RUNNING') AND NOT(id=ANY($1::bigint[]))", [[...ownedTasks]]),
      pool.query("SELECT id,task_id FROM task_executions WHERE kind='IMAGE' AND status='RUNNING' AND NOT(id=ANY($1::uuid[]))", [[...ownedExecutions.keys()]]),
      pool.query("SELECT id FROM executor_nodes WHERE retired_at IS NULL AND image_worker_enabled AND image_edit_executor_version>=15 AND last_seen_at>=now()-interval '90 seconds' AND id<>$1", [nodeId]),
    ]);
    const guard = { label, checkedAt: new Date().toISOString(), unownedQueuedOrRunningEdits: edits.rowCount,
      unownedImageTasks: tasks.rowCount, unownedActiveImageExecutions: executions.rowCount, competingModernExecutors: peers.rowCount };
    report.queueGuards.push(guard);
    assert.ok(!edits.rowCount && !tasks.rowCount && !executions.rowCount && !peers.rowCount,
      'Queue safety guard failed; no unrelated queue may be claimed or modified');
  }
  async function readSource(taskId) {
    const row = (await pool.query(`SELECT e.id,e.task_id,e.source_asset_id,e.source_sha256,e.config,e.target_page,
      md5(to_jsonb(e)::text) AS original_fingerprint,a.sha256 AS asset_sha256,a.storage_path,a.media_type
      FROM image_edit_requests e JOIN assets a ON a.id=e.source_asset_id AND a.task_id=e.task_id
      WHERE e.task_id=$1 AND e.operation='AI_TEXT_REPAIR' AND e.status='FAILED' AND a.content_cleared_at IS NULL
      ORDER BY e.created_at DESC,e.id DESC LIMIT 1`, [taskId])).rows[0];
    assert.ok(row, `Missing actual failed text repair for source task ${taskId}`);
    const repairs = normalizeTextRepairs(row.config.textRepairs);
    if (taskId === 1760) assert.ok(repairs.length === 2 && repairs.every(item => item.correctText === '鳖'), 'Task 1760 must contain both actual 鳖 repairs');
    if (taskId === 1768) assert.ok(repairs.some(item => item.correctText === '鼬'), 'Task 1768 must contain the actual 鼬 repair');
    if (taskId === 1764) assert.ok(repairs.map(item => item.correctText).join('').includes('匍匐'), 'Task 1764 must contain the actual 匍匐 repair');
    const path = resolve(configuration.safeConfig.controlPlane.storageRoot, row.storage_path);
    assert.ok(within(configuration.safeConfig.controlPlane.storageRoot, path), 'Source asset path escaped development storage');
    const bytes = await readFile(path), metadata = await sharp(bytes).metadata();
    assert.equal(imageHash(bytes), row.source_sha256);
    assert.equal(row.asset_sha256, row.source_sha256);
    assert.equal(row.config.sha256, row.source_sha256);
    assert.ok(metadata.format === 'png' && metadata.width === EDIT_WIDTH && metadata.height === EDIT_HEIGHT);
    assert.ok(bytes.length <= 5 * 1024 * 1024, 'Actual source exceeds the browser upload limit; stop rather than modify it');
    return { ...row, repairs, bytes, path };
  }
  async function sourceUnchanged(source) {
    const row = (await pool.query('SELECT md5(to_jsonb(e)::text) AS fingerprint FROM image_edit_requests e WHERE id=$1', [source.id])).rows[0];
    assert.equal(row?.fingerprint, source.original_fingerprint, `Original request ${source.id} changed during E2E`);
    assert.equal(imageHash(await readFile(source.path)), source.source_sha256, 'Original source asset changed during E2E');
  }
  async function ownWorkspace(id) {
    assert.ok(Number.isSafeInteger(id) && id > 0 && !SOURCE_TASKS.includes(id));
    const row = (await pool.query(`SELECT w.owner_id,t.task_kind FROM standalone_image_workspaces w JOIN tasks t ON t.id=w.task_id WHERE w.task_id=$1`, [id])).rows[0];
    assert.equal(Number(row?.owner_id), Number(account.id));
    assert.equal(row?.task_kind, 'STANDALONE_IMAGE_EDIT');
    ownedTasks.add(id);
  }
  async function ownEdit(id) {
    assert.ok(UUID.test(id));
    const row = (await pool.query('SELECT task_id,created_by,operation FROM image_edit_requests WHERE id=$1', [id])).rows[0];
    assert.ok(ownedTasks.has(Number(row?.task_id)));
    assert.equal(row?.created_by, account.username);
    assert.equal(row?.operation, 'AI_TEXT_REPAIR');
    ownedEdits.add(id);
  }
  async function fenceBrowser(context) {
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) return ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
      if (['GET', 'HEAD'].includes(request.method())) return route.continue();
      try {
        if (url.pathname === '/api/auth/login') {
          assert.equal(request.postDataJSON().username, username);
          return route.continue();
        }
        const path = url.pathname.replace(/^\/api\/control-plane/u, '');
        const upload = /^\/v1\/image-editor\/uploads\/([a-f0-9-]{36})\/1$/iu.exec(path);
        if (upload && request.method() === 'POST') { ownedUploads.add(upload[1]); return route.continue(); }
        const body = request.postDataJSON() ?? {};
        if (path === '/v1/image-editor/workspaces' && request.method() === 'POST') {
          assert.ok(ownedUploads.has(body.requestId) && Array.isArray(body.uploads) && body.uploads.length === 1);
        } else {
          const create = /^\/v1\/image-editor\/workspaces\/(\d+)\/image-edits$/u.exec(path);
          const accept = /^\/v1\/image-editor\/edits\/([a-f0-9-]{36})\/accept$/iu.exec(path);
          if (create) {
            assert.ok(ownedTasks.has(Number(create[1])));
            assert.equal(body.operation, 'AI_TEXT_REPAIR');
            assert.equal(body.confirmation, 'LIVE_IMAGE_COST_ACCEPTED');
          } else if (accept) {
            assert.ok(ownedEdits.has(accept[1]));
            assert.ok(body.acceptRejectedResult !== true, 'Failed automatic checks may not be overridden');
          } else throw new Error('Browser mutation outside owned fixture workflow');
        }
        return route.continue();
      } catch (error) {
        report.blockedMutations.push({ path: url.pathname, error: safe(error.message) });
        return route.abort();
      }
    });
  }
  async function login(context) {
    const loginPage = await context.newPage();
    await loginPage.goto(`${origin}/login`, { waitUntil: 'domcontentloaded' });
    await loginPage.getByLabel('账号', { exact: true }).fill(username);
    await loginPage.getByLabel('密码', { exact: true }).fill(password);
    await loginPage.getByRole('button', { name: '进入后台', exact: true }).click();
    await loginPage.waitForURL('**/workbench/personal', { timeout: 45_000 });
    await loginPage.close();
  }
  async function submitActualRepair(source) {
    await guardQueue(`before upload/submit source ${source.task_id}`);
    await page.goto(`${origin}/image-editor`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '新增图片', exact: true }).click();
    await page.getByLabel('图片名称（可选）').fill(`标准字体真实验证 ${source.task_id} ${suffix}`);
    const uploaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/control-plane/v1/image-editor/workspaces'
      && response.request().method() === 'POST');
    await page.getByLabel('上传待编辑图片', { exact: true }).setInputFiles({ name: `actual-source-${source.task_id}.png`, mimeType: 'image/png', buffer: source.bytes });
    const response = await uploaded, payload = await response.json();
    assert.equal(response.status(), 201, payload?.error?.message ?? 'Actual image upload failed');
    const workspace = payload.data;
    await ownWorkspace(Number(workspace.id));
    activeCase.taskId = Number(workspace.id);
    activeCase.directory = join(reportRoot, String(activeCase.taskId));
    await mkdir(activeCase.directory, { recursive: true });
    const before = await actorAsset(workspace.assets[0].id);
    assert.equal(imageHash(before), workspace.assets[0].sha256);
    check(await equalPixels(source.bytes, before), 'Uploaded actual source retains every decoded original pixel');
    await writeFile(join(activeCase.directory, 'before.png'), before);
    activeCase.uploadedSourceSha256 = imageHash(before);
    await page.getByRole('region', { name: '图片编辑组件' }).waitFor();
    await page.getByRole('tab', { name: '修正错字', exact: true }).click();
    const preview = page.getByRole('img', { name: '实时修改预览', exact: true });
    for (const [index, item] of source.repairs.entries()) {
      if (index) await page.getByRole('button', { name: '添加另一处错字', exact: true }).click();
      await page.getByLabel(`第 ${index + 1} 处正确文字`, { exact: true }).fill(item.correctText);
      await page.getByLabel(`第 ${index + 1} 处正确词句`, { exact: true }).fill(item.contextText ?? '');
      const selection = await drawTextRepairSelection(page, preview, item.region);
      activeCase.selections ??= [];
      activeCase.selections.push(selection);
      const selected = preview.locator('svg rect').nth(index);
      await selected.waitFor({ state: 'attached', timeout: 5000 });
      for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(Number(await selected.getAttribute(key)) - item.region[key]) <= 3,
        `Visible selected paragraph ${index + 1}/${key} differs from the actual source selection`);
    }
    await page.getByLabel(FEE_LABEL, { exact: true }).check();
    await guardQueue(`immediately before owned submit ${workspace.id}`);
    const submitted = page.waitForResponse(result => new URL(result.url()).pathname === `/api/control-plane/v1/image-editor/workspaces/${workspace.id}/image-edits`
      && result.request().method() === 'POST');
    await page.getByRole('button', { name: '保存并排字修正', exact: true }).click();
    const submitResponse = await submitted, result = await submitResponse.json();
    assert.equal(submitResponse.status(), 201, result?.error?.message ?? 'Actual repair submission failed');
    const edit = result.data;
    await ownEdit(edit.id);
    activeCase.editId = edit.id;
    activeCase.repairs = edit.config.textRepairs;
    assert.equal(edit.config.sha256, imageHash(before));
    assert.equal(edit.config.textRepairs.length, source.repairs.length);
    for (const [index, item] of edit.config.textRepairs.entries()) {
      const expected = source.repairs[index];
      assert.equal(item.correctText, expected.correctText);
      assert.equal(item.contextText ?? '', expected.contextText ?? '');
      for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(item.region[key] - expected.region[key]) <= 3,
        `Actual UI selection differs from saved paragraph ${index + 1}/${key}`);
    }
    check(true, 'Actual UI submitted all source repair items and the explicit model cost confirmation');
    return { edit, before, workspace };
  }
  async function claimOwned(edit) {
    let claim;
    await waitUntil(async () => {
      await guardQueue(`immediately before claim ${edit.id}`);
      claim = await controlPlane.claimImage(nodeId);
      if (!claim) return false;
      assert.equal(claim.imageEdit?.id, edit.id, 'Claim returned unrelated work; stop without executing or modifying it');
      assert.ok(ownedTasks.has(Number(claim.task.id)) && ownedEdits.has(claim.imageEdit.id));
      assert.equal(claim.execution.nodeId, nodeId);
      assert.equal(claim.execution.snapshot?.imageEditExecutorVersion, 15);
      assert.equal(claim.imageEdit.operation, 'AI_TEXT_REPAIR');
      ownedExecutions.set(claim.execution.id, claim);
      return true;
    }, 'specific owned image edit claim');
    activeCase.executionId = claim.execution.id;
    return claim;
  }
  async function executeOwned(claim) {
    assert.ok(ownedExecutions.has(claim.execution.id));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Live E2E model execution timed out')), options.timeoutMs);
    async function heartbeat() {
      const result = await controlPlane.heartbeatExecutions({ nodeId, executionIds: [claim.execution.id] });
      assert.ok(result.activeExecutionIds.includes(claim.execution.id) && !result.staleExecutionIds.length, 'Owned execution heartbeat became stale');
    }
    let renewal;
    try {
      await heartbeat();
      renewal = setInterval(() => { void heartbeat().catch(error => controller.abort(error)); }, 20_000);
      await runWithExecutionSignal(controller.signal, () => withModelCallTracing({ executionId: claim.execution.id,
        controlPlane: guardExecutionCalls(controlPlane, controller.signal), snapshot: claim.execution.snapshot }, tracedPlane => executeImageEditClaim({
        claim, controlPlane: tracedPlane, workRoot: join(activeCase.directory, 'executor-work'), signal: controller.signal,
        environment: { ...configuration.webEnvironment, CONTROL_PLANE_URL: centerUrl, XHS_SERVER_ENV: 'development',
          XHS_CODEX_RUNTIME_DB: join(activeCase.directory, 'codex-runtime.sqlite'), XHS_CODEX_CONCURRENCY: '1', XHS_CODEX_IMAGE_CONCURRENCY: '1' },
      })));
    } finally { if (renewal) clearInterval(renewal); clearTimeout(timer); }
  }
  async function traceProof(executionId, receipt) {
    const rows = (await pool.query(`SELECT c.id,c.sequence,c.operation,c.provider,c.model,c.status,c.duration_ms,c.prompt,c.request,
      c.payload_archived,a.format_version,a.payload,a.raw_bytes,a.sha256
      FROM model_call_traces c LEFT JOIN model_call_payload_archives a ON a.call_id=c.id
      WHERE c.execution_id=$1 AND c.task_id=$2 ORDER BY c.sequence,c.id`, [executionId, activeCase.taskId])).rows;
    assert.ok(rows.length, 'No real model call traces were persisted through HTTP');
    const calls = [];
    for (const row of rows) {
      const payload = row.payload_archived ? await decodeModelCallPayload(row) : row;
      const data = requestData(payload.prompt), operation = String(row.operation);
      assert.notEqual(operation, 'IMAGE', 'A reference or final glyph unexpectedly invoked image generation');
      assert.ok(!['REFERENCE', 'GENERATE_REFERENCE', 'REPAIR_REFERENCE'].includes(data?.mode), 'Reference generation/vision unexpectedly invoked a model');
      if (operation === 'IMAGE_EDIT') assert.equal(data?.mode, 'ERASE_BACKGROUND', 'Image editing must only erase the old text background');
      calls.push({ id: row.id, sequence: row.sequence, operation, provider: row.provider, model: row.model, status: row.status,
        durationMs: Number(row.duration_ms), mode: data?.mode ?? (data?.coordinateSystem ? 'LOCALIZE' : null),
        promptSha256: imageHash(Buffer.from(payload.prompt)) });
    }
    const backgrounds = receipt.textRepairState.locations.filter(item => item.validation?.background?.method === 'MODEL_ERASE').length;
    assert.equal(calls.filter(call => call.operation === 'IMAGE_EDIT').length, backgrounds, 'Only complex backgrounds may consume image edits');
    assert.ok(calls.some(call => call.operation === 'VISION' && call.mode === 'FINAL'), 'No actual final vision model call was traced');
    const events = httpEvidence.filter(event => event.path.includes(`/v1/executions/${executionId}/`));
    assert.ok(events.some(event => event.checkpointKind === 'REFERENCE' && event.status === 200));
    assert.ok(events.some(event => event.checkpointKind === 'LOCATION' && event.status === 200));
    assert.ok(events.some(event => event.path.endsWith('/image-edit/result') && event.status === 200));
    assert.ok(events.some(event => /\/image-edit\/assets\/\d+$/u.test(event.path) && event.status === 200));
    assert.ok(events.some(event => /\/model-calls\//u.test(event.path) && event.status === 200));
    return { calls, http: events, referenceImageCalls: 0, referenceVisionCalls: 0, complexBackgroundImageCalls: backgrounds };
  }
  async function verifyAndAdopt(edit, before, workspace) {
    const receipt = await centerRequest(`/v1/image-editor/edits/${edit.id}`);
    activeCase.actualStatus = receipt.status;
    activeCase.validation = receipt.result?.validation ?? receipt.validation;
    activeCase.textRepairState = receipt.textRepairState;
    assert.equal(receipt.status, 'PREVIEW_READY', receipt.error ?? 'Automatic validation did not pass');
    assert.equal(receipt.result?.validation?.passed, true);
    const state = receipt.textRepairState, font = await getTextRepairFontMetadata();
    assert.equal(receipt.result.validation.method, 'STANDARD_FONT');
    assert.equal(receipt.result.validation.textRendering.fontSha256, font.fontSha256);
    assert.equal(state.references.length, new Set(edit.config.textRepairs.map(item => item.correctText)).size);
    assert.equal(state.locations.length, edit.config.textRepairs.length);
    for (const reference of state.references) {
      assert.equal(reference.validation?.method, 'STANDARD_FONT');
      assert.equal(reference.validation?.passed, true);
      assert.equal(reference.validation?.textRendering?.fontSha256, font.fontSha256);
      assert.equal(reference.validation?.textRendering?.text, reference.text);
      assert.equal(reference.validation?.textRendering?.rendererVersion, font.rendererVersion);
      assert.equal(imageHash(await actorAsset(reference.assetId)), reference.sha256);
    }
    for (const location of state.locations) {
      assert.equal(location.validation?.method, 'STANDARD_FONT');
      assert.equal(location.validation?.passed, true);
      assert.equal(location.validation?.textRendering?.fontSha256, font.fontSha256);
      assert.equal(location.validation?.textRendering?.text, location.correctText);
      const reference = state.references.find(item => item.text === location.correctText);
      assert.equal(location.referenceSha256, reference.sha256, 'Same text positions must reuse the exact reference');
    }
    const after = await actorAsset(receipt.result.asset_id), mask = await renderTextRepairMask(state.locations.map(item => item.rect));
    assert.equal(imageHash(after), receipt.result.validation.integrity.sha256);
    const outside = await assertOutsideMask(before, after, mask);
    assert.equal(outside.changedPixels, 0);
    assert.ok(!(await equalPixels(before, after)), 'Actual repair did not change any source pixels');
    activeCase.traceProof = await traceProof(activeCase.executionId, receipt);
    activeCase.font = font;
    activeCase.outsideMask = outside;
    activeCase.referenceCount = state.references.length;
    activeCase.resultAssetId = Number(receipt.result.asset_id);
    await writeFile(join(activeCase.directory, 'after.png'), after);
    check(true, 'Real HTTP checkpoints, standard-font references, font hash, repeated-text reuse and outside pixels all pass');
    await page.goto(`${origin}/image-editor?workspace=${workspace.id}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('region', { name: '图片编辑组件' }).waitFor();
    await page.getByRole('tab', { name: /^编辑记录/u }).click();
    await page.getByRole('button', { name: '采用此版本', exact: true }).click();
    await page.getByLabel('采用此版本操作原因', { exact: true }).fill('开发库真实系统端到端验证：已核对标准字体排字、背景、邻字和区域外保护');
    await page.getByRole('button', { name: '确认采用此版本', exact: true }).click();
    await waitUntil(async () => (await centerRequest(`/v1/image-editor/edits/${edit.id}`)).status === 'ACCEPTED', 'normal UI adoption');
    const adopted = await centerRequest(`/v1/image-editor/workspaces/${workspace.id}`);
    assert.equal(adopted.assets[0].id, Number(receipt.result.asset_id));
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('link', { name: '下载图片', exact: true }).click();
    const download = await downloadEvent;
    await download.saveAs(join(activeCase.directory, 'download.png'));
    const downloaded = await readFile(join(activeCase.directory, 'download.png'));
    assert.equal(imageHash(downloaded), imageHash(after));
    const downloadedOutside = await assertOutsideMask(before, downloaded, mask);
    assert.equal(downloadedOutside.changedPixels, 0);
    activeCase.downloadSha256 = imageHash(downloaded);
    activeCase.adoption = { status: 'ACCEPTED', adoptedAssetId: adopted.assets[0].id, runId: adopted.runId, outsideMask: downloadedOutside };
    check(true, 'Normal UI adoption selects the actual result and the browser download matches its hash and outside pixels');
    await page.screenshot({ path: join(activeCase.directory, 'screenshot.png'), fullPage: true });
    activeCase.status = 'passed';
  }
  async function saveReports() {
    await mkdir(reportRoot, { recursive: true });
    for (const item of report.cases) if (item.directory) await writeFile(join(item.directory, 'result.json'), `${JSON.stringify(sanitize(item), null, 2)}\n`);
    await writeFile(reportFile, `${JSON.stringify(sanitize(report), null, 2)}\n`);
  }
  async function cleanup() {
    if (account) {
      const workspaces = (await pool.query('SELECT task_id FROM standalone_image_workspaces WHERE owner_id=$1', [account.id])).rows;
      for (const row of workspaces) ownedTasks.add(Number(row.task_id));
      const edits = (await pool.query(`SELECT e.id FROM image_edit_requests e JOIN standalone_image_workspaces w ON w.task_id=e.task_id
        WHERE w.owner_id=$1 AND e.created_by=$2 AND e.operation='AI_TEXT_REPAIR'`, [account.id, username])).rows;
      for (const row of edits) ownedEdits.add(row.id);
    }
    report.cleanup.workspaces = [...ownedTasks].map(taskId => ({ taskId, retainedForAudit: true }));
    report.cleanup.edits = [];
    for (const id of ownedEdits) {
      try {
        const edit = await centerRequest(`/v1/image-editor/edits/${id}`);
        if (['DRAFT', 'QUEUED'].includes(edit.status)) {
          await centerRequest(`/v1/image-editor/edits/${id}/cancel`, { requestId: randomUUID(), version: edit.version, reason: 'Scoped live E2E stopped; cancel only its unclaimed fixture' });
        } else if (edit.status === 'RUNNING') {
          const claim = [...ownedExecutions.values()].find(value => value.imageEdit.id === id);
          assert.ok(claim, 'Cannot end an execution not owned by this runner');
          await controlPlane.failImageEdit(claim.execution.id, claim.imageEdit, new Error('Scoped live E2E stopped; preserve actual failure'));
        }
        report.cleanup.edits.push({ id, status: (await centerRequest(`/v1/image-editor/edits/${id}`)).status });
      } catch (error) { report.cleanup.edits.push({ id, error: safe(error.message) }); report.status = 'failed'; }
    }
    if (registered) {
      try {
        const result = await pool.query(`UPDATE executor_nodes SET image_worker_enabled=false,retired_at=now(),updated_at=now()
          WHERE id=$1 AND name=$2 AND codex_pool_id=$1 AND NOT EXISTS(SELECT 1 FROM task_executions WHERE node_id=$1 AND status='RUNNING') RETURNING id`,
        [nodeId, `Private standard-font E2E ${suffix}`]);
        report.cleanup.executor = { id: nodeId, retired: result.rowCount === 1 };
        if (!result.rowCount) report.status = 'failed';
      } catch (error) { report.cleanup.executor = { id: nodeId, error: safe(error.message) }; report.status = 'failed'; }
    }
  }

  try {
    assert.equal((await pool.query('SELECT current_database() AS database')).rows[0].database, 'xhs_control');
    const health = await controlPlane.health();
    assert.ok(health.ok && Number(health.capabilities?.imageEditExecutorVersion) >= 15, 'Development center must support standard-font capability 15');
    assert.ok((await fetch(`${origin}/login`, { redirect: 'error', signal: AbortSignal.timeout(30_000) })).ok, 'Development web is unavailable');
    await guardQueue('before any fixture write');
    for (const id of options.sourceTasks) sources.push(await readSource(id));
    assert.equal((await pool.query('SELECT id FROM executor_nodes WHERE id=$1', [nodeId])).rowCount, 0);
    account = (await pool.query(`INSERT INTO app_users(username,display_name,role,password_hash,must_change_password)
      VALUES($1,$2,'USER',$3,false) RETURNING id,username,credential_version`,
    [username, `标准字体真实验证 ${suffix}`, await hashUserPassword(password)])).rows[0];
    report.testAccountId = Number(account.id);
    registered = true;
    const node = await controlPlane.registerNode({ nodeId, name: `Private standard-font E2E ${suffix}`, imageWorkerEnabled: true,
      copyConcurrency: 1, imageConcurrency: 1, codexPoolId: nodeId, codexTotalConcurrency: 1, codexImageConcurrency: 1, imageEditExecutorVersion: 15 });
    assert.equal(node.id, nodeId); assert.equal(node.imageEditExecutorVersion, 15);
    browser = await chromium.launch({ headless: true, channel: process.env.IMAGE_EDIT_BROWSER_CHANNEL ?? 'msedge' });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true });
    await fenceBrowser(context);
    await login(context);
    page = await context.newPage(); page.setDefaultTimeout(45_000);
    page.on('pageerror', error => report.browserErrors.push({ taskId: activeCase?.taskId ?? null, error: safe(error.message) }));
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin === origin && url.pathname.startsWith('/api/') && response.status() >= 400)
        report.apiErrors.push({ taskId: activeCase?.taskId ?? null, path: url.pathname, status: response.status() });
    });
    for (const source of sources) {
      activeCase = { sourceTaskId: Number(source.task_id), sourceEditId: source.id, sourceAssetId: Number(source.source_asset_id),
        sourceSha256: source.source_sha256, sourceTargetPage: source.target_page, startedAt: new Date().toISOString(), status: 'running',
        sourceRepairs: structuredClone(source.config.textRepairs), repairs: paddedTextRepairParagraphs(source.repairs, paragraphPadding),
        paragraphPadding, paragraphPaddingExplanation, assertions: [] };
      activeCase.requestedRepairs = structuredClone(activeCase.repairs);
      report.cases.push(activeCase);
      console.log(`START source ${source.task_id}: ${source.repairs.map(item => item.correctText).join(', ')}`);
      const fixture = await submitActualRepair({ ...source, repairs: activeCase.requestedRepairs });
      await saveReports();
      const claim = await claimOwned(fixture.edit);
      await executeOwned(claim);
      await verifyAndAdopt(fixture.edit, fixture.before, fixture.workspace);
      await sourceUnchanged(source);
      activeCase.originalSourceUnchanged = true;
      activeCase.finishedAt = new Date().toISOString();
      await saveReports();
      console.log(`PASS source ${source.task_id}, private task ${activeCase.taskId}`);
    }
    check(report.browserErrors.length === 0 && report.apiErrors.length === 0 && report.blockedMutations.length === 0, 'Real browser had no unexpected API, JavaScript or ownership guard errors');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.failure = safe(error.message); process.exitCode = 1;
    if (activeCase) {
      activeCase.status = 'failed'; activeCase.failure = safe(error.message); activeCase.finishedAt = new Date().toISOString();
      if (error.selectionEvidence) activeCase.selectionFailure = error.selectionEvidence;
      if (activeCase.directory && page) {
        await page.screenshot({ path: join(activeCase.directory, 'screenshot.png'), fullPage: true }).catch(() => {});
        activeCase.visibleAlerts = await page.getByRole('alert').allTextContents().catch(() => []);
      }
      if (activeCase.editId) {
        try { const receipt = await centerRequest(`/v1/image-editor/edits/${activeCase.editId}`);
          activeCase.actualStatus = receipt.status; activeCase.actualError = receipt.error;
          activeCase.validation = receipt.result?.validation ?? receipt.validation; activeCase.textRepairState = receipt.textRepairState;
        } catch (readError) { activeCase.failureReadError = safe(readError.message); }
      }
      if (activeCase.executionId) {
        try { activeCase.modelCalls = (await pool.query(`SELECT id,sequence,operation,provider,model,status,duration_ms,error
          FROM model_call_traces WHERE execution_id=$1 AND task_id=$2 ORDER BY sequence,id`, [activeCase.executionId, activeCase.taskId])).rows; }
        catch (traceError) { activeCase.traceReadError = safe(traceError.message); }
      }
      if (activeCase.directory && page && activeCase.editId) {
        await page.goto(`${origin}/image-editor?workspace=${activeCase.taskId}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.getByRole('region', { name: '图片编辑组件' }).waitFor().catch(() => {});
        await page.screenshot({ path: join(activeCase.directory, 'reopened-screenshot.png'), fullPage: true }).catch(() => {});
      }
    }
  } finally {
    await browser?.close().catch(() => {});
    try { for (const source of sources) await sourceUnchanged(source); report.originalSourcesUnchanged = true; }
    catch (error) { report.originalSourcesUnchanged = false; report.sourceGuardFailure = safe(error.message); report.status = 'failed'; }
    try { await cleanup(); } catch (error) { report.cleanup.error = safe(error.message); report.status = 'failed'; }
    if (account) {
      try {
        const result = await pool.query(`UPDATE app_users SET status='DISABLED',credential_version=credential_version+1,
          version=version+1,updated_at=now() WHERE id=$1 AND username=$2 RETURNING id,status`, [account.id, username]);
        assert.equal(result.rowCount, 1);
        report.cleanup.account = { id: Number(account.id), status: result.rows[0].status };
      } catch (error) { report.cleanup.account = { id: Number(account.id), error: safe(error.message) }; report.status = 'failed'; }
    }
    await pool.end().catch(() => {});
    report.finishedAt = new Date().toISOString();
    await saveReports();
    if (report.status !== 'passed') process.exitCode = 1;
    console.log(JSON.stringify({ status: report.status, cases: report.cases.map(item => ({ sourceTaskId: item.sourceTaskId,
      taskId: item.taskId, status: item.status, actualStatus: item.actualStatus })), failure: report.failure,
      report: reportFile, cleanup: report.cleanup }));
  }
  return sanitize(report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--help')) console.log('Manual development-only real E2E: node scripts/image-text-repair-live-e2e.mjs --real-models [--source-tasks=1760,1768,1764] [--timeout-ms=1080000] [--paragraph-padding=0]. Padding is an integer from 0 to 16 and only expands copied UI paragraph selections. Requires prior user authorization; preserves original records and disables its private account afterward.');
  else await runLiveTextRepairE2E(parseLiveTextRepairOptions(process.argv.slice(2)));
}
