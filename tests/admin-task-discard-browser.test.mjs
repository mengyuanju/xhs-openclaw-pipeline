import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { DEFAULT_HUMAN_QUALITY_SETTINGS } from '../src/human-quality-settings.mjs';

function createTasks() {
  const states = ['COPY_QUEUED', 'IMAGE_QUEUED', 'COPY_REVIEW_PENDING', 'COPY_QC_PENDING',
    'COPY_REVIEW_PENDING', 'COPY_REVIEW_PENDING'];
  return states.map((state, index) => ({
    id: 101 + index, query: `管理员废弃测试 ${index + 1}`, state, currentStage: state,
    createdAt: '2026-09-30T08:00:00.000Z', updatedAt: '2026-09-30T09:00:00.000Z',
    input: {}, progressPercent: 100, currentCopyRevisionId: index >= 1 ? 12 + index : null,
    createdByUserId: 'admin', createdByAccountId: 1, createdByDisplayName: '管理员', createdByRole: 'ADMIN',
    assignedToUserId: 'worker', assignedToAccountId: 2, assignedToDisplayName: '标注员',
    ...(index === 4 ? { copyQaReworkPending: true } : {}),
    ...(index === 5 ? { mandatoryCopyQc: true, mandatoryCopyQcOrigin: 'QA_RETURN' } : {}),
  }));
}

