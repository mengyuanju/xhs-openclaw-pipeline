import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { DEFAULT_HUMAN_QUALITY_SETTINGS } from '../src/human-quality-settings.mjs';

test('frontend filters, review drafts, lazy image opening and shared visible node reads use fake services', {
  skip: process.env.RUN_FRONTEND_REFRESH_BROWSER !== '1', timeout: 120_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const output = resolve('.codex_artifacts/frontend-refresh');
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, 'browser-'));
  await build({
    stdin: { contents: `
      import './app/globals.css';
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {CreationWorkbench} from './app/workbench/creation-workbench';
      import {parseWorkbenchListState} from './app/workbench/list-state';
      import {ExecutorManager} from './app/executors/executor-manager';
      import {XhsAccountAlert} from './app/components/xhs-account-alert';
      import {LazyCurrentImageEditor} from './app/workbench/lazy-current-image-editor';
      import {ConfirmDialogProvider} from './components/ui/confirm-dialog';
      import {TextInputDialogProvider} from './components/ui/text-input-dialog';
      import {Toaster} from './components/ui/sonner';
      window.__fixtureLoadEditor=async load=>{
        if(location.search.includes('fail=1')&&!window.__fixtureFailed){window.__fixtureFailed=true;throw Error('fixture chunk failure')}
        return load();
      };
      const image={id:1,sha256:'fixture',originalName:'image.png',mediaType:'image/png',url:'/v1/assets/1',width:10,height:10};
      const view=location.pathname==='/executors'
        ? <><XhsAccountAlert enabled deferInitialRead/><ExecutorManager initialNodes={[]} initialXhsSearchNodes={[]} xhsSearchMachineTokenConfigured/></>
        : location.pathname==='/image'
          ? <><input aria-label="父窗口图片审核备注"/><LazyCurrentImageEditor taskId={102} runId="fixture-run" copyRevisionId={12} asset={image} page={1} runs={[]} onChanged={async()=>{}}/></>
          : <CreationWorkbench role="ADMIN" nodeId="fixture" creatorUserId="admin" creatorAccountId={1} viewKey="ALL_JOBS"
              initialListState={parseWorkbenchListState(Object.fromEntries(new URLSearchParams(location.search)),{allowAdminFilters:true})}/>;
      createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><TextInputDialogProvider>{view}<Toaster/></TextInputDialogProvider></ConfirmDialogProvider>);
    `, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, outfile: join(directory, 'bundle.js'), jsx: 'automatic', platform: 'browser', conditions: ['style'],
    alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'next-test', setup(plugin) {
      // Only replace the import transport so its rejected promise is reproducible.
      // The retry, mount state and parent form remain the actual component code.
      plugin.onLoad({ filter: /lazy-current-image-editor\.tsx$/ }, async args => ({
        loader: 'tsx', resolveDir: resolve('app/workbench'),
        contents: (await readFile(args.path, 'utf8')).replace(
          "await import('../components/current-image-editor')",
          "await window.__fixtureLoadEditor(() => import('../components/current-image-editor'))",
        ),
      }));
      plugin.onResolve({ filter: /^next\/(navigation|link|dynamic)$/ }, args => ({ path: args.path, namespace: 'next-test' }));
      plugin.onLoad({ filter: /.*/, namespace: 'next-test' }, args => ({ loader: 'jsx', resolveDir: process.cwd(), contents:
        args.path.endsWith('navigation')
          ? `export const usePathname=()=>location.pathname;const router={replace:()=>{throw Error('same-path filters must use native history')},push:path=>location.assign(path),refresh:()=>{}};export const useRouter=()=>router;`
          : args.path.endsWith('dynamic')
            ? `import React,{lazy,Suspense}from'react';export default function dynamic(loader,options={}){const Component=lazy(()=>loader().then(value=>({default:value.default??value})));return props=><Suspense fallback={options.loading?<options.loading/>:null}><Component {...props}/></Suspense>}`
            : `import React from 'react';export default function Link({children,...props}){return <a {...props}>{children}</a>}` }));
    } }],
  });
  const [js, rawCss] = await Promise.all([readFile(join(directory, 'bundle.js')), readFile(join(directory, 'bundle.css'), 'utf8')]);
  const { default: postcss } = await import('postcss');
  const { default: tailwind } = await import('@tailwindcss/postcss');
  const { css } = await postcss([tailwind()]).process(rawCss, { from: resolve('app/globals.css') });
  const tasks = Array.from({ length: 22 }, (_, index) => ({
    id: 101 + index, query: `刷新验证作业 ${index + 1}`, state: index < 2 ? 'COPY_REVIEW_PENDING' : 'COPY_QUEUED',
    currentStage: index < 2 ? 'COPY_REVIEW_PENDING' : 'COPY_QUEUED',
    createdAt: '2026-10-01T08:00:00.000Z', updatedAt: index === 1 ? '2026-10-02T08:00:00.000Z' : '2026-10-01T09:00:00.000Z',
    input: {}, progressPercent: 100, currentCopyRevisionId: index < 2 ? 11 + index : null,
    createdByUserId: 'admin', createdByAccountId: 1, createdByDisplayName: '管理员', createdByRole: 'ADMIN',
    assignedToUserId: 'admin', assignedToAccountId: 1, assignedToDisplayName: '管理员',
  }));
  const reads = [], errors = [], unexpected = [];
  let heldNodeResponse, browser, page;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const reply = data => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data })); };
    if (url.pathname === '/bundle.js') { response.setHeader('content-type', 'application/javascript'); response.end(js); return; }
    if (url.pathname === '/bundle.css') { response.setHeader('content-type', 'text/css'); response.end(css); return; }
    if (!url.pathname.startsWith('/api/')) {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><body style="padding:24px"><main id="root"></main><script src="/bundle.js"></script></body></html>'); return;
    }
    reads.push(`${request.method} ${url.pathname}${url.search}`);
    if (request.method !== 'GET') { unexpected.push(`${request.method} ${url.pathname}`); response.statusCode = 400; response.end('{}'); return; }
    if (url.pathname === '/api/control-plane/health') { reply({ capabilities: { adminTaskFilters: true, adminTaskActivityDateFilters: 1 } }); return; }
    if (url.pathname.endsWith('/human-quality-settings')) { reply(DEFAULT_HUMAN_QUALITY_SETTINGS); return; }
    if (url.pathname.endsWith('/task-views') || url.pathname.endsWith('/executor-statuses') || url.pathname.endsWith('/xhs-search-statuses')) { reply([]); return; }
    if (url.pathname.endsWith('/nodes')) {
      if (!heldNodeResponse) heldNodeResponse = response;
      else { response.statusCode = 503; response.end(JSON.stringify({ error: { code: 'FIXTURE_NODES', message: '节点查询暂时失败' } })); }
      return;
    }
    if (url.pathname === '/api/control-plane/v1/tasks') {
      const from = url.searchParams.get('createdDateFrom'), to = url.searchParams.get('createdDateTo');
      const selected = tasks.filter(task => (!from || task.updatedAt.slice(0, 10) >= from) && (!to || task.updatedAt.slice(0, 10) <= to));
      const limit = Number(url.searchParams.get('limit') || 20), offset = Number(url.searchParams.get('offset') || 0);
      reply({ items: selected.slice(offset, offset + limit), total: selected.length, limit, offset }); return;
    }
    if (/\/tasks\/\d+\/copy-review-drafts$/u.test(url.pathname)) { reply({ baseCopyRevisionId: 12, drafts: [] }); return; }
    if (/\/tasks\/\d+$/u.test(url.pathname)) {
      const task = tasks.find(item => item.id === Number(url.pathname.split('/').at(-1)));
      reply({ ...task, xiaohongshuLinks: [], aiDisclosureEnabled: false, imageReviewedAt: null, imageReviewedByUserId: null,
        currentImageRunId: null, currentExecutionId: null, copyExecutorNodeId: null, executions: [], assets: [], imageRuns: [],
        copyRevisions: [{ id: task.currentCopyRevisionId, revision: 1, executionId: null, approvedAt: null,
          content: { copy: { title: '正式文案标题', body: '测试正文'.repeat(110), tags: ['测试', '文案', '审核'] }, imagePlan: [] } }],
        humanQualityAssessments: [], createdAt: task.createdAt, updatedAt: task.updatedAt }); return;
    }
    if (/\/image-edits\/state$/u.test(url.pathname)) { reply({ status: 'UPLOADED', signature: 'fixture', items: [] }); return; }
    if (/\/image-edits$/u.test(url.pathname)) { reply([]); return; }
    if (url.pathname === '/api/control-plane/v1/assets/1') {
      response.setHeader('content-type', 'image/png');
      response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=', 'base64')); return;
    }
    unexpected.push(`${request.method} ${url.pathname}`); response.statusCode = 404;
    response.end(JSON.stringify({ error: { code: 'UNEXPECTED', message: 'Unexpected fixture request' } }));
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const count = fragment => reads.filter(read => read.includes(fragment)).length;
    const openReview = () => page.getByRole('button', { name: '查看作业 #102：刷新验证作业 2', exact: true }).click();
    await page.goto(`${origin}/workbench/all?createdDateFrom=2026-10-01&createdDateTo=2026-10-02`);
    await page.getByRole('button', { name: '查看作业 #102：刷新验证作业 2', exact: true }).waitFor();
    assert.ok(heldNodeResponse && !heldNodeResponse.writableEnded, 'list renders while node lookup is still pending');
    assert.equal(count('/human-quality-settings'), 0, 'closed review does not load scoring settings');
    assert.equal(count('/tasks/102?'), 0, 'closed review does not load task detail');
    heldNodeResponse.statusCode = 503; heldNodeResponse.end(JSON.stringify({ error: { code: 'FIXTURE_NODES', message: '节点查询暂时失败' } }));
    await page.getByLabel('最近变更日期（起）', { exact: true }).fill('2026-10-02');
    await page.waitForFunction(() => document.querySelectorAll('button.workbench-query-preview').length === 1);
    assert.equal(new URL(page.url()).searchParams.get('createdDateFrom'), '2026-10-02');
    await page.evaluate(() => {
      history.pushState(null, '', '/workbench/all?createdDateFrom=2026-10-01&createdDateTo=2026-10-02&page=2');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.getByRole('button', { name: '查看作业 #121：刷新验证作业 21', exact: true }).waitFor();
    assert.equal(await page.getByLabel('最近变更日期（起）', { exact: true }).inputValue(), '2026-10-01');
    await page.goBack();
    await page.getByRole('button', { name: '查看作业 #102：刷新验证作业 2', exact: true }).waitFor();
    assert.equal(await page.getByLabel('最近变更日期（起）', { exact: true }).inputValue(), '2026-10-02');
    assert.ok(reads.some(read => read.includes('offset=20')), 'native history restores pagination query');

    await openReview();
    const review = page.getByRole('dialog');
    await review.locator('#review-copy-title').waitFor();
    assert.equal(count('/human-quality-settings'), 1);
    await review.locator('input[type="radio"][value="2"]').first().check();
    await review.locator('#review-copy-title').fill('浏览器草稿标题');
    await review.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('heading', { name: '未保存草稿，仍要关闭？', exact: true }).waitFor();
    await page.getByRole('alertdialog').getByRole('button', { name: '继续编辑', exact: true }).click();
    await page.waitForTimeout(1_500);
    await review.getByRole('button', { name: '关闭', exact: true }).click();
    await review.waitFor({ state: 'detached' });
    await openReview();
    await review.locator('#review-copy-title').waitFor();
    assert.equal(await review.locator('#review-copy-title').inputValue(), '浏览器草稿标题', 'lazy unmount and reopen retain indexed draft');
    assert.equal(count('/human-quality-settings'), 1, 'reopening review uses same-session settings cache');
    await page.screenshot({ path: join(directory, 'review-draft-restored.png'), fullPage: true });

    await page.goto(`${origin}/image?fail=1`);
    const imageTrigger = page.getByRole('button', { name: '修改图片', exact: true });
    assert.equal(count('/image-edits/state'), 0, 'editor is not mounted before first click');
    await page.getByLabel('父窗口图片审核备注', { exact: true }).fill('保留未提交图片备注');
    await imageTrigger.focus(); await page.keyboard.press('Enter');
    await page.getByRole('alert').getByText('图片编辑器加载失败。', { exact: false }).waitFor();
    assert.equal(await page.getByLabel('父窗口图片审核备注', { exact: true }).inputValue(), '保留未提交图片备注');
    await page.getByRole('button', { name: '重新加载编辑器', exact: true }).click();
    const imageDialog = page.getByRole('dialog');
    await imageDialog.getByRole('heading', { name: '当前图片修改工作台 · 第 1 页', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('[role="dialog"]') !== null);
    await imageDialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await imageDialog.waitFor({ state: 'detached' });
    await page.waitForFunction(trigger => trigger === document.activeElement, await imageTrigger.elementHandle());
    assert.equal(await imageTrigger.evaluate(element => element === document.activeElement), true, 'closing lazy editor restores keyboard focus');
    assert.equal(await page.getByLabel('父窗口图片审核备注', { exact: true }).inputValue(), '保留未提交图片备注', 'failed import retries locally without losing the parent form');
    await imageTrigger.click();
    await imageDialog.getByRole('heading', { name: '当前图片修改工作台 · 第 1 页', exact: true }).waitFor();
    await imageDialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();

    const executorPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    executorPage.on('pageerror', error => errors.push(error.message));
    await executorPage.clock.install();
    await executorPage.goto(`${origin}/executors`);
    await executorPage.getByRole('heading', { name: '全部执行机', exact: true }).waitFor();
    assert.equal(count('/xhs-search-statuses'), 0, 'authenticated initial node data prevents second hydration read');
    await executorPage.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await executorPage.clock.fastForward(16_000);
    assert.equal(count('/xhs-search-statuses'), 0, 'hidden tabs pause shared search-node polling');
    await executorPage.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await executorPage.waitForResponse(response => response.url().endsWith('/xhs-search-statuses'));
    assert.equal(count('/xhs-search-statuses'), 1, 'global reminder and executor page share one visible read');
    await executorPage.screenshot({ path: join(directory, 'shared-executor-status.png'), fullPage: true });
    assert.deepEqual(unexpected, [], 'fake verification must not perform mutations or model calls');
    assert.deepEqual(errors, []);
    console.log(`Fake frontend browser artifacts: ${directory}`);
  } catch (error) {
    if (page) {
      await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true });
      throw new Error(`${error.message}\nErrors: ${errors.join('; ')}\nUnexpected: ${unexpected.join('; ')}\n${await page.locator('body').innerText()}`, { cause: error });
    }
    throw error;
  } finally {
    heldNodeResponse?.end();
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
