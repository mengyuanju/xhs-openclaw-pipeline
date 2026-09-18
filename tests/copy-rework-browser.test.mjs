import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { DEFAULT_HUMAN_QUALITY_SETTINGS } from '../src/human-quality-settings.mjs';
import { DEFAULT_IMAGE_SETTINGS } from '../server/src/image-options.mjs';

test('browser: returned copy accepts plan-only direct submit and saved plans without another edit', {
  skip: process.env.RUN_COPY_REWORK_BROWSER !== '1', timeout: 90_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const output = resolve('.codex_artifacts/copy-rework');
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, 'browser-'));
  const bundle = join(directory, 'bundle.js');
  await build({ stdin: { contents: `
    import './app/globals.css';
    import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {TaskReviewDialog} from './app/workbench/task-review-dialog';
    import {ConfirmDialogProvider} from './components/ui/confirm-dialog';
    import {TextInputDialogProvider} from './components/ui/text-input-dialog';
    import {BackgroundTasksProvider} from './app/components/background-tasks';
    import {Toaster} from './components/ui/sonner';
    function App() { const [taskId,setTaskId]=useState(1), [message,setMessage]=useState('');
      return <ConfirmDialogProvider><TextInputDialogProvider><BackgroundTasksProvider accountKey="rework-test">
        <output>{message}</output><TaskReviewDialog taskId={taskId} nodeId="test" role="USER"
          currentUsername="worker" currentAccountId={8} embedded
          onOpenChange={open=>{if(!open)setTaskId(null)}}
          onUpdated={(text,completed)=>{setMessage(text);if(completed)setTaskId(null)}}/>
        <Toaster/></BackgroundTasksProvider></TextInputDialogProvider></ConfirmDialogProvider>;
    } createRoot(document.getElementById('root')).render(<App/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, outfile: bundle, jsx: 'automatic',
  platform: 'browser', conditions: ['style'], alias: { '@': process.cwd() },
  define: { 'process.env.NODE_ENV': '"test"', 'process.env': '{}' } });
  const [js, rawCss] = await Promise.all([readFile(bundle), readFile(join(directory, 'bundle.css'), 'utf8')]);
  const { default: postcss } = await import('postcss');
  const { default: tailwind } = await import('@tailwindcss/postcss');
  const { css } = await postcss([tailwind()]).process(rawCss, { from: resolve('app/globals.css') });
  const content = {
    copy: { title: '无需修改的文案标题', body: '先清理不再使用的物品，再按照使用频率划分区域。'.repeat(20), tags: ['#整理', '#收纳', '#桌面'] },
    imagePlan: ['hero', 'steps', 'summary'].map(kind => ({ kind, headline: '原始规划标题', subtitle: '',
      bullets: ['按使用频率分类', '保持桌面整洁'], prompt: '明亮自然光下整洁桌面与收纳区域的画面' })),
    imageSettings: DEFAULT_IMAGE_SETTINGS,
  };
  let task;
  let requests = [];
  let failSubmit = false;
  const reset = origin => {
    requests = [];
    task = { id: 1, query: '返工测试', state: 'COPY_REVIEW_PENDING', mandatoryCopyQc: true,
      mandatoryCopyQcOrigin: origin, assignedToUserId: 'worker', assignedToAccountId: 8,
      currentCopyRevisionId: 101, aiDisclosureEnabled: false, currentImageRunId: null,
      priorityPaused: false, xiaohongshuLinks: [], assets: [], imageRuns: [], executions: [],
      humanQualityAssessments: [], copyRevisions: [{ id: 101, revision: 1, executionId: null,
        revisionOrigin: origin, reworkOrigin: origin, reworkTarget: origin === 'FINAL_REWORK' ? 'COPY' : null,
        copyReworkSatisfied: false, approvedAt: null, content: structuredClone(content) }] };
  };
  reset('QA_RETURN');
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/bundle.js') { res.setHeader('content-type', 'application/javascript'); res.end(js); return; }
      if (req.url === '/bundle.css') { res.setHeader('content-type', 'text/css'); res.end(css); return; }
      if (!req.url.startsWith('/api/')) {
        res.setHeader('content-type', 'text/html');
        res.end('<html><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script src="/bundle.js"></script></html>'); return;
      }
      const path = new URL(req.url, 'http://localhost').pathname;
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : null;
      const reply = data => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data })); };
      if (path === '/api/human-quality-settings') { reply(DEFAULT_HUMAN_QUALITY_SETTINGS); return; }
      if (path.endsWith('/tasks/1')) { reply(task); return; }
      if (path.endsWith('/image-capabilities')) { reply({ version: 1, reviewImagePlanEdits: true }); return; }
      if (path.endsWith('/copy-review-drafts')) {
        reply(req.method === 'POST' ? { id: 1, content: body.content, createdAt: new Date().toISOString() }
          : { baseCopyRevisionId: task.currentCopyRevisionId, drafts: [] }); return;
      }
      if (path.endsWith('/approve-copy')) {
        requests.push(body);
        if (failSubmit) {
          res.statusCode = 503; res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: { code: 'TEST', message: '测试提交失败，请重试' } })); return;
        }
        if (body.edits) {
          task.currentCopyRevisionId += 1;
          task.copyRevisions.unshift({ id: task.currentCopyRevisionId, parentRevisionId: body.revisionId,
            revision: task.copyRevisions.length + 1, revisionOrigin: 'PLAN_EDIT',
            reworkOrigin: task.mandatoryCopyQcOrigin, copyReworkSatisfied: false,
            content: structuredClone(body.edits), approvedAt: null });
        }
        if (body.decision === 'APPROVE') task.state = 'COPY_QC_PENDING';
        reply(task); return;
      }
      res.statusCode = 404; res.end(path);
    } catch (error) { res.statusCode = 500; res.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.COPY_REWORK_BROWSER_CHANNEL || 'msedge' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const url = `http://127.0.0.1:${server.address().port}`;
    const submit = page.getByRole('button', { name: '提交复检并下一条', exact: true });
    for (const origin of ['QA_RETURN', 'FINAL_REWORK']) {
      reset(origin);
      await page.goto(url);
      await page.locator('#review-plan-headline-0').waitFor();
      assert.equal(await submit.isDisabled(), true);
      assert.equal(await page.locator('#review-plan-headline-0').isEditable(), true);
      await page.locator('#review-plan-headline-0').fill('只改规划直接提交');
      failSubmit = true;
      await submit.click();
      await page.getByRole('alert').filter({ hasText: '测试提交失败' }).waitFor();
      assert.equal(await page.locator('#review-plan-headline-0').inputValue(), '只改规划直接提交');
      failSubmit = false;
      await submit.click();
      await page.locator('output').filter({ hasText: '提交强制复检' }).waitFor();
      assert.equal(requests.length, 2);
      assert.ok(requests.every(request => request.decision === 'APPROVE'));
      assert.deepEqual(requests.at(-1).edits.copy, content.copy);
      assert.equal(requests.at(-1).edits.imagePlan[0].headline, '只改规划直接提交');
      assert.equal(requests.at(-1).score, 3);
    }
    reset('QA_RETURN');
    await page.goto(url);
    await page.locator('#review-plan-headline-0').fill('先保存的规划修改');
    await page.getByRole('button', { name: '单独保存图片规划', exact: true }).click();
    await page.locator('output').filter({ hasText: '图片文案规划已单独保存' }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('button')]
      .some(button => button.textContent === '提交复检并下一条' && !button.disabled));
    assert.equal(task.copyRevisions[0].copyReworkSatisfied, false, 'legacy false flags do not erase saved plan changes');
    await page.locator('#review-plan-headline-0').fill('原始规划标题');
    assert.equal(await submit.isDisabled(), true, 'restoring the baseline must disable submit');
    await page.locator('#review-plan-headline-0').fill('先保存的规划修改');
    await submit.click();
    await page.locator('output').filter({ hasText: '提交强制复检' }).waitFor();
    assert.deepEqual(requests.map(request => request.decision), ['SAVE_PLAN', 'APPROVE']);
    assert.equal(requests.at(-1).edits, undefined, 'saved content can be approved without another edit');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