test('admin discards pending copy and queue tasks with confirmation, then can permanently delete', {
  skip: process.env.RUN_ADMIN_DISCARD_BROWSER !== '1', timeout: 120_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const output = resolve('.codex_artifacts/admin-task-discard');
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, 'browser-'));
  await build({
    stdin: { contents: `
      import './app/globals.css';
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {CreationWorkbench} from './app/workbench/creation-workbench';
      import {ConfirmDialogProvider} from './components/ui/confirm-dialog';
      import {TextInputDialogProvider} from './components/ui/text-input-dialog';
      import {Toaster} from './components/ui/sonner';
      const params=new URLSearchParams(location.search), role=params.get('role')||'ADMIN';
      const viewKey=params.get('view')||'ALL_JOBS';
      createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><TextInputDialogProvider>
        <CreationWorkbench role={role} nodeId="test" creatorUserId="admin" creatorAccountId={1} viewKey={viewKey}/>
        <Toaster/>
      </TextInputDialogProvider></ConfirmDialogProvider>);
    `, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, outfile: join(directory, 'bundle.js'), jsx: 'automatic', platform: 'browser', conditions: ['style'],
    alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'next-test', setup(plugin) {
      plugin.onResolve({ filter: /^next\/(navigation|link)$/ }, args => ({ path: args.path, namespace: 'next-test' }));
      plugin.onLoad({ filter: /.*/, namespace: 'next-test' }, args => ({ loader: 'jsx', resolveDir: process.cwd(),
        contents: args.path.endsWith('navigation')
          ? `export const usePathname=()=>location.pathname;const router={replace:path=>history.replaceState(null,'',path),push:path=>location.assign(path),refresh:()=>{}};export const useRouter=()=>router;`
          : `import React from 'react';export default function Link({children,...props}){return <a {...props}>{children}</a>}` }));
    } }],
  });
  const [js, rawCss] = await Promise.all([
    readFile(join(directory, 'bundle.js')), readFile(join(directory, 'bundle.css'), 'utf8'),
  ]);
  const { default: postcss } = await import('postcss');
  const { default: tailwind } = await import('@tailwindcss/postcss');
  const { css } = await postcss([tailwind()]).process(rawCss, { from: resolve('app/globals.css') });
  let tasks = createTasks(), browser, page, failReads = false;
  const actions = [], deletions = [], singleDeletes = [], retries = [], exports = [], errors = [], unexpected = [], reads = [];
  const { default: JSZip } = await import('jszip'); const zip = new JSZip(); zip.file('synthetic.txt', 'Fake browser attachment; no model output.'); const exportBytes = await zip.generateAsync({ type: 'nodebuffer' });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/bundle.js') { response.setHeader('content-type', 'application/javascript'); response.end(js); return; }
      if (url.pathname === '/bundle.css') { response.setHeader('content-type', 'text/css'); response.end(css); return; }
      if (!url.pathname.startsWith('/api/')) {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><body style="padding:24px"><main id="root"></main><script src="/bundle.js"></script></body></html>');
        return;
      }
      const reply = data => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data })); };
      if (request.method === 'GET') {
        if (url.pathname === '/api/control-plane/health') {
          reply({ capabilities: { adminTaskFilters: true, adminTaskActivityDateFilters: 1 } }); return;
        }
        if (url.pathname.endsWith('/human-quality-settings')) { reply(DEFAULT_HUMAN_QUALITY_SETTINGS); return; }
        if (url.pathname.endsWith('/nodes') || url.pathname.endsWith('/task-views')) { reply([]); return; }
        if (url.pathname === '/api/control-plane/v1/personal-workspace/tasks') {
          reads.push(url.search); reply({ items: [], total: 0, limit: 20, offset: 0, counts: {}, updatedAt: new Date().toISOString() }); return;
        }
        if (url.pathname === '/api/control-plane/v1/tasks') {
          if (failReads) { response.statusCode = 503; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ error: { code: 'FIXTURE', message: 'temporary list unavailable' } })); return; }
          reads.push(url.search);
          const states = url.searchParams.get('states')?.split(',');
          const selected = states ? tasks.filter(task => states.includes(task.state)) : tasks;
          const limit = Number(url.searchParams.get('limit')), offset = Number(url.searchParams.get('offset'));
          reply({ items: selected.slice(offset, offset + limit), total: selected.length, limit, offset }); return;
        }
      }
      if (request.method === 'POST' && url.pathname === '/api/control-plane/v1/tasks/batch-actions') {
        let raw = ''; for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw); actions.push(body);
        if (body.action === 'RETRY') { actions.pop(); retries.push(body); for (const id of body.taskIds) { const task = tasks.find(item => item.id === id); task.state = task.state.startsWith('COPY') ? 'COPY_QUEUED' : 'IMAGE_QUEUED'; } reply({ action: 'RETRY', succeeded: body.taskIds, failed: [] }); return; }
        assert.equal(body.action, 'DISCARD');
        for (const id of body.taskIds) {
          const task = tasks.find(item => item.id === id);
          assert.ok(task, `discard refers to fixture task #${id}`);
          assert.ok(['COPY_QUEUED', 'IMAGE_QUEUED', 'COPY_REVIEW_PENDING'].includes(task.state));
          assert.equal(task.copyQaReworkPending === true || task.mandatoryCopyQcOrigin === 'QA_RETURN', false,
            'admin task discard must retain returned-copy quality gates');
          task.cancelledFromState = task.state; task.state = 'CANCELLED'; task.currentStage = 'CANCELLED';
        }
        reply({ action: 'DISCARD', succeeded: body.taskIds, failed: [] }); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/control-plane/v1/tasks/batch-permanent-delete') {
        let raw = ''; for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw); deletions.push(body);
        assert.equal(body.deletionPassword, 'fixture-delete-password');
        assert.ok(body.taskIds.every(id => tasks.find(task => task.id === id)?.state === 'CANCELLED'));
        tasks = tasks.filter(task => !body.taskIds.includes(task.id));
        reply({ action: 'PERMANENT_DELETE', succeeded: body.taskIds, failed: [], cleanupPending: [] }); return;
      }
      if (request.method === 'DELETE' && /\/tasks\/\d+\/permanent$/u.test(url.pathname)) {
        let raw = ''; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw); const id = Number(url.pathname.split('/').at(-2)); singleDeletes.push({ id, body });
        if (body.deletionPassword !== 'fixture-delete-password') { response.statusCode = 403; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ error: { code: 'BAD_PASSWORD', message: '删除二级密码错误' } })); return; }
        tasks = tasks.filter(task => task.id !== id); reply({ id, deleted: true }); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/control-plane/v1/tasks/batch-archive') {
        let raw = ''; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw); exports.push(body); response.setHeader('content-type', 'application/zip'); response.setHeader('content-length', exportBytes.length); response.end(exportBytes); return;
      }
      unexpected.push(`${request.method} ${url.pathname}`);
      response.statusCode = 404; response.end(JSON.stringify({ error: { code: 'UNEXPECTED', message: 'Unexpected fixture request' } }));
    } catch (error) {
      errors.push(error.message); response.statusCode = 500;
      response.end(JSON.stringify({ error: { code: 'FIXTURE', message: error.message } }));
    }
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const check = id => page.getByRole('checkbox', { name: `选择任务 #${id}`, exact: true });
    const row = id => page.getByRole('row').filter({ has: check(id) });
    const batch = page.getByRole('region', { name: '批量任务操作', exact: true });
    const confirmation = page.getByRole('alertdialog');
    const openRowDiscard = async id => {
      const direct = row(id).getByRole('button', { name: '废弃', exact: true });
      if (await direct.count()) await direct.click();
      else {
        await page.getByRole('button', { name: `任务 #${id} 的更多操作`, exact: true }).click();
        await page.getByRole('menuitem', { name: '废弃', exact: true }).click();
      }
      await confirmation.waitFor();
    };

    await page.goto(`${origin}/workbench/all`);
    await check(101).waitFor();
    await openRowDiscard(103);
    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(actions.length, 0, 'cancelling individual admin discard performs no write');
    await page.getByRole('checkbox', { name: '选择当前页全部任务中的可交付项', exact: true }).check();
    await batch.getByText('已选 6 条（当前页）', { exact: true }).waitFor();
    const discard = batch.getByRole('button', { name: '废弃 3', exact: true });
    assert.equal(await discard.isDisabled(), false);
    assert.equal(await batch.getByRole('button', { name: '永久删除 0', exact: true }).isDisabled(), true);
    await discard.click();
    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(actions.length, 0, 'cancelling mixed-selection discard performs no write');
    const readsBeforeDiscard = reads.length;
    await discard.click();
    await confirmation.getByRole('button', { name: '批量废弃', exact: true }).click();
    await page.getByText('批量废弃完成：成功 3 条。', { exact: true }).first().waitFor();
    await row(103).getByText('已废弃', { exact: true }).waitFor();
    assert.deepEqual(actions, [{ action: 'DISCARD', taskIds: [101, 102, 103] }]);
    assert.ok(reads.length > readsBeforeDiscard, 'successful discard refreshes tasks from the service');
    assert.deepEqual(tasks.slice(3).map(task => task.state), ['COPY_QC_PENDING', 'COPY_REVIEW_PENDING', 'COPY_REVIEW_PENDING']);
    const permanent = batch.getByRole('button', { name: '永久删除 3', exact: true });
    assert.equal(await permanent.isDisabled(), false, 'retained selection immediately enables deletion after discard refresh');
    for (const id of [101, 102, 103]) assert.equal(await check(id).isChecked(), true);
    await permanent.click();
    await confirmation.getByRole('heading', { name: '批量永久删除 3 条任务', exact: true }).waitFor();
    assert.equal(await confirmation.getByRole('button', { name: '永久删除 3 条任务', exact: true }).isDisabled(), true,
      'admin permanent delete still requires the existing password confirmation');
    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(deletions.length, 0, 'cancelling permanent deletion performs no write');
    await page.screenshot({ path: join(directory, 'discarded-ready-to-delete.png'), fullPage: true });
    await permanent.click();
    await confirmation.getByLabel('删除二级密码', { exact: true }).fill('fixture-delete-password');
    await confirmation.getByRole('button', { name: '永久删除 3 条任务', exact: true }).click();
    await check(103).waitFor({ state: 'detached' });
    assert.deepEqual(deletions, [{ taskIds: [101, 102, 103], deletionPassword: 'fixture-delete-password' }]);
    assert.deepEqual(tasks.map(task => task.id), [104, 105, 106], 'deletion removes only the three discarded tasks');

    tasks = createTasks();
    await page.goto(`${origin}/workbench/copy-review?view=COPY_REVIEW`);
    await check(103).waitFor();
    await openRowDiscard(103);
    await confirmation.getByRole('button', { name: '确认废弃', exact: true }).click();
    await check(103).waitFor({ state: 'detached' });
    assert.deepEqual(actions[1], { action: 'DISCARD', taskIds: [103] }, 'review row uses the same admin DISCARD API');
    assert.equal(tasks.find(task => task.id === 105).state, 'COPY_REVIEW_PENDING');
    assert.equal(tasks.find(task => task.id === 106).state, 'COPY_REVIEW_PENDING');

    tasks = createTasks(); tasks[0].state = 'CANCELLED'; tasks[0].cancelledFromState = 'COPY_QUEUED'; tasks[1].state = 'COPY_RUNNING'; tasks[2].state = 'COPY_FAILED'; tasks[3].state = 'IMAGE_FAILED'; tasks[4].state = 'REVIEWED'; tasks[4].deliveryStatus = 'READY'; tasks[5].state = 'REVIEWED'; tasks[5].deliveryStatus = 'BLOCKED';
    tasks.push(...Array.from({ length: 20 }, (_, index) => ({ ...tasks[4], id: 201 + index, query: `合成资源导出 ${index + 1}` })));
    failReads = true; await page.goto(`${origin}/workbench/all`); await page.getByText('暂时无法读取任务，请重试。', { exact: true }).waitFor(); failReads = false; await page.getByRole('button', { name: '刷新', exact: true }).click(); await check(101).waitFor();
    await page.getByRole('button', { name: '任务 #101 的更多操作', exact: true }).click(); await page.getByRole('menuitem', { name: '永久删除', exact: true }).click(); await confirmation.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(singleDeletes.length, 0);
    await page.getByRole('button', { name: '任务 #101 的更多操作', exact: true }).click(); await page.getByRole('menuitem', { name: '永久删除', exact: true }).click(); await confirmation.getByLabel('删除二级密码', { exact: true }).fill('wrong'); await confirmation.getByRole('button', { name: '永久删除这条任务', exact: true }).click(); await confirmation.getByRole('alert').filter({ hasText: '删除二级密码错误' }).waitFor(); assert.equal(await confirmation.getByLabel('删除二级密码', { exact: true }).inputValue(), ''); assert.equal(await confirmation.isVisible(), true); assert.equal(tasks.some(task => task.id === 101), true);
    await confirmation.getByLabel('删除二级密码', { exact: true }).fill('fixture-delete-password'); await confirmation.getByRole('button', { name: '永久删除这条任务', exact: true }).click(); await check(101).waitFor({ state: 'detached' }); assert.deepEqual(singleDeletes.map(item => item.id), [101, 101]);
    await page.getByRole('button', { name: '任务 #102 的更多操作', exact: true }).click(); assert.equal(await page.getByRole('menuitem', { name: '永久删除', exact: true }).count(), 0); await page.keyboard.press('Escape');
    for (const id of [102, 103, 104, 105]) await check(id).check(); await batch.getByRole('button', { name: '重试 3', exact: true }).click(); await confirmation.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(retries.length, 0); await batch.getByRole('button', { name: '重试 3', exact: true }).click(); await confirmation.getByRole('button', { name: '批量重试', exact: true }).click(); await page.getByText('批量重试完成：成功 3 条。', { exact: true }).first().waitFor(); assert.deepEqual(retries, [{ action: 'RETRY', taskIds: [102, 103, 104] }]);
    await batch.getByRole('button', { name: '清除选择', exact: true }).click(); await page.getByRole('checkbox', { name: '选择当前页全部任务中的可交付项', exact: true }).check();
    const exportCount = await batch.getByRole('button', { name: /^导出 \d+$/ }).innerText();
    if (exportCount !== '导出 21') { await page.getByRole('combobox', { name: '每页条数', exact: true }).click(); await page.getByRole('option', { name: '100 条 / 页', exact: true }).click(); await page.getByRole('checkbox', { name: '选择当前页全部任务中的可交付项', exact: true }).check(); }
    assert.equal(await batch.getByRole('button', { name: '导出 21', exact: true }).isDisabled(), true); await check(220).uncheck(); const [download] = await Promise.all([page.waitForEvent('download'), batch.getByRole('button', { name: '导出 20', exact: true }).click()]); const exportedPath = join(directory, 'batch-fixture.zip'); await download.saveAs(exportedPath); assert.deepEqual(await readFile(exportedPath), exportBytes); assert.equal(exports[0].taskIds.length, 20); assert.equal(exports[0].taskIds.includes(106), false);

    tasks = [];
    await page.goto(`${origin}/workbench/personal?view=PERSONAL`);
    await page.getByText('当前没有符合所选归属和状态的个人作业。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '创建第一条笔记', exact: true }).click();
    await page.getByRole('dialog').getByLabel('笔记选题（Query）', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.goto(`${origin}/workbench/personal?view=PERSONAL&role=USER`);
    await page.getByText('当前没有符合所选归属和状态的个人作业。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '创建第一条笔记', exact: true }).count(), 0);
    await page.goto(`${origin}/workbench/all`);
    await page.getByText('没有符合当前筛选条件的作业。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('alert').count(), 0);
    tasks = createTasks();
    await page.goto(`${origin}/workbench/copy-review?view=COPY_REVIEW&role=USER`);
    await page.getByText('管理员废弃测试 3', { exact: true }).first().waitFor();
    assert.equal(await page.getByRole('region', { name: '批量任务操作', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '废弃', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '任务 #103 的更多操作', exact: true }).count(), 0,
      'ordinary reviewers do not receive the new admin discard action');
    assert.equal(actions.length, 2);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
  } catch (error) {
    if (page) {
      await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true });
      throw new Error(`${error.message}\nBrowser errors: ${errors.join('; ')}\nUnexpected requests: ${unexpected.join('; ')}\n${await page.locator('body').innerText()}`, { cause: error });
    }
    throw error;
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
