import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';

const accountKey = 'ownership-manager';
const storageKey = `xhs:background-tasks:v1:${accountKey}`;
const foreignTitle = '任务 #429 · 第 4 页图片修复';

function imageEdit(id, overrides = {}) {
  return {
    id, version: 1, attempts: 0, status: 'RUNNING', operation: 'AI_LOCAL',
    source_asset_id: 4, target_page: 4, created_by: 'worker', created_by_account_id: 22,
    config: { instruction: '同事创建的第 4 页修复' }, error: null,
    ...overrides,
  };
}

async function cachedTasks(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '[]'), storageKey);
}

function activeTasks(tasks) {
  return tasks.filter(task => task.status !== 'DELETED');
}

test('background task ownership browser: foreign history stays outside personal reminders and legacy caches are verified', {
  skip: process.env.RUN_BACKGROUND_TASK_BROWSER !== '1', timeout: 90_000,
}, async t => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const root = await mkdtemp(join(tmpdir(), 'background-task-ownership-browser-'));
  const runId = randomUUID(), foreignId = randomUUID(), queuedForeignId = randomUUID();
  const ownId = randomUUID(), legacyOwnId = randomUUID();
  const rows = new Map([
    [foreignId, imageEdit(foreignId)],
    [queuedForeignId, imageEdit(queuedForeignId, {
      status: 'QUEUED', config: { instruction: '同事排队中的第 4 页修复' },
    })],
  ]);
  const requests = [], unexpectedRequests = [], pageErrors = [];
  let browser, server, ownershipGate;
  const gatedIds = new Set();
  try {
    await build({
      stdin: {
        contents: `
          'use client';
          import './app/globals.css';
          import React, { useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { ConfirmDialogProvider } from './components/ui/confirm-dialog';
          import { Toaster } from './components/ui/sonner';
          import { BackgroundTasksProvider, BackgroundTaskNotifications } from './app/components/background-tasks';
          import { CurrentImageEditor } from './app/components/current-image-editor';
          const assets = [1, 2, 3, 4].map(id => ({ id, sha256: String(id).repeat(64), url: '/v1/assets/' + id }));
          function App() {
            const [editor, setEditor] = useState(new URLSearchParams(location.search).get('editor') !== '0');
            return <>
              <BackgroundTaskNotifications />
              <button onClick={() => setEditor(false)}>离开图片工作区</button>
              {editor && <CurrentImageEditor taskId={429} runId="${runId}" copyRevisionId={1}
                asset={assets[3]} assets={assets} page={4} runs={[]} onChanged={async () => {}} />}
            </>;
          }
          createRoot(document.getElementById('root')).render(
            <ConfirmDialogProvider>
              <BackgroundTasksProvider accountKey="${accountKey}" accountUsername="manager" accountId={1}>
                <App />
              </BackgroundTasksProvider>
              <Toaster />
            </ConfirmDialogProvider>
          );
        `,
        resolveDir: process.cwd(), loader: 'tsx',
      },
      bundle: true, outfile: join(root, 'bundle.js'), jsx: 'automatic', platform: 'browser',
      conditions: ['style'], alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"' },
    });
    const [js, rawCss] = await Promise.all([
      readFile(join(root, 'bundle.js')), readFile(join(root, 'bundle.css'), 'utf8'),
    ]);
    const { default: postcss } = await import('postcss');
    const { default: tailwind } = await import('@tailwindcss/postcss');
    const { css } = await postcss([tailwind()]).process(rawCss, {
      from: join(process.cwd(), 'app/globals.css'),
    });
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://fixture');
        if (url.pathname === '/bundle.js') {
          res.setHeader('content-type', 'application/javascript'); res.end(js); return;
        }
        if (url.pathname === '/bundle.css') {
          res.setHeader('content-type', 'text/css'); res.end(css); return;
        }
        if (url.pathname.startsWith('/api/control-plane/v1/assets/')) {
          res.setHeader('content-type', 'image/svg+xml');
          res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1086" height="1448"><rect width="1086" height="1448" fill="#eee"/></svg>');
          return;
        }
        if (url.pathname.startsWith('/api/')) {
          requests.push([req.method, url.pathname]);
          let body = ''; for await (const chunk of req) body += chunk;
          const data = body ? JSON.parse(body) : null;
          let response;
          if (url.pathname === '/api/control-plane/v1/tasks/429/image-edits') {
            if (req.method === 'POST') {
              response = imageEdit(ownId, {
                created_by: 'manager', created_by_account_id: 1, status: 'QUEUED',
                operation: data.operation, source_asset_id: data.sourceAssetId,
                target_page: data.targetPage, config: { instruction: data.instruction },
              });
              rows.set(ownId, response);
            } else response = [foreignId, queuedForeignId, ownId].flatMap(id => rows.has(id) ? [rows.get(id)] : []);
          } else if (/^\/api\/control-plane\/v1\/image-edits\/[^/]+$/u.test(url.pathname)) {
            const id = url.pathname.split('/').at(-1);
            if (gatedIds.has(id)) await ownershipGate.promise;
            response = rows.get(id);
            if (!response) res.statusCode = 404;
          } else {
            unexpectedRequests.push([req.method, url.pathname]); res.statusCode = 404; response = null;
          }
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ data: response })); return;
        }
        res.setHeader('content-type', 'text/html');
        res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/bundle.css"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
      } catch (error) {
        res.statusCode = 500; res.end(JSON.stringify({ error: { message: error.message } }));
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
      headless: true, channel: process.env.IMAGE_EDIT_BROWSER_CHANNEL ?? 'msedge',
    });

    await t.test('opening another account’s queued/running history creates no personal reminder; own work survives closing and reload', async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(origin);
        await page.getByRole('button', { name: '后台任务，0 项处理中，0 条未读提醒', exact: true }).waitFor();
        await page.getByRole('button', { name: '修改图片', exact: true }).click();
        await page.getByRole('tab', { name: /任务记录/u }).click();
        const history = page.getByRole('list', { name: '图片修改记录', exact: true });
        await history.getByText('同事创建的第 4 页修复', { exact: true }).waitFor();
        await history.getByText('同事排队中的第 4 页修复', { exact: true }).waitFor();
        assert.equal(await history.getByText('第 4 页 · worker · 已执行 0 次', { exact: true }).count(), 2,
          'a manager may inspect permitted shared task history');
        assert.deepEqual(activeTasks(await cachedTasks(page)), [],
          'opening a foreign editor must not turn its queued/running work into personal tasks');
        await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
        await page.getByRole('button', { name: '后台任务，0 项处理中，0 条未读提醒', exact: true }).click();
        await page.getByRole('dialog').getByText('暂无后台任务。', { exact: true }).waitFor();
        assert.equal(await page.getByRole('dialog').getByText(foreignTitle, { exact: true }).count(), 0);
        await page.keyboard.press('Escape');

        rows.set(foreignId, { ...rows.get(foreignId), status: 'PREVIEW_READY' });
        rows.set(queuedForeignId, { ...rows.get(queuedForeignId), status: 'PREVIEW_READY' });
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await page.getByRole('button', { name: '修改图片', exact: true }).click();
        await history.getByText('局部修改 · 预览待确认', { exact: true }).first().waitFor();
        assert.equal(await history.getByText('局部修改 · 预览待确认', { exact: true }).count(), 2);
        assert.deepEqual(activeTasks(await cachedTasks(page)), []);
        assert.equal(await page.locator('[data-sonner-toast]').count(), 0,
          'another account’s completion must not show a personal toast');
        assert.equal(requests.some(([, path]) => [foreignId, queuedForeignId].some(id => path.endsWith(`/image-edits/${id}`))), false,
          'foreign history must not start personal background polling');

        await page.getByRole('tab', { name: '本次编辑', exact: true }).click();
        await page.getByLabel('人工生成标识文字', { exact: true }).fill('人工生成');
        await page.getByRole('button', { name: '程序叠加（SVG + Sharp）', exact: true }).click();
        await page.getByRole('button', { name: '生成已选 1 张程序标识预览', exact: true }).click();
        await page.getByText('修改请求已提交，可关闭窗口；完成或失败后会在“后台任务”中提醒。', { exact: true }).waitFor();
        const ownTasks = activeTasks(await cachedTasks(page));
        assert.equal(ownTasks.length, 1);
        assert.equal(ownTasks[0].id, ownId);
        assert.equal(ownTasks[0].ownerUsername, 'manager');
        assert.equal(ownTasks[0].ownerAccountId, 1);
        assert.equal(ownTasks[0].page, 4);
        await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
        await page.getByRole('button', { name: '离开图片工作区', exact: true }).click();
        assert.equal(await page.getByRole('button', { name: '修改图片', exact: true }).count(), 0);

        await page.goto(`${origin}/?editor=0`);
        await page.getByRole('button', { name: '后台任务，1 项处理中，0 条未读提醒', exact: true }).waitFor();
        rows.set(ownId, { ...rows.get(ownId), status: 'PREVIEW_READY' });
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await page.getByRole('button', { name: '后台任务，0 项处理中，1 条未读提醒', exact: true }).waitFor();
        await page.locator('[data-sonner-toast]').getByText(foreignTitle, { exact: true }).waitFor();
        assert.equal(await page.locator('[data-sonner-toast]').count(), 1);
        assert.equal(activeTasks(await cachedTasks(page))[0].id, ownId);
        await page.reload();
        await page.getByRole('button', { name: '后台任务，0 项处理中，1 条未读提醒', exact: true }).click();
        const notifications = page.getByRole('dialog');
        await notifications.getByText(foreignTitle, { exact: true }).waitFor();
        assert.equal(await notifications.locator('article').count(), 1);
        await notifications.getByText('图片修复已完成，请打开“修改图片”检查并采用预览。', { exact: true }).waitFor();
        assert.equal(requests.some(([, path]) => path.endsWith(`/image-edits/${ownId}`)), true);
        assert.equal(requests.filter(([method, path]) => method === 'POST' && path.endsWith('/tasks/429/image-edits')).length, 1);
      } finally { await context.close(); }
    });

    await t.test('old cached foreign results never flash while GET ownership checks are pending and legitimate old results recover', async () => {
      rows.set(legacyOwnId, imageEdit(legacyOwnId, {
        created_by: 'manager', created_by_account_id: 1, target_page: 1, status: 'PREVIEW_READY',
      }));
      ownershipGate = Promise.withResolvers();
      gatedIds.add(foreignId); gatedIds.add(legacyOwnId);
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        await context.addInitScript(({ key, foreignId, legacyOwnId, title }) => {
          const now = Date.now();
          localStorage.setItem(key, JSON.stringify([
            { id: foreignId, kind: 'IMAGE_EDIT', taskId: 429, page: 4, status: 'PREVIEW_READY', createdAt: now, read: false },
            { id: legacyOwnId, kind: 'IMAGE_EDIT', taskId: 430, page: 1, status: 'PREVIEW_READY', createdAt: now - 1, read: false },
          ]));
          window.__foreignBackgroundFlashes = [];
          new MutationObserver(() => {
            if (document.body?.textContent?.includes(title)) window.__foreignBackgroundFlashes.push(title);
          }).observe(document, { subtree: true, childList: true, characterData: true });
        }, { key: storageKey, foreignId, legacyOwnId, title: foreignTitle });
        const page = await context.newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        const ownershipChecks = Promise.all([
          page.waitForRequest(request => request.url().endsWith(`/image-edits/${foreignId}`)),
          page.waitForRequest(request => request.url().endsWith(`/image-edits/${legacyOwnId}`)),
        ]);
        await page.goto(`${origin}/?editor=0`);
        await ownershipChecks;
        await page.getByRole('button', { name: '后台任务，0 项处理中，0 条未读提醒', exact: true }).click();
        const notifications = page.getByRole('dialog');
        await notifications.getByText('暂无后台任务。', { exact: true }).waitFor();
        assert.equal(await notifications.locator('article').count(), 0,
          'old rows must remain hidden until the server identifies their creator');
        assert.equal(await page.locator('[data-sonner-toast]').count(), 0);
        assert.deepEqual(await page.evaluate(() => window.__foreignBackgroundFlashes), []);

        ownershipGate.resolve();
        await page.locator('button[aria-label="后台任务，0 项处理中，1 条未读提醒"]').waitFor();
        await notifications.getByText('任务 #430 · 第 1 页图片修复', { exact: true }).waitFor();
        await page.waitForFunction(({ key, foreignId, legacyOwnId }) => {
          const tasks = JSON.parse(localStorage.getItem(key) ?? '[]');
          const foreign = tasks.find(task => task.id === foreignId);
          return (!foreign || foreign.status === 'DELETED')
            && tasks.some(task => task.id === legacyOwnId && task.ownerUsername === 'manager');
        }, { key: storageKey, foreignId, legacyOwnId });
        const recovered = activeTasks(await cachedTasks(page));
        assert.equal(recovered.length, 1);
        assert.equal(recovered[0].id, legacyOwnId);
        assert.equal(recovered[0].ownerUsername, 'manager');
        assert.equal(recovered[0].ownerAccountId, 1,
          'old cached rows recover only after the server verifies the current account identity');
        assert.equal(await notifications.getByText(foreignTitle, { exact: true }).count(), 0);
        assert.equal(await page.locator('[data-sonner-toast]').getByText(foreignTitle, { exact: true }).count(), 0);
        assert.deepEqual(await page.evaluate(() => window.__foreignBackgroundFlashes), [],
          'foreign old cache rows must not flash before or after ownership verification');
      } finally { ownershipGate.resolve(); await context.close(); gatedIds.clear(); }
    });
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(unexpectedRequests, []);
  } finally {
    ownershipGate?.resolve();
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`), 'only delete the verified temporary test directory');
    await rm(root, { recursive: true, force: true });
  }
});
