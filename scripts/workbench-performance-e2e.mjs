import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import pg from 'pg';
import { chromium } from 'playwright-core';
import { inspectDevelopmentConfiguration, databaseIdentity } from './start-development.mjs';
import { hashUserPassword } from '../server/src/user-auth.mjs';
import { createFollowupFixtures, closeFollowupFixtures } from './workbench-followup-fixtures.mjs';
import { createControlPlaneClient } from '../src/control-plane/client.mjs';

// Real development UI, HTTP, PostgreSQL and filesystem. No queue scanner or model client.
const configuration = inspectDevelopmentConfiguration({ environment: {} });
const identity = databaseIdentity(configuration.controlPlaneEnvironment.DATABASE_URL);
assert.equal(identity.host, 'loopback');
assert.equal(identity.database, 'xhs_control');
assert.equal(configuration.safeConfig.web.url, 'http://127.0.0.1:3002');
assert.equal(configuration.controlPlaneEnvironment.PROGRAMMATIC_IMAGE_WORKER_MODE, 'external');
const origin = configuration.safeConfig.web.url;
const target = '/workbench/all?createdDateFrom=2026-09-02&createdDateTo=2026-10-02';
const suffix = randomBytes(8).toString('hex');
const password = `Workbench!${randomBytes(24).toString('base64url')}`;
const pool = new pg.Pool({ connectionString: configuration.controlPlaneEnvironment.DATABASE_URL,
  max: 3, statement_timeout: 30_000, application_name: 'scoped-workbench-performance-e2e' });
const reportPrefix = process.env.XHS_WORKBENCH_REPORT_PREFIX ?? 'workbench-performance';
assert.match(reportPrefix, /^[a-z0-9-]{1,80}$/u);
const artifact = name => resolve(`reports/${reportPrefix}-${name}`);
const reportPath = artifact('e2e.json');
const round3Proof = process.env.XHS_WORKBENCH_ROUND3_PROOF === '1';
const followupProof = process.env.XHS_WORKBENCH_FOLLOWUP_PROOF === '1';
const report = { startedAt: new Date().toISOString(), page: `${origin}${target}`, database: identity.database,
  productionConnectionOpened: false, modelCalls: 0, status: 'running', assertions: [], steps: [],
  browserErrors: [], apiErrors: [], blockedWrites: [], productionProof: [], cleanup: {} };
const accounts = [], taskIds = [], requests = [], pending = new Set();
const knowledgeIds = [], qaMemberIds = [], qaBatchIds = [];
const knowledgeQuery = `round3${suffix}知识库`;
let qaBatch, followupFixture;
let browser, context, page, admin, observer, phase = 'setup';
let workWait, workAbort, notificationStartedAt;
const notificationNode = `scoped-notify-${suffix}`;
function safeError(error) { return String(error?.message ?? error).replaceAll(password, '[redacted]')
  .replace(/postgres(?:ql)?:\/\/[^\s)]+/gu, '[database URL]'); }
function check(condition, description) { assert.ok(condition, description); report.assertions.push(description); }
async function step(description, action) { console.log(description); const start = performance.now();
  await action(); report.steps.push({ description, durationMs: Math.round(performance.now() - start) }); }
async function until(predicate, description, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(done => setTimeout(done, 150)); }
  throw new Error(`Timed out: ${description}`);
}
function watch(targetPage, webOrigin, resources = []) {
  targetPage.on('pageerror', error => report.browserErrors.push({ phase, error: safeError(error) }));
  targetPage.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === webOrigin) requests.push({ phase, method: request.method(), path: url.pathname,
      search: url.search, rsc: request.headers().rsc === '1' });
  });
  targetPage.on('response', response => {
    const url = new URL(response.url());
    if (url.origin !== webOrigin) return;
    if (url.pathname.startsWith('/api/') && response.status() >= 400) {
      report.apiErrors.push({ phase, path: url.pathname, status: response.status() });
    }
    if (url.pathname.startsWith('/_next/static/') && /\.js$/u.test(url.pathname)) {
      const capturedPhase = phase;
      const capture = response.body().then(body => resources.push({ phase: capturedPhase,
        path: url.pathname, bytes: body.byteLength,
        containsReview: body.includes(Buffer.from('保存评分，暂不提交')),
        containsDeliveryHistory: body.includes(Buffer.from('我的共享交付记录')) })).catch(() => {});
      pending.add(capture); capture.finally(() => pending.delete(capture));
    }
  });
}
async function fence(targetContext, webOrigin) {
  await targetContext.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== webOrigin) return route.abort();
    if (url.pathname.startsWith('/api/control-plane/') && !['GET', 'HEAD'].includes(request.method())) {
      const path = url.pathname.replace('/api/control-plane', '');
      const match = /^\/v1\/tasks\/(\d+)\/restore$/u.exec(path);
      const body = request.postDataJSON() ?? {};
      const ownedRestore = match && taskIds.includes(Number(match[1]));
      const ownedDiscard = path === '/v1/tasks/batch-actions' && body.action === 'DISCARD'
        && body.taskIds.length > 0 && body.taskIds.every(id => taskIds.includes(id));
      const qaMatch = /^\/v2\/copy-qa\/items\/([^/]+)\/decision$/u.exec(path);
      const ownedQaPass = qaMatch && qaMemberIds.includes(qaMatch[1]) && body.decision === 'PASS';
      if (!ownedRestore && !ownedDiscard && !ownedQaPass) {
        report.blockedWrites.push({ phase, path, method: request.method() }); return route.abort();
      }
    }
    await route.continue();
  });
}
async function login(targetContext, webOrigin, account = admin) {
  const loginPage = await targetContext.newPage();
  await loginPage.goto(`${webOrigin}/login`, { waitUntil: 'domcontentloaded' });
  await loginPage.getByLabel('账号', { exact: true }).fill(account.username);
  await loginPage.getByLabel('密码', { exact: true }).fill(password);
  await loginPage.getByRole('button', { name: '进入后台', exact: true }).click();
  await loginPage.waitForURL('**/workbench/personal', { timeout: 60_000 });
  await loginPage.close();
}
const listReads = () => requests.filter(request => request.method === 'GET' && request.path === '/api/control-plane/v1/tasks');
const checkbox = id => page.getByRole('checkbox', { name: `选择任务 #${id}`, exact: true });
const row = id => page.getByRole('row').filter({ has: checkbox(id) });
async function waitList(targetPage = page) {
  await targetPage.getByRole('navigation', { name: '任务列表分页' }).getByRole('status').filter({ hasText: /^第 \d+ \/ \d+ 页$/u }).waitFor();
}
async function settle() { await new Promise(done => setTimeout(done, 450)); await Promise.allSettled([...pending]); }
async function availablePort() {
  const socket = createServer(); await new Promise(done => socket.listen(0, '127.0.0.1', done));
  const port = socket.address().port; await new Promise(done => socket.close(done)); return port;
}
function uniqueBytes(resources) { return [...new Map(resources.map(item => [item.path, item])).values()]
  .reduce((sum, item) => sum + item.bytes, 0); }
