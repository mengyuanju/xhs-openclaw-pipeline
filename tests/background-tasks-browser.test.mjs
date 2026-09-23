import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_HUMAN_QUALITY_SETTINGS } from '../src/human-quality-settings.mjs';

test('background tasks browser: close, reload, recover planning draft and receive image completion after unmount', {
  skip: process.env.RUN_BACKGROUND_TASK_BROWSER !== '1', timeout: 75_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const root = await mkdtemp(join(tmpdir(), 'background-tasks-browser-'));
  const planId = randomUUID(), editId = randomUUID(), runId = randomUUID();
  const copy = { title: '桌面整理的三个动作', body: '保留常用物品，按使用频率分区整理。'.repeat(27), tags: ['#收纳', '#桌面', '#整理'] };
  const imagePlan = [{ kind: 'hero', headline: '原规划标题', subtitle: '', bullets: ['清理桌面'], prompt: '简洁桌面' }];
  let job = null, edits = [], browser, server;
  const errors = [], requests = [];
  try {
    await build({ stdin: { contents: `
      import './app/globals.css';
      import React,{useState} from 'react';import{createRoot}from'react-dom/client';
      import{ConfirmDialogProvider}from'./components/ui/confirm-dialog';
      import{TextInputDialogProvider}from'./components/ui/text-input-dialog';
      import{Toaster}from'./components/ui/sonner';
      import{BackgroundTasksProvider,BackgroundTaskNotifications}from'./app/components/background-tasks';
      import{TaskReviewDialog}from'./app/workbench/task-review-dialog';
      import{CurrentImageEditor}from'./app/components/current-image-editor';
      function App(){const[taskId,setTaskId]=useState(null),[editor,setEditor]=useState(true);return <>
        <BackgroundTaskNotifications/><button onClick={()=>setTaskId(10)}>打开规划任务</button>
        <button onClick={()=>setEditor(false)}>离开图片工作区</button>
        <TaskReviewDialog taskId={taskId} nodeId="fixture" role="USER" currentUsername="worker" currentAccountId={22} onOpenChange={open=>{if(!open)setTaskId(null)}} onUpdated={async()=>{}}/>
        {editor&&<CurrentImageEditor taskId={11} runId="${runId}" copyRevisionId={1} asset={{id:1,sha256:'a'.repeat(64),url:'/v1/assets/1'}} page={1} runs={[]} onChanged={async()=>{}}/>}
      </>}
      createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><TextInputDialogProvider><BackgroundTasksProvider accountKey="browser-fixture"><App/></BackgroundTasksProvider><Toaster/></TextInputDialogProvider></ConfirmDialogProvider>);
    `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, outfile: join(root, 'bundle.js'), jsx: 'automatic', platform: 'browser', conditions: ['style'], alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"' } });
    const [js, rawCss] = await Promise.all([readFile(join(root, 'bundle.js')), readFile(join(root, 'bundle.css'), 'utf8')]);
    const { default: postcss } = await import('postcss'), { default: tailwind } = await import('@tailwindcss/postcss');
    const { css } = await postcss([tailwind()]).process(rawCss, { from: join(process.cwd(), 'app/globals.css') });
    server = createServer(async (req, res) => {
      if (req.url === '/bundle.js') { res.setHeader('content-type', 'application/javascript'); res.end(js); return; }
      if (req.url === '/bundle.css') { res.setHeader('content-type', 'text/css'); res.end(css); return; }
      if (req.url?.includes('/assets/')) { res.setHeader('content-type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1086" height="1448"><rect width="1086" height="1448" fill="#eee"/></svg>'); return; }
      if (req.url?.startsWith('/api/')) {
        requests.push([req.method, req.url]);
        let body = ''; for await (const chunk of req) body += chunk;
        const data = body ? JSON.parse(body) : null;
        let response;
        if (req.url === '/api/human-quality-settings') response = DEFAULT_HUMAN_QUALITY_SETTINGS;
        else if (req.url.endsWith('/tasks/10')) response = { id: 10, query: '桌面收纳', state: 'COPY_REVIEW_PENDING', assignedToUserId: 'worker', assignedToAccountId: 22, aiDisclosureEnabled: false,
          currentCopyRevisionId: 1, currentImageRunId: null, createdAt: new Date().toISOString(), copyRevisions: [{ id: 1, revision: 1, content: { copy, imagePlan }, approvedAt: null }], imageRuns: [], assets: [], humanQualityAssessments: [] };
        else if (req.url.endsWith('/copy-review-drafts')) {
          if (req.method === 'POST') { res.statusCode = 405; response = null; }
          else response = { baseCopyRevisionId: 1, drafts: [] };
        } else if (req.url.endsWith('/regenerate-image-plan')) {
          job = { id: planId, status: 'QUEUED', copyRevisionId: 1, copy: { body: data.copy.body, tags: data.copy.tags, title: data.copy.title }, result: null };
          response = { created: true, job };
        } else if (req.url.endsWith(`/regenerate-image-plan/${planId}`)) response = job;
        else if (req.url.endsWith('/tasks/11/image-edits')) {
          if (req.method === 'POST') { const edit = { id: editId, target_page: 1, status: 'QUEUED', version: 1, operation: 'SVG_DISCLOSURE', config: data, error: null }; edits = [edit]; response = edit; }
          else response = edits;
        } else if (req.url.endsWith(`/image-edits/${editId}`)) response = edits[0];
        else { res.statusCode = 404; response = null; }
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: response })); return;
      }
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/bundle.css"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true, channel: process.env.IMAGE_EDIT_BROWSER_CHANNEL ?? 'msedge' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button', { name: '打开规划任务', exact: true }).click();
    await page.getByRole('button', { name: '按当前文案重新生成规划', exact: true }).click();
    await page.getByRole('button', { name: '关闭，后台继续处理', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(job.status, 'QUEUED');
    await page.reload();
    await page.getByRole('button', { name: '后台任务，1 项处理中，0 条未读提醒', exact: true }).waitFor();
    job = { ...job, status: 'SUCCEEDED', result: { imagePlan: [{ ...imagePlan[0], headline: '后台完成的新规划' }], model: 'fake' } };
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByRole('button', { name: '后台任务，0 项处理中，1 条未读提醒', exact: true }).waitFor();
    await page.getByRole('button', { name: '打开规划任务', exact: true }).click();
    await page.getByRole('button', { name: '载入新规划', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#review-plan-headline-0')?.value === '后台完成的新规划');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('xhs:background-tasks:v1:browser-fixture')).some(task => task.kind === 'IMAGE_PLAN' && task.consumed));
    assert.equal(requests.some(([method, path]) => method === 'POST' && path.endsWith('/copy-review-drafts')), false,
      'background plan drafts stay in the browser database');
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '打开规划任务', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#review-plan-headline-0')?.value === '后台完成的新规划');
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '修改图片', exact: true }).click();
    await page.getByLabel('人工生成标识文字', { exact: true }).fill('人工生成');
    await page.getByRole('button', { name: '程序叠加（SVG + Sharp）', exact: true }).click();
    await page.getByRole('button', { name: '生成程序标识预览', exact: true }).click();
    await page.getByText('修改请求已提交，可关闭窗口；完成或失败后会在“后台任务”中提醒。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await page.getByRole('button', { name: '离开图片工作区', exact: true }).click();
    edits[0] = { ...edits[0], status: 'PREVIEW_READY' };
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const notifications = page.getByRole('button', { name: '后台任务，0 项处理中，1 条未读提醒', exact: true });
    await notifications.click();
    await page.getByRole('dialog').getByText('图片修复已完成，请打开“修改图片”检查并采用预览。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').getByRole('button', { name: '查看任务' }).count(), 1);
    await page.getByText('已处理记录 · 1', { exact: true }).click();
    assert.equal(await page.getByRole('dialog').getByRole('button', { name: '查看任务' }).count(), 2);
    await page.setViewportSize({ width: 390, height: 844 });
    const box = await page.getByRole('dialog').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390);
    assert.deepEqual(errors, []);
    assert.ok(requests.some(([, url]) => url.endsWith(`/image-edits/${editId}`)));
    assert.equal(requests.filter(([method, url]) => method === 'POST' && url.endsWith('/regenerate-image-plan')).length, 1);
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
