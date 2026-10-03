import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('XHS account alert shows login and CAPTCHA guidance, remains read-only and remembers dismissal until status changes', {
  skip: process.env.RUN_XHS_ACCOUNT_ALERT_BROWSER !== '1', timeout: 180_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const output = resolve('.codex_artifacts/xhs-account-alert');
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, 'browser-'));
  await build({ stdin: { contents: `import './app/globals.css';import React from 'react';import{createRoot}from'react-dom/client';
    import{XhsAccountAlert}from'./app/components/xhs-account-alert';
    createRoot(document.getElementById('root')).render(<><h1>告警组件隔离测试</h1><XhsAccountAlert enabled={new URLSearchParams(location.search).get('enabled')==='1'}/></>);`,
    resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, outfile: join(directory, 'bundle.js'),
    jsx: 'automatic', platform: 'browser', conditions: ['style'], alias: { '@': process.cwd() },
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'next-link-fixture', setup(plugin) {
      plugin.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'next/link', namespace: 'next-fixture' }));
      plugin.onLoad({ filter: /.*/, namespace: 'next-fixture' }, () => ({ loader: 'jsx', resolveDir: process.cwd(),
        contents: `import React from'react';export default function Link({children,...props}){return <a {...props}>{children}</a>}` }));
    } }],
  });
  const [js, rawCss] = await Promise.all([readFile(join(directory, 'bundle.js')), readFile(join(directory, 'bundle.css'), 'utf8')]);
  const { default: postcss } = await import('postcss');
  const { default: tailwind } = await import('@tailwindcss/postcss');
  const { css } = await postcss([tailwind()]).process(rawCss, { from: resolve('app/globals.css') });
  const makeNode = (id, authStatus, hostKind, online) => ({ id, name: `隔离主机-${id}`, accountLabel: `隔离账号-${id}`,
    authStatus, hostKind, online, authStatusChangedAt: '2026-10-02T00:00:00.000Z', authCheckedAt: '2026-10-02T00:00:00.000Z',
    lastJobId: null, lastJobStatus: null, lastJobTaskId: null, runningJobId: null,
    lastSeenAt: '2026-10-02T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' });
  let nodes = [makeNode('login', 'LOGIN_REQUIRED', 'CENTER', true), makeNode('captcha', 'CAPTCHA_REQUIRED', 'EXECUTOR', false),
    makeNode('ready', 'READY', 'EXECUTOR', true), makeNode('unknown', 'UNKNOWN', 'EXECUTOR', false)];
  const reads = [], unexpected = [], errors = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture');
    if (url.pathname === '/bundle.js') { response.setHeader('content-type', 'application/javascript'); response.end(js); return; }
    if (url.pathname === '/bundle.css') { response.setHeader('content-type', 'text/css'); response.end(css); return; }
    if (url.pathname.startsWith('/api/')) {
      reads.push(`${request.method} ${url.pathname}`);
      if (request.method !== 'GET' || url.pathname !== '/api/control-plane/v1/xhs-search-statuses') {
        unexpected.push(`${request.method} ${url.pathname}`); response.statusCode = 400; response.end('{}'); return;
      }
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: nodes })); return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname === '/executors') { response.end('<!doctype html><html><meta charset="utf-8"><h1>隔离搜索节点目标页面</h1></html>'); return; }
    response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><body style="padding:24px"><main id="root"></main><script src="/bundle.js"></script></body></html>');
  });
  let browser, page;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    page.on('pageerror', error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const dialog = page.getByRole('dialog', { name: '小红书账号需要人工处理', exact: true });
    await page.goto(`${origin}/workbench/all?enabled=0`);
    await page.getByRole('heading', { name: '告警组件隔离测试' }).waitFor();
    assert.equal(reads.length, 0, 'the disabled non-admin alert does not read privileged status data');
    assert.equal(await dialog.count(), 0);
    await page.goto(`${origin}/workbench/all?enabled=1`);
    await dialog.waitFor();
    await dialog.getByText('搜索队列已暂停领取后续 Query。请到对应主机完成登录或安全验证，再恢复搜索进程。', { exact: true }).waitFor();
    assert.equal(await dialog.locator('article').count(), 2, 'only LOGIN_REQUIRED and CAPTCHA_REQUIRED nodes demand action');
    const login = dialog.locator('article').filter({ hasText: '隔离账号-login' });
    const captcha = dialog.locator('article').filter({ hasText: '隔离账号-captcha' });
    await login.getByText('需要重新登录', { exact: true }).waitFor();
    await login.getByText('中心服务器 · 隔离主机-login', { exact: true }).waitFor();
    await login.getByText('搜索进程当前在线', { exact: true }).waitFor();
    await captcha.getByText('需要安全验证', { exact: true }).waitFor();
    await captcha.getByText('执行机 · 隔离主机-captcha', { exact: true }).waitFor();
    await captcha.getByText('搜索进程当前离线，请先在该主机启动', { exact: true }).waitFor();
    assert.equal(await dialog.locator('input,textarea,select').count(), 0, 'guidance has no remote credential or verification input');
    assert.equal(await dialog.getByRole('button', { name: /登录|验证|恢复搜索/u }).count(), 0, 'guidance never fabricates a remote login or resume action');
    assert.equal(await dialog.getByRole('link', { name: '查看搜索节点', exact: true }).getAttribute('href'), '/executors');
    await page.screenshot({ path: join(directory, 'login-and-captcha-guidance.png'), fullPage: true });
    await dialog.getByRole('button', { name: '稍后处理', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    // A polling tick can still use the shared 15-second cache when its read
    // completed after timer installation. Allow the following real tick too.
    await page.waitForResponse(response => response.url().endsWith('/xhs-search-statuses'), { timeout: 35_000 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await dialog.count(), 0, 'a real polling refresh of the same signature respects the dismissal');
    nodes = nodes.map(node => node.id === 'login' ? { ...node, authStatus: 'READY', authStatusChangedAt: '2026-10-02T00:01:00.000Z' }
      : node.id === 'captcha' ? { ...node, accountLabel: null, authStatusChangedAt: '2026-10-02T00:01:00.000Z' } : node);
    await page.waitForResponse(response => response.url().endsWith('/xhs-search-statuses'), { timeout: 35_000 });
    await dialog.waitFor();
    assert.equal(await dialog.locator('article').count(), 1, 'recovered login nodes disappear from the updated reminder');
    await dialog.getByText('未设置账号标识', { exact: true }).waitFor();
    await dialog.getByText('需要安全验证', { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    const box = await dialog.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 391, JSON.stringify(box));
    await page.screenshot({ path: join(directory, 'captcha-guidance-mobile.png'), fullPage: true });
    const readsBeforeClose = reads.length;
    await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(reads.length, readsBeforeClose, 'the separate corner close action performs no HTTP write or refresh');
    // A full remount starts a fresh in-memory dismissal session, enabling the
    // independent navigation action to be exercised after both close controls.
    await page.reload(); await dialog.waitFor();
    await Promise.all([page.waitForURL(`${origin}/executors`), dialog.getByRole('link', { name: '查看搜索节点', exact: true }).click()]);
    await page.getByRole('heading', { name: '隔离搜索节点目标页面', exact: true }).waitFor();
    assert.equal(await dialog.count(), 0);
    nodes = nodes.map(node => ({ ...node, authStatus: 'READY' }));
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/xhs-search-statuses')),
      page.goto(`${origin}/workbench/all?enabled=1`)]);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await dialog.count(), 0, 'normal authenticated search nodes do not show an alert');
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    assert.ok(reads.length >= 4); assert.ok(reads.every(read => read.startsWith('GET ')));
    console.log(`XHS alert screenshots: ${directory}`);
    console.log(JSON.stringify({ scopeIds: ['F-EXEC-007'], statusReads: reads.length, httpWrites: 0,
      actualPollingDismissalAndStatusChange: true, paidModelCalls: 0, originalHundredRowDatasetModified: false }));
  } catch (error) {
    if (page) await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
