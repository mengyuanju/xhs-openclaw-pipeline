import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { DEFAULT_HUMAN_QUALITY_SETTINGS } from '../src/human-quality-settings.mjs';

test('discard pool recovery confirms, retains failed tasks, and removes restored tasks', {
  skip: process.env.RUN_TASK_RESTORE_BROWSER !== '1', timeout: 90_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const output = resolve('.codex_artifacts/task-restore');
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, 'browser-'));
  await build({ stdin: { contents: `
    import './app/globals.css';
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {CreationWorkbench} from './app/workbench/creation-workbench';
    import {ConfirmDialogProvider} from './components/ui/confirm-dialog';
    import {TextInputDialogProvider} from './components/ui/text-input-dialog';
    import {Toaster} from './components/ui/sonner';
    const role=new URLSearchParams(location.search).get('role')||'ADMIN';
    createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><TextInputDialogProvider>
      <CreationWorkbench role={role} nodeId="test" creatorUserId="admin" creatorAccountId={1} viewKey="DISCARDED"/>
      <Toaster/>
    </TextInputDialogProvider></ConfirmDialogProvider>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, outfile: join(directory, 'bundle.js'), jsx: 'automatic',
  platform: 'browser', conditions: ['style'], alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"' },
  plugins: [{ name: 'next-test', setup(plugin) {
    plugin.onResolve({ filter: /^next\/(navigation|link)$/ }, args => ({ path: args.path, namespace: 'next-test' }));
    plugin.onLoad({ filter: /.*/, namespace: 'next-test' }, args => ({ loader: 'jsx', resolveDir: process.cwd(),
      contents: args.path.endsWith('navigation')
        ? `export const usePathname=()=>location.pathname;const router={replace:path=>history.replaceState(null,'',path),push:path=>location.assign(path),refresh:()=>{}};export const useRouter=()=>router;`
        : `import React from 'react';export default function Link({children,...props}){return <a {...props}>{children}</a>}` }));
  } }] });
  const [js, rawCss] = await Promise.all([readFile(join(directory, 'bundle.js')), readFile(join(directory, 'bundle.css'), 'utf8')]);
  const { default: postcss } = await import('postcss');
  const { default: tailwind } = await import('@tailwindcss/postcss');
  const { css } = await postcss([tailwind()]).process(rawCss, { from: resolve('app/globals.css') });
  const task = { id: 51, query: '误废弃的收纳笔记', state: 'CANCELLED', cancelledFromState: 'COPY_REVIEW_PENDING',
    currentStage: 'CANCELLED', progressPercent: 100,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z', input: {},
    currentCopyRevisionId: 12, assignedToUserId: 'worker', assignedToAccountId: 2 };
  const restores = [], errors = [];
  let fail = true, browser;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/bundle.js') { res.setHeader('content-type', 'application/javascript'); res.end(js); return; }
    if (url.pathname === '/bundle.css') { res.setHeader('content-type', 'text/css'); res.end(css); return; }
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('content-type', 'application/json');
      let data = [];
      if (url.pathname.endsWith('/human-quality-settings')) data = DEFAULT_HUMAN_QUALITY_SETTINGS;
      else if (url.pathname.endsWith('/tasks')) {
        assert.equal(url.searchParams.get('states'), 'CANCELLED');
        const items = task.state === 'CANCELLED' ? [task] : [];
        data = { items, total: items.length, limit: 20, offset: 0 };
      } else if (url.pathname.endsWith('/restore')) {
        let body = ''; for await (const chunk of req) body += chunk;
        restores.push(JSON.parse(body));
        if (fail) { res.statusCode = 409; res.end(JSON.stringify({ error: { code: 'TEST_FAILURE', message: '测试恢复失败，请重试' } })); return; }
        task.state = 'COPY_REVIEW_PENDING'; data = task;
      }
      res.end(JSON.stringify({ data })); return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><body style="padding:24px"><main id="root"></main><script src="/bundle.js"></script></body></html>');
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    const url = `http://127.0.0.1:${server.address().port}/workbench/discarded`;
    await page.goto(url);
    const restore = page.getByRole('button', { name: '恢复任务', exact: true });
    await restore.waitFor({ timeout: 10_000 }).catch(async error => {
      await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true });
      throw new Error(`${error.message}\n${errors.join('\n')}\n${await page.locator('body').innerText()}`);
    });
    await page.screenshot({ path: join(directory, 'discard-pool.png'), fullPage: true });
    await restore.click();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(restores.length, 0);
    await restore.click();
    await page.getByRole('button', { name: '确认恢复', exact: true }).click();
    await page.getByText(/测试恢复失败，请重试/u).first().waitFor();
    assert.equal(await restore.count(), 1);
    fail = false;
    await restore.click();
    await page.getByRole('button', { name: '确认恢复', exact: true }).click();
    await restore.waitFor({ state: 'detached' });
    assert.deepEqual(restores, [{ expectedUpdatedAt: task.updatedAt }, { expectedUpdatedAt: task.updatedAt }]);
    task.state = 'CANCELLED';
    await page.goto(`${url}?role=USER`);
    await page.getByText(task.query, { exact: true }).first().waitFor();
    assert.equal(await page.getByRole('button', { name: '恢复任务', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