async function productionProof(root, directory, label) {
  await readFile(resolve(root, directory, 'BUILD_ID'), 'utf8');
  const port = await availablePort(), webOrigin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [resolve(root, 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...configuration.webEnvironment, NODE_ENV: 'production', XHS_NEXT_DIST_DIR: directory,
      XHS_SESSION_SECRET: randomBytes(48).toString('base64url') },
  });
  let output = '', proofContext, historyContext;
  child.stdout.on('data', value => { output = (output + value).slice(-2500); });
  child.stderr.on('data', value => { output = (output + value).slice(-2500); });
  try {
    await until(async () => {
      if (child.exitCode !== null) throw new Error(`Proof server stopped: ${safeError(output)}`);
      return fetch(`${webOrigin}/login`).then(response => response.ok, () => false);
    }, `production ${label}`);
    proofContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await fence(proofContext, webOrigin); await login(proofContext, webOrigin);
    const proofPage = await proofContext.newPage(), resources = [];
    watch(proofPage, webOrigin, resources); phase = `production-${label}-list`;
    await proofPage.goto(`${webOrigin}${target}&query=${encodeURIComponent(`性能端到端 ${suffix}`)}`, { waitUntil: 'networkidle' });
    await waitList(proofPage); await settle();
    const initial = resources.filter(item => item.phase === phase);
    const initialBytes = uniqueBytes(initial);
    phase = `production-${label}-detail`;
    await proofPage.getByRole('button', { name: `查看作业 #${taskIds[0]}：性能端到端 ${suffix} 1`, exact: true }).click();
    await proofPage.getByRole('dialog').getByLabel(/^标题/u).waitFor();
    await proofPage.waitForLoadState('networkidle'); await settle();
    const opened = resources.filter(item => item.phase === phase);
    if (label === 'before') {
      if (round3Proof) {
        check(!initial.some(item => item.containsReview), 'Round-three baseline already defers review body');
        check(initial.some(item => item.containsDeliveryHistory), 'Round-three baseline list downloads the unused delivery history body');
      } else check(initial.some(item => item.containsReview), 'Baseline list downloads the review body');
    }
    else {
      check(!initial.some(item => item.containsReview), 'Optimized production list defers review body');
      check(opened.some(item => item.containsReview), 'First detail click downloads and opens the real review body');
      if (round3Proof) check(!initial.some(item => item.containsDeliveryHistory), 'Round-three list defers the delivery history body');
    }
    const evidence = { label, initialDecodedJsBytes: initialBytes,
      additionalDetailDecodedJsBytes: uniqueBytes(opened), resources };
    if (round3Proof && label === 'after') {
      historyContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await fence(historyContext, webOrigin); await login(historyContext, webOrigin, observer);
      const historyPage = await historyContext.newPage(), historyResources = [];
      watch(historyPage, webOrigin, historyResources); phase = 'production-after-personal-list';
      await historyPage.goto(`${webOrigin}/workbench/personal`, { waitUntil: 'networkidle' });
      await historyPage.getByRole('button', { name: '我的交付记录', exact: true }).waitFor();
      await settle();
      check(!historyResources.some(item => item.containsDeliveryHistory), 'Personal list defers delivery history until its window opens');
      phase = 'production-after-delivery-history';
      await historyPage.getByRole('button', { name: '我的交付记录', exact: true }).click();
      await historyPage.getByRole('region', { name: '我的共享交付记录', exact: true }).waitFor();
      await historyPage.waitForLoadState('networkidle'); await settle();
      const historyOpened = historyResources.filter(item => item.phase === phase);
      check(historyOpened.some(item => item.containsDeliveryHistory), 'First delivery click loads and displays the real history body');
      evidence.additionalHistoryDecodedJsBytes = uniqueBytes(historyOpened);
      evidence.historyResources = historyResources;
    }
    if (followupProof && label === 'after') {
      phase = 'production-after-copy-flow'; const start = requests.length;
      await proofPage.goto(`${webOrigin}/copy-flow`, { waitUntil: 'networkidle' });
      const ownRow = proofPage.getByRole('row').filter({ hasText: admin.username });
      await ownRow.getByRole('button', { name: '选择任务', exact: true }).waitFor(); await settle();
      check(await proofPage.getByRole('navigation', { name: '当前位置', exact: true }).getByText('文案工作入口', { exact: true }).isVisible(),
        'Production COPY flow breadcrumb describes the current route');
      const initial = requests.slice(start).filter(request => request.path === '/api/control-plane/v2/copy-qa/candidates');
      check(initial.length === 1 && new URLSearchParams(initial[0].search).get('summaryOnly') === 'true',
        'Production COPY flow loads its candidate summary exactly once');
      const beforeAccount = requests.length;
      await ownRow.getByRole('button', { name: '选择任务', exact: true }).click();
      await proofPage.getByRole('checkbox', { name: `任务 ${followupFixture.copyCandidateIds[0]} 入批`, exact: true }).waitFor();
      check(requests.slice(beforeAccount).some(request => request.path === '/api/control-plane/v2/copy-qa/candidates'
        && new URLSearchParams(request.search).get('accountId') === String(admin.id)),
      'Production COPY flow requests the selected account only when it opens');
      evidence.copyCandidateInitialRequests = initial.length;
    }
    report.productionProof.push(evidence);
  } catch (error) {
    report.proofServerOutput = safeError(output);
    throw error;
  } finally {
    await historyContext?.close(); await proofContext?.close();
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') {
        await new Promise(done => {
          const killer = spawn(resolve(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
          killer.once('close', done); killer.once('error', done);
        });
      } else child.kill();
    }
    await until(() => child.exitCode !== null || child.signalCode !== null, 'proof server cleanup', 10_000);
  }
}

