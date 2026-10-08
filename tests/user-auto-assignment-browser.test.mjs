import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { normalizeAutoAssignmentEnabled, normalizeAutoAssignmentExpectedVersion, normalizeAutoAssignmentMode } from '../server/src/task-auto-assignment-domain.mjs';

const rootPath = '/api/control-plane/v1/auto-assignment';

test('automatic assignment pool browser: enable confirmation, fixed dispatch capacity, continuous mode and accurate history displays', {
  skip: process.env.RUN_USER_AUTO_ASSIGNMENT_BROWSER !== '1', timeout: 180_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const output = resolve('.codex_artifacts/user-auto-assignment');
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, 'browser-'));
  await build({ stdin: { contents: `import './app/globals.css';import React from 'react';import{createRoot}from'react-dom/client';
    import{ConfirmDialogProvider}from'./components/ui/confirm-dialog';import{Toaster}from'./components/ui/sonner';
    import{UserManagementWorkspace}from'./app/users/user-management-workspace';import{UserManager}from'./app/users/user-manager';
    import{AutoAssignmentPoolManager}from'./app/users/auto-assignment-pool-manager';
    const root=createRoot(document.getElementById('root'));
    async function render(){const data=await fetch('/fixture').then(r=>r.json());const{users,snapshot}=data;
      const overview={totalUsers:users.length,activeUsers:users.filter(u=>u.status==='ACTIVE').length,
        autoAssignableTasks:snapshot.autoAssignableTaskCount,availableWorkers:snapshot.workers.filter(w=>w.canReceive).length,
        poolMembers:snapshot.workers.length,assignmentEnabled:snapshot.settings.enabled};
      root.render(<ConfirmDialogProvider><UserManagementWorkspace overview={overview}
        accountManager={<UserManager initialUsers={users} currentUsername="admin"/>}
        assignmentManager={<AutoAssignmentPoolManager users={users} initialSnapshot={snapshot}/>}/><Toaster/></ConfirmDialogProvider>);}
    window.addEventListener('fixture-refresh',render);render();`, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, outfile: join(directory, 'bundle.js'), jsx: 'automatic', platform: 'browser', conditions: ['style'],
    alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"', 'process.env': '{}' },
    plugins: [{ name: 'fixture-navigation', setup(builder) {
      builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const useRouter=()=>({refresh(){window.dispatchEvent(new Event('fixture-refresh'));}});` }));
    } }] });
  const [js, rawCss] = await Promise.all([readFile(join(directory, 'bundle.js')), readFile(join(directory, 'bundle.css'), 'utf8')]);
  const { default: postcss } = await import('postcss');
  const { default: tailwind } = await import('@tailwindcss/postcss');
  const { css } = await postcss([tailwind()]).process(rawCss, { from: resolve('app/globals.css') });
  const users = [
    { id: 1, username: 'admin', displayName: '管理员', role: 'ADMIN', status: 'ACTIVE', version: 1, mustChangePassword: false },
    { id: 2, username: 'worker-active', displayName: '接手标注', role: 'USER', status: 'ACTIVE', version: 1, mustChangePassword: false },
    { id: 3, username: 'worker-paused', displayName: '暂停标注', role: 'USER', status: 'ACTIVE', version: 1, mustChangePassword: false },
    { id: 4, username: 'worker-disabled', displayName: '停用标注', role: 'USER', status: 'DISABLED', version: 1, mustChangePassword: false },
  ];
  const at = '2026-10-02T00:00:00.000Z';
  const worker = (id, limit, current, total, today, status = 'ACTIVE') => ({
    accountId: id, username: users[id - 1].username, displayName: users[id - 1].displayName,
    userRole: 'USER', userStatus: users[id - 1].status, status, assignmentLimit: limit, allocationCount: limit,
    currentTaskCount: current, fixedQuantityAssignedTotal: total, fixedQuantityAssignedToday: today,
    availableSlots: Math.max(0, limit - current), canReceive: status === 'ACTIVE' && users[id - 1].status === 'ACTIVE',
    version: 1, createdByUsername: 'admin', updatedByUsername: 'admin', createdAt: at, updatedAt: at,
  });
  const snapshot = { settings: { enabled: false, mode: 'FIXED_QUANTITY', version: 1, updatedByUsername: 'admin', createdAt: at, updatedAt: at },
    workers: [worker(2, 5, 2, 9, 2), worker(3, 3, 1, 4, 1, 'PAUSED'), worker(4, 4, 0, 1, 0)],
    unassignedTaskCount: 5, autoAssignableTaskCount: 3, manualAttentionTaskCount: 2 };
  const writes = [], errors = [], unexpected = [];
  let failSettings = false, holdAllocation = null, fixtureReads = 0;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://fixture');
      if (url.pathname === '/bundle.js') { response.setHeader('content-type', 'application/javascript'); response.end(js); return; }
      if (url.pathname === '/bundle.css') { response.setHeader('content-type', 'text/css'); response.end(css); return; }
      if (url.pathname === '/fixture') {
        fixtureReads++; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ users, snapshot })); return;
      }
      if (!url.pathname.startsWith('/api/')) {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><body style="padding:24px"><main id="root"></main><script src="/bundle.js"></script></body></html>'); return;
      }
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw), write = { method: request.method, path: url.pathname, body };
      writes.push(write);
      const reply = data => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data })); };
      if (url.pathname === `${rootPath}/settings` && request.method === 'PATCH') {
        assert.equal(normalizeAutoAssignmentExpectedVersion(body.expectedVersion), snapshot.settings.version);
        const enabled = normalizeAutoAssignmentEnabled(body.enabled), mode = normalizeAutoAssignmentMode(body.mode);
        if (failSettings) {
          failSettings = false; write.rejected = true; response.statusCode = 503; response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ error: { code: 'FIXTURE_SETTINGS_FAILED', message: '隔离总开关保存暂时失败' } })); return;
        }
        Object.assign(snapshot.settings, { enabled, mode, version: snapshot.settings.version + 1 }); reply(snapshot.settings); return;
      }
      if (url.pathname === `${rootPath}/workers/worker-active/allocate` && request.method === 'POST') {
        const member = snapshot.workers[0];
        assert.equal(snapshot.settings.enabled, true); assert.equal(snapshot.settings.mode, 'FIXED_QUANTITY');
        assert.equal(body.accountId, member.accountId); assert.equal(body.expectedVersion, member.version);
        assert.deepEqual(Object.keys(body).sort(), ['accountId', 'expectedVersion']);
        if (holdAllocation) await holdAllocation;
        const requestedCount = member.allocationCount, assignedCount = Math.min(requestedCount, snapshot.autoAssignableTaskCount);
        const result = { outcome: assignedCount > 0 ? 'ASSIGNED' : 'NO_PENDING_TASKS', username: member.username,
          requestedCount, assignedCount, unfilledCount: requestedCount - assignedCount };
        member.currentTaskCount += assignedCount; member.fixedQuantityAssignedTotal += assignedCount;
        member.fixedQuantityAssignedToday += assignedCount; member.availableSlots = Math.max(0, member.assignmentLimit - member.currentTaskCount);
        member.version++; snapshot.autoAssignableTaskCount -= assignedCount;
        snapshot.unassignedTaskCount = snapshot.autoAssignableTaskCount + snapshot.manualAttentionTaskCount;
        reply(result); return;
      }
      unexpected.push(`${request.method} ${url.pathname}`); response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: 'UNEXPECTED', message: 'Unexpected fixture request' } }));
    } catch (error) {
      errors.push(error.message); response.statusCode = 500; response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: { code: 'FIXTURE_ASSERTION', message: error.message } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, page;
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
    page = await browser.newPage({ viewport: { width: 1440, height: 1080 } }); page.on('pageerror', error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}/users`;
    const panel = page.locator('section[aria-labelledby="auto-assignment-pool-title"]');
    const active = panel.getByRole('row').filter({ hasText: '@worker-active' });
    const paused = panel.getByRole('row').filter({ hasText: '@worker-paused' });
    const disabled = panel.getByRole('row').filter({ hasText: '@worker-disabled' });
    const summary = panel.locator('[aria-label="自动分配状态摘要"]');
    const totalSwitch = panel.getByRole('switch', { name: '自动分配总开关', exact: true });
    const allocation = active.getByRole('button', { name: '分配 5 条', exact: true });
    const confirmation = page.getByRole('alertdialog');
    const selectMode = async label => {
      await panel.getByRole('combobox', { name: '自动分配方式', exact: true }).click();
      await page.getByRole('option', { name: label, exact: true }).click();
    };
    const refreshPage = async () => {
      await page.goto(origin); await page.getByRole('tab', { name: /自动分配池/u }).click(); await totalSwitch.waitFor();
    };
    await refreshPage();
    await summary.getByText('共享池待分配 3', { exact: true }).waitFor();
    await summary.getByText('其他未分配 2', { exact: true }).waitFor();
    await summary.getByText('单次数量合计 0', { exact: true }).waitFor();
    await summary.getByText('今日定量已分配 3', { exact: true }).waitFor();
    await summary.getByText('池成员累计已分配 14', { exact: true }).waitFor();
    assert.equal(await allocation.isDisabled(), true); assert.equal(await allocation.getAttribute('title'), '请先开启自动分配总开关');
    assert.equal(await paused.getByRole('button', { name: '分配 3 条', exact: true }).isDisabled(), true);
    assert.equal(await disabled.getByRole('button', { name: '分配 4 条', exact: true }).isDisabled(), true);
    assert.match(await active.locator('[data-label="当前待审文案"]').textContent(), /2 条/u);
    await panel.getByText(/今日按北京时间计算/u).waitFor();

    // F-USER-016: async saved state is intentionally unchanged until the HTTP
    // mutation succeeds; close confirmation must never dispatch a PATCH.
    failSettings = true; await totalSwitch.click();
    await page.getByText(/隔离总开关保存暂时失败/u).waitFor();
    assert.equal(await totalSwitch.isChecked(), false); assert.equal(snapshot.settings.version, 1);
    await totalSwitch.click(); await summary.getByText('单次数量合计 5', { exact: true }).waitFor();
    assert.equal(await totalSwitch.isChecked(), true);
    assert.deepEqual(writes.at(-1).body, { enabled: true, mode: 'FIXED_QUANTITY', expectedVersion: 1 });
    const beforeOffCancel = writes.length; await totalSwitch.click();
    await confirmation.getByRole('heading', { name: '关闭自动分配？', exact: true }).waitFor();
    await confirmation.getByText(/不会回收已经分配的任务/u).waitFor();
    await confirmation.getByRole('button', { name: '取消', exact: true }).click(); await confirmation.waitFor({ state: 'detached' });
    assert.equal(writes.length, beforeOffCancel); assert.equal(snapshot.settings.enabled, true);
    await totalSwitch.click(); await confirmation.getByRole('button', { name: '确认关闭', exact: true }).click();
    await summary.getByText('单次数量合计 0', { exact: true }).waitFor();
    assert.equal(snapshot.workers[0].currentTaskCount, 2, 'closing the switch never reclaims assigned tasks');
    assert.equal(await allocation.isDisabled(), true);
    await totalSwitch.click(); await summary.getByText('单次数量合计 5', { exact: true }).waitFor();

    // F-USER-022/024: the requested quantity is five but this pool has only three.
    // Actual request/version and the response-derived shortfall/history must agree.
    assert.match(await active.locator('[data-label="分配规则"]').textContent(), /预计本次最多 3 条/u);
    const beforeAllocationCancel = writes.length; await allocation.click();
    await confirmation.getByRole('heading', { name: '给 接手标注 分配 5 条？', exact: true }).waitFor();
    await confirmation.getByText(/标注完成后不会自动补位/u).waitFor();
    await confirmation.getByRole('button', { name: '取消', exact: true }).click(); await confirmation.waitFor({ state: 'detached' });
    assert.equal(writes.length, beforeAllocationCancel); assert.equal(snapshot.workers[0].currentTaskCount, 2);
    await allocation.click(); await confirmation.getByRole('button', { name: '确认分配', exact: true }).click();
    await page.getByText(/已给 接手标注 分配 3 条；当前可分配任务不足，少 2 条/u).waitFor();
    assert.deepEqual(writes.at(-1).body, { accountId: 2, expectedVersion: 1 });
    assert.equal(writes.at(-1).path, `${rootPath}/workers/worker-active/allocate`);
    await active.getByText('累计分配 12 条', { exact: true }).waitFor(); await active.getByText('今日分配 5 条', { exact: true }).waitFor();
    assert.match(await active.locator('[data-label="当前待审文案"]').textContent(), /5 条/u);
    await summary.getByText('今日定量已分配 6', { exact: true }).waitFor(); await summary.getByText('池成员累计已分配 17', { exact: true }).waitFor();
    assert.equal(await allocation.isDisabled(), true); assert.equal(await allocation.getAttribute('title'), '当前没有可分配的待审核任务');
    await panel.getByRole('status').getByText(/另有 2 条未分配任务尚未进入自动分配队列/u).waitFor();
    await page.screenshot({ path: join(directory, 'fixed-partial-capacity.png'), fullPage: true });

    snapshot.autoAssignableTaskCount = 7; snapshot.unassignedTaskCount = 9; await refreshPage();
    let releaseAllocation; holdAllocation = new Promise(resolve => { releaseAllocation = resolve; });
    await allocation.click(); await confirmation.getByRole('button', { name: '确认分配', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="自动分配总开关"]')?.disabled);
    assert.equal(await allocation.isDisabled(), true); assert.equal(await panel.getByRole('combobox', { name: '自动分配方式', exact: true }).isDisabled(), true);
    releaseAllocation(); holdAllocation = null;
    await page.getByText('已给 接手标注 分配 5 条任务，本次分配已结束。', { exact: true }).waitFor();
    assert.deepEqual(writes.at(-1).body, { accountId: 2, expectedVersion: 2 });
    await active.getByText('累计分配 17 条', { exact: true }).waitFor(); await active.getByText('今日分配 10 条', { exact: true }).waitFor();
    assert.match(await active.locator('[data-label="当前待审文案"]').textContent(), /10 条/u,
      'fixed dispatch is a configured one-time quantity, not a current-pending upper bound');
    assert.equal(snapshot.autoAssignableTaskCount, 2);
    const explicitAllocationCount = writes.filter(write => write.path.endsWith('/allocate')).length;
    await refreshPage(); assert.equal(writes.filter(write => write.path.endsWith('/allocate')).length, explicitAllocationCount,
      'reading the fixed-mode UI does not silently dispatch again');

    // F-USER-023/024: actual mode confirmation requests and displays are covered
    // here. Completion/replenishment snapshots below are synthetic; the temporary
    // PostgreSQL modes test independently verifies the real scheduler behavior.
    const beforeModeCancel = writes.length; await selectMode('持续补位');
    await confirmation.getByRole('heading', { name: '切换为持续补位？', exact: true }).waitFor();
    await confirmation.getByRole('button', { name: '取消', exact: true }).click(); await confirmation.waitFor({ state: 'detached' });
    assert.equal(writes.length, beforeModeCancel); assert.equal(snapshot.settings.mode, 'FIXED_QUANTITY');
    await selectMode('持续补位'); await confirmation.getByRole('button', { name: '确认切换', exact: true }).click();
    await panel.getByText('自动补位已开启', { exact: true }).waitFor();
    assert.equal(writes.at(-1).body.mode, 'CONTINUOUS'); assert.equal(writes.at(-1).body.enabled, true);
    assert.equal(await allocation.count(), 0, 'continuous mode does not mount the manual allocation button');
    await active.getByText('额度已满', { exact: true }).waitFor(); await summary.getByText('当前可补 0', { exact: true }).waitFor();
    assert.equal(await active.locator('[data-label="定量分配记录"]').count(), 0, 'fixed-dispatch history columns are conditional on fixed mode');
    const activeWorker = snapshot.workers[0]; activeWorker.currentTaskCount = 4; activeWorker.availableSlots = 1;
    await refreshPage(); await active.getByText('可补 1 条', { exact: true }).waitFor(); await summary.getByText('当前可补 1', { exact: true }).waitFor();
    activeWorker.currentTaskCount = 5; activeWorker.availableSlots = 0; snapshot.autoAssignableTaskCount--;
    snapshot.unassignedTaskCount = snapshot.autoAssignableTaskCount + snapshot.manualAttentionTaskCount;
    await refreshPage(); await active.getByText('额度已满', { exact: true }).waitFor(); await summary.getByText('当前可补 0', { exact: true }).waitFor();
    assert.equal(activeWorker.fixedQuantityAssignedTotal, 17); assert.equal(activeWorker.fixedQuantityAssignedToday, 10);
    assert.equal(writes.filter(write => write.path.endsWith('/allocate')).length, explicitAllocationCount);
    await page.setViewportSize({ width: 390, height: 844 });
    const size = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
    assert.ok(size.content <= size.viewport + 1, JSON.stringify(size));
    await page.screenshot({ path: join(directory, 'continuous-capacity-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1080 });
    await selectMode('定量分配'); await confirmation.getByRole('button', { name: '确认切换', exact: true }).click();
    await summary.getByText('今日定量已分配 11', { exact: true }).waitFor(); await summary.getByText('池成员累计已分配 22', { exact: true }).waitFor();
    await active.getByText('累计分配 17 条', { exact: true }).waitFor(); await active.getByText('今日分配 10 条', { exact: true }).waitFor();
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    assert.ok(fixtureReads >= 8);
    assert.ok(writes.every(write => (write.path === `${rootPath}/settings` && write.method === 'PATCH')
      || (write.path === `${rootPath}/workers/worker-active/allocate` && write.method === 'POST')));
    console.log(`auto assignment screenshots: ${directory}`);
    console.log(JSON.stringify({ settingsWrites: writes.filter(write => write.method === 'PATCH').length,
      fixedDispatches: explicitAllocationCount, paidModelCalls: 0, originalHundredRowDatasetModified: false }));
  } catch (error) {
    if (page) await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
