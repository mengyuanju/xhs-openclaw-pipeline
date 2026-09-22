import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('account sampling browser: inherit, zero, restore, old-center gating and responsive editor', {
  skip: process.env.RUN_ACCOUNT_SAMPLING_BROWSER !== '1', timeout: 60000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const root = await mkdtemp(join(tmpdir(), 'account-sampling-browser-'));
  const users = [{ id: 2, username: 'alice', displayName: '标注甲', role: 'USER', status: 'ACTIVE',
    copyReviewEnabled: true, copyQcEnabled: false, imageQcEnabled: false, copySamplingRateBpsOverride: null,
    mustChangePassword: false, version: 1 }];
  const writes = [];
  let browser;
  let server;
  try {
    await build({
      stdin: { contents: `import './app/globals.css'; import React from 'react'; import {createRoot} from 'react-dom/client';
        import {ConfirmDialogProvider} from './components/ui/confirm-dialog'; import {UserManager} from './app/users/user-manager';
        const root = createRoot(document.getElementById('root'));
        async function render() { const fixture = await fetch('/fixture' + location.search).then(r => r.json());
          root.render(<ConfirmDialogProvider><UserManager initialUsers={fixture.users} currentUsername="admin" samplingSettings={fixture.settings}/></ConfirmDialogProvider>); }
        window.addEventListener('fixture-refresh', render); render();`, resolveDir: process.cwd(), loader: 'tsx' },
      bundle: true, outfile: join(root, 'bundle.js'), jsx: 'automatic', platform: 'browser', conditions: ['style'],
      alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"' },
      plugins: [{ name: 'fixture-navigation', setup(builder) {
        builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const useRouter = () => ({ refresh() { window.dispatchEvent(new Event('fixture-refresh')); } });` }));
      } }],
    });
    const [script, css] = await Promise.all([readFile(join(root, 'bundle.js')), readFile(join(root, 'bundle.css'))]);
    server = createServer(async (request, response) => {
      const url = new URL(request.url, 'http://fixture');
      if (url.pathname === '/bundle.js') { response.setHeader('content-type', 'application/javascript'); response.end(script); return; }
      if (url.pathname === '/bundle.css') { response.setHeader('content-type', 'text/css'); response.end(css); return; }
      if (url.pathname === '/fixture') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ users, settings: { supported: url.searchParams.get('old') !== '1', enabled: url.searchParams.get('off') !== '1', rateBps: 2000, version: 1 } })); return;
      }
      if (url.pathname.startsWith('/api/control-plane/v1/users')) {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString()); writes.push(body);
        const user = users[0];
        response.setHeader('content-type', 'application/json');
        if (body.displayName === 'conflict') {
          response.statusCode = 409; response.end(JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: '账号已由其他管理员修改，请刷新' } })); return;
        }
        Object.assign(user, body, { version: user.version + 1 });
        response.end(JSON.stringify({ data: user })); return;
      }
      response.setHeader('content-type', 'text/html');
      response.end('<html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/bundle.css"><style>[data-slot="dialog-content"]{translate:-50% -50%}</style><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(origin);
    await page.getByText('继承 · 20%', { exact: true }).waitFor();
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('文案抽检比例', { exact: true }).click();
    await page.getByRole('option', { name: '单独配置', exact: true }).click();
    await dialog.getByLabel('单独配置比例（%）').fill('0');
    await dialog.getByText('0% 仍会在结批或等待超时后对非空尾批保底抽 1 条。').waitFor();
    await dialog.getByRole('button', { name: '保存修改' }).click();
    await page.getByText('单独 · 0%（尾批保底）', { exact: true }).waitFor();
    assert.equal(writes.at(-1).copySamplingRateBpsOverride, 0);
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await dialog.getByLabel('文案抽检比例', { exact: true }).click();
    await page.getByRole('option', { name: /继承生产配置/u }).click();
    await dialog.getByRole('button', { name: '保存修改' }).click();
    await page.getByText('继承 · 20%', { exact: true }).waitFor();
    assert.equal(writes.at(-1).copySamplingRateBpsOverride, null);

    await page.goto(`${origin}/?off=1`);
    await page.getByText('继承 · 20% · 暂不生效', { exact: true }).waitFor();
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await dialog.getByText('普通文案抽检当前全局关闭，账号配置会保留并在重新开启后生效。').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= 391, JSON.stringify(bounds));
    await dialog.getByLabel('姓名', { exact: true }).fill('conflict');
    await dialog.getByRole('button', { name: '保存修改' }).click();
    await dialog.getByRole('alert').filter({ hasText: 'VERSION_CONFLICT' }).waitFor();
    assert.equal(await dialog.isVisible(), true);
    if (process.env.ACCOUNT_SAMPLING_SCREENSHOT) await page.screenshot({ path: process.env.ACCOUNT_SAMPLING_SCREENSHOT, fullPage: true });
    await page.goto(`${origin}/?old=1`);
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await dialog.getByText('中心服务尚未支持账号级比例，请先升级中心服务。').waitFor();
    assert.equal(await dialog.getByRole('spinbutton').count(), 0);
    await dialog.getByRole('button', { name: '保存修改' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(Object.hasOwn(writes.at(-1), 'copySamplingRateBpsOverride'), false);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/'));
    await rm(root, { recursive: true, force: true });
  }
});