try {
  await mkdir(resolve('reports'), { recursive: true });
  const database = (await pool.query('SELECT current_database() AS name')).rows[0].name;
  assert.equal(database, 'xhs_control');
  for (const role of ['ADMIN', 'USER']) {
    const actor = (await pool.query(`INSERT INTO app_users(username,display_name,role,password_hash,must_change_password)
      VALUES($1,$2,$3,$4,false) RETURNING id,username,credential_version,role`,
    [`workbench_${role.toLowerCase()}_${suffix}`, `性能验证 ${role} ${suffix}`, role, await hashUserPassword(password)])).rows[0];
    accounts.push(actor); if (role === 'ADMIN') admin = actor; else observer = actor;
  }
  const node = (await pool.query('SELECT id FROM executor_nodes ORDER BY id LIMIT 1')).rows[0];
  assert.ok(node, 'Development executor identity is needed as a task FK');
  for (let index = 1; index <= 2; index += 1) {
    const task = (await pool.query(`INSERT INTO tasks(query,created_by_node_id,state,current_stage,
      created_by_user_id,assigned_to_user_id,assigned_at,assignment_source,
      priority_mode,priority_paused,last_activity_at)
      VALUES($1,$2,'COPY_REVIEW_PENDING','COPY_REVIEW_PENDING',$3,$3,now(),'MANUAL','PAUSE',true,$4) RETURNING id`,
    [`性能端到端 ${suffix} ${index}`, node.id, admin.username, '2026-10-02T03:00:00Z'])).rows[0];
    taskIds.push(Number(task.id));
    const content = { copy: { title: '端到端审核示例', body: '这是开发环境的合成测试文案，仅用于验证界面。'.repeat(25),
      tags: ['#测试', '#开发', '#流程'] }, imagePlan: [{ kind: 'hero', headline: '合成测试', subtitle: '未调用模型', bullets: ['界面验证'] }],
      imageSettings: { format: 'png', background: 'white' } };
    const revision = (await pool.query(`INSERT INTO copy_revisions(task_id,revision,content) VALUES($1,1,$2::jsonb) RETURNING id`,
    [task.id, JSON.stringify(content)])).rows[0];
    await pool.query('UPDATE tasks SET current_copy_revision_id=$2 WHERE id=$1', [task.id, revision.id]);
  }
  if (round3Proof) {
    for (let index = 1; index <= 12; index += 1) {
      const title = `${knowledgeQuery}${String(index).padStart(2, '0')}`;
      const item = (await pool.query("INSERT INTO knowledge_items(kind,name) VALUES('COPY',$1) RETURNING id", [title])).rows[0];
      knowledgeIds.push(Number(item.id));
      const content = { title, sourceCopy: '开发环境合成测试文案', summary: '仅用于分页与标签统计验证',
        analysis: `合成分析 ${index}`, analysisPrompt: '合成提示', labels: [knowledgeQuery], createdAt: new Date().toISOString() };
      await pool.query(`INSERT INTO knowledge_versions(item_id,version,content,content_sha256,status,published_at)
        VALUES($1,1,$2,$3,'PUBLISHED',now())`, [item.id, content,
        createHash('sha256').update(JSON.stringify(content)).digest('hex')]);
    }
    qaBatch = (await pool.query(`INSERT INTO copy_qa_batches_v2(mode,account_id,full_inspection,
      return_threshold_bps,return_trigger_count,member_count,sample_count,created_by_account_id,display_name,created_at)
      VALUES('PERSONAL_MANUAL',$1,true,10000,2,2,2,$1,$2,'2020-01-01T00:00:00Z') RETURNING id,public_id,display_name`,
    [admin.id, `合成端到端批次 ${suffix}`])).rows[0];
    qaBatchIds.push(Number(qaBatch.id));
    for (let index = 1; index <= 2; index += 1) {
      const task = (await pool.query(`INSERT INTO tasks(query,created_by_node_id,state,current_stage,
        created_by_user_id,assigned_to_user_id,assigned_at,assignment_source,priority_mode,priority_paused)
        VALUES($1,$2,'COPY_QC_PENDING','COPY_QC_PENDING',$3,$3,now(),'MANUAL','PAUSE',true) RETURNING id`,
      [`合成质检 ${suffix} ${index}`, node.id, admin.username])).rows[0];
      taskIds.push(Number(task.id));
      const content = { copy: { title: `合成质检标题 ${index}`, body: '开发环境合成测试正文，未调用模型。', tags: ['#测试'] }, imagePlan: [] };
      const hash = createHash('sha256').update(JSON.stringify(content)).digest('hex');
      const revision = (await pool.query(`INSERT INTO copy_revisions(task_id,revision,content,approved_at)
        VALUES($1,1,$2,now()) RETURNING id`, [task.id, content])).rows[0];
      await pool.query('UPDATE tasks SET current_copy_revision_id=$2 WHERE id=$1', [task.id, revision.id]);
      const approval = (await pool.query(`INSERT INTO copy_approval_events(task_id,copy_revision_id,approval_mode,
        approved_by_account_id,approved_by_username,content_sha256)
        VALUES($1,$2,'MANUAL',$3,$4,$5) RETURNING id`, [task.id, revision.id, admin.id, admin.username, hash])).rows[0];
      const member = (await pool.query(`INSERT INTO copy_qa_batch_members_v2(batch_id,task_id,copy_revision_id,
        approval_event_id,approver_account_id,quality_cycle,content_sha256,selected,status)
        VALUES($1,$2,$3,$4,$5,0,$6,true,'PENDING') RETURNING public_id`,
      [qaBatch.id, task.id, revision.id, approval.id, admin.id, hash])).rows[0];
      qaMemberIds.push(member.public_id);
    }
    report.round3Fixtures = { knowledgeIds, qaBatchId: qaBatch.public_id, qaMemberIds };
  }
  if (followupProof) {
    followupFixture = {};
    followupFixture = await createFollowupFixtures({ pool, admin, node, suffix, taskIds,
      storageRoot: configuration.controlPlaneEnvironment.CONTROL_PLANE_STORAGE_ROOT, fixture: followupFixture });
    report.followupFixtures = followupFixture;
  }
  report.fixtureTaskIds = taskIds;
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  await fence(context, origin); await login(context, origin);
  page = await context.newPage(); page.setDefaultTimeout(45_000); watch(page, origin);
  await step('Exact requested development page, filters and real data', async () => {
    phase = 'initial-list'; await page.goto(`${origin}${target}`, { waitUntil: 'networkidle' }); await waitList();
    check(await page.getByLabel('最近变更日期（起）').inputValue() === '2026-09-02', 'Date-from comes from requested URL');
    check(await page.getByLabel('最近变更日期（止，含当天）').inputValue() === '2026-10-02', 'Inclusive date-to comes from requested URL');
    check(await page.getByRole('row').count() > 1, 'Real task data is rendered');
    check(!requests.some(request => request.path === '/api/human-quality-settings'), 'List does not request hidden review settings');
    await page.screenshot({ path: artifact('desktop.png'), fullPage: true });
  });
  await step('Pagination, date changes and browser history', async () => {
    phase = 'pagination'; const start = requests.length;
    await page.getByRole('navigation', { name: '任务列表分页' }).getByRole('button', { name: '下一页', exact: true }).click();
    await page.waitForURL('**/workbench/all?**page=2**'); await waitList(); await settle();
    check(requests.slice(start).filter(request => request.path === '/api/control-plane/v1/tasks').length === 1, 'Next page makes one task-list request');
    check(!requests.slice(start).some(request => request.rsc), 'Next page makes no redundant server-component navigation');
    await page.getByLabel('最近变更日期（起）').fill('2026-09-03'); await waitList();
    await until(() => Promise.resolve(new URL(page.url()).searchParams.get('createdDateFrom') === '2026-09-03'), 'date URL');
    // Filters intentionally replace their current URL, matching prior router.replace.
    // A real navigation supplies a second history entry for back/forward testing.
    await page.goto(`${origin}${target}`, { waitUntil: 'networkidle' }); await waitList();
    await page.goBack(); await until(async () => await page.getByLabel('最近变更日期（起）').inputValue() === '2026-09-03', 'browser back date'); await waitList();
    await page.goForward(); await until(async () => await page.getByLabel('最近变更日期（起）').inputValue() === '2026-09-02', 'browser forward date'); await waitList();
  });
  await step('Search, review detail, lazy history and shared review settings', async () => {
    phase = 'detail'; await page.goto(`${origin}${target}&query=${encodeURIComponent(`性能端到端 ${suffix}`)}`, { waitUntil: 'networkidle' }); await waitList();
    const start = requests.length;
    await row(taskIds[0]).getByRole('button', { name: /^查看作业/u }).click();
    const dialog = page.getByRole('dialog'); await dialog.getByLabel(/^标题/u).waitFor(); await settle();
    check(await dialog.getByLabel(/^标题/u).inputValue() === '端到端审核示例', 'First click opens the real current copy');
    check(!requests.slice(start).some(request => request.path.includes('/history/')), 'History is not loaded until expanded');
    await dialog.getByRole('button', { name: /历史版本与审核记录/u }).click();
    await dialog.getByRole('button', { name: /文案版本 · 第 1 版/u }).click();
    await dialog.getByRole('heading', { name: '端到端审核示例', exact: true }).waitFor();
    check(requests.slice(start).some(request => request.path.includes('/history/copyRevisions/')), 'Expanded history reads its real revision separately');
    await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await row(taskIds[1]).getByRole('button', { name: /^查看作业/u }).click();
    await page.getByRole('dialog').getByLabel(/^标题/u).waitFor(); await settle();
    check(requests.filter(request => request.path === '/api/human-quality-settings').length === 1, 'Two dialogs share one settings request in the session');
    await page.getByRole('dialog').getByRole('button', { name: '关闭弹窗', exact: true }).click();
  });
  await step('Owned real discard and restore, one refresh per mutation', async () => {
    phase = 'discard'; await checkbox(taskIds[0]).check();
    if (followupProof) {
      const controlPlane = createControlPlaneClient({ baseUrl: configuration.safeConfig.controlPlane.url });
      const health = await controlPlane.health();
      check(health.capabilities.executionWorkNotificationsVersion === 1, 'Real center advertises work notification support');
      const cursor = await controlPlane.waitForWorkNotifications({ nodeId: notificationNode, timeoutMs: 1 });
      workAbort = new AbortController(); notificationStartedAt = performance.now();
      workWait = controlPlane.waitForWorkNotifications({ nodeId: notificationNode,
        epoch: cursor.epoch, revision: cursor.revision, timeoutMs: 20_000 }, { signal: workAbort.signal })
        .then(data => ({ data }), error => ({ error: safeError(error) }));
    }
    const batch = page.getByRole('region', { name: '批量任务操作', exact: true });
    await batch.getByRole('button', { name: '废弃 1', exact: true }).click();
    const start = listReads().length;
    await page.getByRole('alertdialog').getByRole('button', { name: '确认废弃', exact: true }).click();
    await row(taskIds[0]).getByText('已废弃', { exact: true }).waitFor(); await settle();
    check(listReads().length - start === 1, 'Discard causes exactly one completed list refresh');
    const cancelled = (await pool.query('SELECT state,priority_paused FROM tasks WHERE id=$1', [taskIds[0]])).rows[0];
    check(cancelled.state === 'CANCELLED' && cancelled.priority_paused, 'Real database confirms the paused fixture was discarded');
    if (followupProof) {
      const notification = await workWait;
      assert.ok(!notification.error, notification.error);
      check(notification.data.changed && !notification.data.timedOut, 'Real committed task mutation resolves the pending work notification');
      check(Object.keys(notification.data).sort().join(',') === 'changed,epoch,revision,settingsRevision,timedOut',
        'Work notification contains only a cursor and flags, without task details');
      const receipt = (await pool.query('SELECT count(*) AS count FROM execution_claim_requests WHERE node_id=$1', [notificationNode])).rows[0];
      check(Number(receipt.count) === 0, 'Real work subscription creates no durable empty claim receipt');
      report.workNotification = { ...notification.data, elapsedMs: Math.round(performance.now() - notificationStartedAt), emptyReceipts: 0 };
      workAbort.abort(); workWait = null;
    }
    phase = 'restore'; const before = listReads().length;
    const restore = row(taskIds[0]).getByRole('button', { name: '恢复任务', exact: true });
    if (await restore.count()) await restore.click();
    else { await page.getByRole('button', { name: `任务 #${taskIds[0]} 的更多操作`, exact: true }).click();
      await page.getByRole('menuitem', { name: '恢复任务', exact: true }).click(); }
    await page.getByRole('alertdialog').getByRole('button', { name: '确认恢复', exact: true }).click();
    await row(taskIds[0]).getByText('待文案审核', { exact: true }).waitFor(); await settle();
    check(listReads().length - before === 1, 'Restore causes exactly one completed list refresh');
    const restored = (await pool.query('SELECT state,priority_paused,mandatory_copy_qc FROM tasks WHERE id=$1', [taskIds[0]])).rows[0];
    check(restored.state === 'COPY_REVIEW_PENDING' && restored.priority_paused && restored.mandatory_copy_qc,
      'Real restore preserves pause and mandatory review without entering a model queue');
  });
  await step('Auxiliary node delay does not block the real task list', async () => {
    phase = 'delayed-nodes'; const delayed = await browser.newContext({ storageState: await context.storageState() });
    let release; const gate = new Promise(done => { release = done; }); let held = 0;
    try {
      await delayed.route('**/*', async route => {
        const url = new URL(route.request().url()); if (url.origin !== origin) return route.abort();
        if (url.pathname === '/api/control-plane/v1/nodes') { held += 1; await gate; }
        return route.continue();
      });
      const delayedPage = await delayed.newPage(); watch(delayedPage, origin);
      await delayedPage.goto(`${origin}${target}&query=${encodeURIComponent(`性能端到端 ${suffix}`)}`, { waitUntil: 'domcontentloaded' });
      await delayedPage.getByRole('checkbox', { name: `选择任务 #${taskIds[0]}`, exact: true }).waitFor();
      check(held > 0, 'Real list renders while its auxiliary node HTTP request remains held');
    } finally { release(); await delayed.close(); }
  });
  await step('Account isolation and mobile layout', async () => {
    phase = 'permissions'; const other = await browser.newContext();
    try {
      await fence(other, origin); await login(other, origin, observer);
      const denied = await other.request.get(`${origin}/api/control-plane/v1/tasks/${taskIds[0]}`);
      check(denied.status() === 403, 'Ordinary other account cannot read the owned review task');
      const personal = await other.request.get(`${origin}/api/control-plane/v1/personal-workspace/tasks?limit=20&offset=0`);
      const payload = await personal.json(); check(personal.ok() && payload.data.items.length === 0, 'Other account has no owned fixture in its personal list');
    } finally { await other.close(); }
    phase = 'mobile'; await page.setViewportSize({ width: 390, height: 844 }); await waitList();
    check(await page.getByRole('navigation', { name: '任务列表分页' }).isVisible(), 'Mobile list retains pagination');
    await page.screenshot({ path: artifact('mobile.png'), fullPage: true });
  });
  await step('Real stored thumbnail, private conditional request and early 304', async () => {
    phase = 'thumbnail';
    const candidates = (await pool.query(`SELECT asset.id,asset.storage_path FROM assets asset
      JOIN tasks task ON task.id=asset.task_id WHERE task.task_kind='CONTENT'
      AND asset.media_type LIKE 'image/%' ORDER BY asset.id DESC LIMIT 30`)).rows;
    let asset;
    for (const candidate of candidates) {
      if (await access(candidate.storage_path).then(() => true, () => false)) { asset = candidate; break; }
    }
    assert.ok(asset, 'A real stored development image is required');
    const path = `${origin}/api/control-plane/v1/assets/${asset.id}?variant=thumbnail`;
    const response = await context.request.get(path);
    assert.equal(response.status(), 200); const etag = response.headers().etag;
    check(Boolean(etag) && (await response.body()).byteLength > 0, 'Real thumbnail returns content and an ETag');
    const cached = await context.request.get(path, { headers: { 'If-None-Match': etag } });
    check(cached.status() === 304 && (await cached.body()).byteLength === 0, 'Conditional thumbnail returns an empty 304 through the real web proxy');
    check(cached.headers()['cache-control'] === 'private, no-cache' && /Cookie/iu.test(cached.headers().vary ?? ''),
      'Conditional image cache remains private to the authenticated account');
    report.thumbnail = { assetId: Number(asset.id), status: cached.status() };
  });
  await step('Real development concurrent read latency', async () => {
    phase = 'read-latency'; const timings = await Promise.all(Array.from({ length: 30 }, async () => {
      const start = performance.now(); const response = await context.request.get(`${origin}/api/control-plane/v1/tasks?limit=20&offset=0&includeTotal=true&createdDateFrom=2026-09-02&createdDateTo=2026-10-02`);
      const payload = await response.json(); assert.equal(response.status(), 200); assert.ok(Array.isArray(payload.data.items));
      return Math.round(performance.now() - start);
    })); timings.sort((a,b) => a-b);
    report.concurrentRead = { requests: 30, p50Ms: timings[14], p95Ms: timings[28], maxMs: timings.at(-1), timings,
      environment: 'Development Next proxy, real 20-row PostgreSQL list; concurrent existing executor traffic' };
  });
  if (round3Proof) {
    await step('Real knowledge pagination, label counts and administrator permissions', async () => {
      phase = 'knowledge'; await page.setViewportSize({ width: 1440, height: 1000 });
      const query = encodeURIComponent(knowledgeQuery);
      const response = await context.request.get(`${origin}/api/control-plane/v1/copy-knowledge?query=${query}&page=1&pageSize=10`);
      assert.equal(response.status(), 200); const first = (await response.json()).data;
      check(first.data.length === 10 && first.pagination.totalItems === 12, 'Real knowledge API returns ten of twelve matching fixture records');
      check(first.labels.find(label => label.name === knowledgeQuery)?.itemCount === 12, 'Knowledge labels aggregate all twelve fixture records');
      const clamped = await context.request.get(`${origin}/api/control-plane/v1/copy-knowledge?query=${query}&page=99&pageSize=10`);
      const last = (await clamped.json()).data;
      check(clamped.ok() && last.pagination.page === 2 && last.data.length === 2, 'Out-of-range knowledge pages clamp to the real final page');
      await page.goto(`${origin}/knowledge?copyQuery=${query}`, { waitUntil: 'networkidle' });
      const pagination = page.getByRole('navigation', { name: '文案知识库分页', exact: true });
      await pagination.getByRole('status').getByText('第 1 / 2 页', { exact: true }).waitFor();
      check(await page.locator('.copy-knowledge-list > li').count() === 10, 'Real knowledge page displays ten matching analyses');
      await pagination.getByRole('button', { name: '下一页', exact: true }).click();
      await pagination.getByRole('status').getByText('第 2 / 2 页', { exact: true }).waitFor();
      check(await page.locator('.copy-knowledge-list > li').count() === 2, 'Knowledge next-page interaction renders the remaining analyses');
      await page.locator('.copy-knowledge-list > li').first().getByRole('button', { name: '查看', exact: true }).click();
      await page.getByRole('dialog').getByText('合成分析', { exact: false }).waitFor();
      check(await page.getByRole('dialog').isVisible(), 'Paginated knowledge retains its full analysis detail');
      await page.getByRole('dialog').getByRole('button', { name: '关闭弹窗', exact: true }).click();
      await page.screenshot({ path: artifact('knowledge.png'), fullPage: true });
      const ordinary = await browser.newContext();
      try {
        await fence(ordinary, origin); await login(ordinary, origin, observer);
        const denied = await ordinary.request.get(`${origin}/api/control-plane/v1/copy-knowledge?query=${query}`);
        check(denied.status() === 403, 'Ordinary account cannot use administrator knowledge pagination');
      } finally { await ordinary.close(); }
      report.knowledge = { matchingRecords: first.pagination.totalItems, firstPageItems: first.data.length,
        lastPageItems: last.data.length, labelCount: first.labels.find(label => label.name === knowledgeQuery)?.itemCount };
    });
    await step('Real COPY_QA v2 bounded pages and one detail refresh after a decision', async () => {
      phase = 'copy-qa';
      const list = await context.request.get(`${origin}/api/control-plane/v2/copy-qa/batches?view=PENDING&limit=1&offset=0`);
      const listData = (await list.json()).data;
      check(list.ok() && listData.items.length <= 1 && listData.limit === 1, 'Real batch list honors its requested page size');
      const detail = await context.request.get(`${origin}/api/control-plane/v2/copy-qa/batches/${qaBatch.public_id}?limit=1&offset=1`);
      const detailData = (await detail.json()).data;
      check(detail.ok() && detailData.items.length === 1 && detailData.pagination.total === 2,
        'Real batch detail reads one bound revision from the two-item fixture');
      await page.goto(`${origin}/copy-qa`, { waitUntil: 'networkidle' });
      const batchRow = page.getByRole('row').filter({ hasText: qaBatch.display_name });
      await batchRow.getByRole('button', { name: '进入批次', exact: true }).click();
      await page.getByRole('heading', { name: qaBatch.display_name, exact: true }).waitFor();
      await page.getByRole('row').filter({ hasText: '合成质检标题 1' }).getByRole('button', { name: '查看并质检', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByText('开发环境合成测试正文，未调用模型。', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: '通过质检', exact: true }).click();
      const before = requests.length;
      await page.getByRole('alertdialog').getByRole('button', { name: '确认通过', exact: true }).click();
      await page.getByRole('row').filter({ hasText: '合成质检标题 1' }).getByText('已通过', { exact: true }).waitFor();
      await settle();
      const reads = requests.slice(before).filter(request => request.method === 'GET' && request.path.startsWith('/api/control-plane/v2/copy-qa/batches'));
      check(reads.length === 1 && reads[0].path.endsWith(qaBatch.public_id), 'A real QA decision refreshes only the current batch detail page');
      const member = (await pool.query(`SELECT member.status,task.state,task.priority_paused FROM copy_qa_batch_members_v2 member
        JOIN tasks task ON task.id=member.task_id WHERE member.public_id=$1`, [qaMemberIds[0]])).rows[0];
      check(member.status === 'PASSED' && member.state === 'IMAGE_QUEUED' && member.priority_paused,
        'Real QA verdict is persisted while the synthetic task remains paused before image execution');
      await page.screenshot({ path: artifact('copy-qa.png'), fullPage: true });
      report.copyQa = { listLimit: listData.limit, detailPageItems: detailData.items.length,
        detailTotal: detailData.pagination.total, refreshesAfterDecision: reads.length };
    });
    await step('Three different warm report scopes can be read together', async () => {
      phase = 'warm-reports';
      const paths = [`accountId=${admin.id}`, `accountId=${observer.id}`, `accountId=${admin.id}&stage=COPY`]
        .map(filter => `${origin}/api/control-plane/v1/admin/operator-performance?period=30d&${filter}`);
      for (const path of paths) {
        const response = await context.request.get(path); assert.equal(response.status(), 200);
        await response.json();
      }
      const results = await Promise.all(paths.map(async path => {
        const start = performance.now(), response = await context.request.get(path);
        const payload = await response.json();
        return { status: response.status(), code: payload.error?.code, elapsedMs: Math.round(performance.now() - start) };
      }));
      check(results.every(result => result.status === 200), 'All three different warmed report scopes return 200 rather than REPORT_BUSY');
      report.warmReportReads = results;
    });
  }
  if (followupProof) {
    await step('Real COPY flow reads task candidates only when their view opens', async () => {
      phase = 'copy-flow'; const start = requests.length;
      await page.goto(`${origin}/copy-flow`, { waitUntil: 'networkidle' });
      const ownRow = page.getByRole('row').filter({ hasText: admin.username });
      await ownRow.getByRole('button', { name: '选择任务', exact: true }).waitFor(); await settle();
      check(await page.getByRole('navigation', { name: '当前位置', exact: true }).getByText('文案工作入口', { exact: true }).isVisible(),
        'Real COPY flow breadcrumb describes the current route');
      const initial = requests.slice(start).filter(request => request.path === '/api/control-plane/v2/copy-qa/candidates');
      check(initial.length > 0 && initial.every(request => new URLSearchParams(request.search).get('summaryOnly') === 'true'
        && !new URLSearchParams(request.search).has('accountId')),
        'Personal flow initial request omits hidden task candidates');
      const summaryResponse = await context.request.get(`${origin}/api/control-plane/v2/copy-qa/candidates?summaryOnly=true`);
      const summary = (await summaryResponse.json()).data;
      check(summaryResponse.ok() && summary.tasks.length === 0
        && summary.users.find(user => user.id === Number(admin.id))?.pendingCount === 3,
      'Real candidate summary preserves full user counts while returning no task bodies');
      await ownRow.getByRole('button', { name: '选择任务', exact: true }).click();
      await page.getByRole('checkbox', { name: `任务 ${followupFixture.copyCandidateIds[0]} 入批`, exact: true }).waitFor();
      check(await page.getByRole('checkbox', { name: /^任务 \d+ 入批$/u }).count() === 3,
        'Opening one user reads and displays only that user task candidates');
      const beforeMixed = requests.length;
      await page.getByRole('tab', { name: '混合模式', exact: true }).click();
      await page.getByRole('heading', { name: '所有待入批任务', exact: true }).waitFor(); await settle();
      check(requests.slice(beforeMixed).some(request => request.path === '/api/control-plane/v2/copy-qa/candidates'
        && !new URLSearchParams(request.search).has('summaryOnly')), 'Mixed candidate data is fetched on its first actual use');
      await page.screenshot({ path: artifact('copy-flow.png'), fullPage: true });
    });
    await step('Real image QA pagination preserves complete filtered statistics and image detail', async () => {
      phase = 'image-qa-pagination';
      const path = `${origin}/api/control-plane/v1/image-qa/items?status=PASSED&personName=${encodeURIComponent(admin.username)}`;
      const largeResponse = await context.request.get(`${path}&limit=200&offset=0`);
      const largeBody = await largeResponse.body(); const legacy = JSON.parse(largeBody).data;
      const firstResponse = await context.request.get(`${path}&limit=50&offset=0&includeSummary=true`);
      const firstBody = await firstResponse.body(); const first = JSON.parse(firstBody).data;
      const lastResponse = await context.request.get(`${path}&limit=50&offset=50&includeSummary=true`);
      const last = (await lastResponse.json()).data;
      check(largeResponse.ok() && firstResponse.ok() && lastResponse.ok(), 'Real image QA legacy and paginated reads both succeed');
      assert.deepEqual(first.summary, followupFixture.expectedSummary); assert.deepEqual(last.summary, first.summary);
      check(first.items.length === 50 && last.items.length === 5 && legacy.items.length === 55,
        'Real image QA reads fifty items and then the remaining five');
      check(first.summary.total === 55 && first.summary.mandatoryCount === 27 && first.summary.assetCount === 55,
        'Filtered image QA statistics cover all frozen records across pages');
      assert.deepEqual([...first.items, ...last.items].map(item => item.id), legacy.items.map(item => item.id));
      check(firstBody.length < largeBody.length, 'Paginated real image QA response is smaller than the previous whole-list read');
      await page.goto(`${origin}/image-qa`, { waitUntil: 'networkidle' });
      check(await page.getByRole('navigation', { name: '当前位置', exact: true }).getByText('图片质检', { exact: true }).isVisible(),
        'Real image QA breadcrumb describes the current route');
      await page.getByRole('tab', { name: '已通过', exact: true }).click();
      await page.getByLabel('按人员姓名筛选全部图片质检项', { exact: true }).fill(admin.username);
      await page.getByRole('button', { name: '应用人员', exact: true }).click();
      const pagination = page.getByRole('navigation', { name: '图片质检分页', exact: true });
      await pagination.getByText('第 1 / 2 页 · 共 55 条', { exact: true }).waitFor();
      check(await page.getByRole('button', { name: '查看图片', exact: true }).count() === 50, 'Real image QA first page renders fifty rows');
      await pagination.getByRole('button', { name: '下一页', exact: true }).click();
      await pagination.getByText('第 2 / 2 页 · 共 55 条', { exact: true }).waitFor();
      await until(async () => await page.getByRole('button', { name: '查看图片', exact: true }).count() === 5,
        'real QA next-page rows');
      check(await page.getByRole('button', { name: '查看图片', exact: true }).count() === 5, 'Real image QA next page renders five rows');
      await page.getByRole('button', { name: '查看图片', exact: true }).first().click();
      const dialog = page.getByRole('dialog'); await dialog.waitFor();
      await until(async () => dialog.locator('img').evaluateAll(images => images.some(img => img.complete && img.naturalWidth > 0)), 'real QA stored image');
      check(await dialog.isVisible(), 'Paginated image QA detail displays the real stored Sharp fixture image');
      await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
      await page.screenshot({ path: artifact('image-qa.png'), fullPage: true });
      report.imageQaPagination = { fullResponseBytes: largeBody.length, pageResponseBytes: firstBody.length,
        firstItems: first.items.length, lastItems: last.items.length, summary: first.summary };
    });
  }
  if (process.argv.includes('--with-production-proof')) {
    assert.ok(process.env.XHS_WORKBENCH_BASELINE_ROOT, 'Baseline build root required');
    await step('Same-data production frontend before/after JavaScript evidence', async () => {
      await productionProof(process.env.XHS_WORKBENCH_BASELINE_ROOT,
        process.env.XHS_WORKBENCH_BASELINE_DIST ?? '.next-speed-baseline', 'before');
      await productionProof(process.cwd(),
        process.env.XHS_WORKBENCH_OPTIMIZED_DIST ?? '.next-speed-optimized', 'after');
      const [before, after] = report.productionProof;
      check(after.initialDecodedJsBytes < before.initialDecodedJsBytes, 'Same-data optimized build transfers less decoded first-screen JavaScript');
      report.frontendReductionPercent = Math.round((1 - after.initialDecodedJsBytes / before.initialDecodedJsBytes) * 1000) / 10;
      report.proofScope = 'Same updated development backend, identical accounts and task fixtures; frontend resource comparison only';
    });
  }
  if (process.argv.includes('--with-production-after-proof')) {
    await step('Final production frontend first-click review and delivery history regression', async () => {
      await productionProof(process.cwd(), process.env.XHS_WORKBENCH_OPTIMIZED_DIST ?? '.next-followup-optimized', 'after');
      report.proofScope = 'Final production frontend served against the development center; no production database connection';
    });
  }
  check(report.browserErrors.length === 0, 'No unexpected browser runtime errors');
  check(report.apiErrors.length === 0, 'No unexpected observed UI API errors');
  check(report.blockedWrites.length === 0, 'No unrelated task or model mutations attempted');
  const executionCount = (await pool.query('SELECT count(*)::int AS count FROM task_executions WHERE task_id=ANY($1::bigint[])', [taskIds])).rows[0].count;
  check(executionCount === 0, 'No execution or model call was created for the fixture tasks');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = safeError(error); process.exitCode = 1;
  await page?.screenshot({ path: artifact('failure.png'), fullPage: true }).catch(() => {});
} finally {
  workAbort?.abort(); await workWait;
  await browser?.close();
  if (taskIds.length) {
    try {
      const cleaned = await pool.query(`UPDATE tasks SET state='CANCELLED',current_stage='CANCELLED',
        priority_mode='PAUSE',priority_paused=true,current_execution_id=NULL,finished_at=now(),updated_at=now()
        WHERE id=ANY($1::bigint[]) AND created_by_user_id=$2 RETURNING id,state`, [taskIds, admin.username]);
      report.cleanup.tasks = cleaned.rows;
    } catch (error) { report.cleanup.taskError = safeError(error); report.status = 'failed'; process.exitCode = 1; }
  }
  report.cleanup.accounts = [];
  if (followupFixture) {
    try { report.cleanup.imageQaBatch = await closeFollowupFixtures(pool, followupFixture, admin); }
    catch (error) { report.cleanup.imageQaError = safeError(error); report.status = 'failed'; process.exitCode = 1; }
  }
  if (knowledgeIds.length) {
    try {
      report.cleanup.knowledge = (await pool.query(`UPDATE knowledge_items SET status='ARCHIVED',updated_at=now()
        WHERE id=ANY($1::bigint[]) AND name LIKE $2 RETURNING id,status`, [knowledgeIds, `${knowledgeQuery}%`])).rows;
    } catch (error) { report.cleanup.knowledgeError = safeError(error); report.status = 'failed'; process.exitCode = 1; }
  }
  if (qaBatchIds.length) {
    try {
      await pool.query(`UPDATE copy_qa_batch_members_v2 SET status='SUPERSEDED'
        WHERE batch_id=ANY($1::bigint[]) AND public_id=ANY($2::uuid[]) AND status='PENDING'`, [qaBatchIds, qaMemberIds]);
      report.cleanup.qaBatches = (await pool.query(`UPDATE copy_qa_batches_v2 SET status='COMPLETED',completed_at=now()
        WHERE id=ANY($1::bigint[]) AND created_by_account_id=$2 RETURNING id,status`, [qaBatchIds, admin.id])).rows;
    } catch (error) { report.cleanup.qaError = safeError(error); report.status = 'failed'; process.exitCode = 1; }
  }
  for (const actor of accounts) {
    try {
      const cleaned = await pool.query(`UPDATE app_users SET status='DISABLED',credential_version=credential_version+1,
        version=version+1,updated_at=now() WHERE id=$1 AND username=$2 RETURNING id,status`, [actor.id, actor.username]);
      report.cleanup.accounts.push(cleaned.rows[0]);
    } catch (error) { report.cleanup.accountError = safeError(error); report.status = 'failed'; process.exitCode = 1; }
  }
  await pool.end(); report.finishedAt = new Date().toISOString(); report.requests = requests;
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, failure: report.failure, assertions: report.assertions.length,
    report: reportPath, concurrentRead: report.concurrentRead, frontendReductionPercent: report.frontendReductionPercent, cleanup: report.cleanup }));
}
