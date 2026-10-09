import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_HUMAN_QUALITY_SETTINGS } from '../src/human-quality-settings.mjs';
import { DEFAULT_IMAGE_SETTINGS } from '../server/src/image-options.mjs';

test('browser: image plan comparison identifies changes and blocks over-limit bullets until corrected', {
  skip: process.env.RUN_IMAGE_PLAN_REVIEW_BROWSER !== '1', timeout: 120_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const directory = await mkdtemp(join(tmpdir(), 'image-plan-review-browser-'));
  let browser;
  let server;
  try {
    await build({ stdin: { contents: `
      import './app/globals.css';
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {TaskReviewDialog} from './app/workbench/task-review-dialog';
      import {ConfirmDialogProvider} from './components/ui/confirm-dialog';
      import {TextInputDialogProvider} from './components/ui/text-input-dialog';
      import {BackgroundTasksProvider} from './app/components/background-tasks';
      import {Toaster} from './components/ui/sonner';
      createRoot(document.getElementById('root')).render(
        <ConfirmDialogProvider><TextInputDialogProvider>
          <BackgroundTasksProvider accountKey="image-plan-review-test" accountUsername="worker" accountId={8}>
            <TaskReviewDialog taskId={41} nodeId="fixture" role="USER" currentUsername="worker"
              currentAccountId={8} embedded onOpenChange={()=>{}} onUpdated={async()=>{}}/>
            <Toaster/>
          </BackgroundTasksProvider>
        </TextInputDialogProvider></ConfirmDialogProvider>);
    `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true,
    outfile: join(directory, 'bundle.js'), jsx: 'automatic', platform: 'browser', conditions: ['style'],
    alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"', 'process.env': '{}' } });
    const [js, rawCss] = await Promise.all([
      readFile(join(directory, 'bundle.js')),
      readFile(join(directory, 'bundle.css'), 'utf8'),
    ]);
    const { default: postcss } = await import('postcss');
    const { default: tailwind } = await import('@tailwindcss/postcss');
    const { css } = await postcss([tailwind()]).process(rawCss, { from: join(process.cwd(), 'app/globals.css') });

    const originalPlan = ['hero', 'steps', 'summary'].map((kind, index) => ({
      kind, headline: `正式规划第 ${index + 1} 页`, subtitle: '',
      bullets: ['分类整理', '留出空间', '检查结果'],
      prompt: `整洁桌面与第 ${index + 1} 页收纳区域，自然光和清晰文字`,
      layout: { mode: 'AUTO' },
    }));
    const copy = { title: '桌面整理步骤', body: '根据使用频率分类物品，保持桌面整洁。'.repeat(20), tags: ['#整理', '#桌面'] };
    const requests = [];
    let task;
    const resetTask = () => {
      task = { id: 41, query: '桌面整理', state: 'COPY_REVIEW_PENDING', aiDisclosureEnabled: false,
        assignedToUserId: 'worker', assignedToAccountId: 8,
        currentCopyRevisionId: 101, currentImageRunId: null, copyRevisions: [{ id: 101, revision: 1,
          approvedAt: null, content: { copy: structuredClone(copy), imagePlan: structuredClone(originalPlan),
            imageSettings: DEFAULT_IMAGE_SETTINGS } }],
        imageRuns: [], assets: [], humanQualityAssessments: [] };
    };
    resetTask();
    server = createServer(async (req, res) => {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/bundle.js') { res.setHeader('content-type', 'application/javascript'); res.end(js); return; }
      if (path === '/bundle.css') { res.setHeader('content-type', 'text/css'); res.end(css); return; }
      if (!path.startsWith('/api/')) {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end('<!doctype html><html lang="zh-CN"><link rel="stylesheet" href="/bundle.css"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
        return;
      }
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method, path, body });
      const reply = (data, status = 200) => {
        res.statusCode = status; res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(status >= 400 ? { error: { code: 'TEST_ERROR', message: data } } : { data }));
      };
      if (path === '/api/human-quality-settings') { reply(DEFAULT_HUMAN_QUALITY_SETTINGS); return; }
      if (path.endsWith('/tasks/41')) { reply(task); return; }
      if (path.endsWith('/image-capabilities')) { reply({ version: 1, reviewImagePlanEdits: true }); return; }
      if (path.endsWith('/copy-review-drafts')) { reply({ baseCopyRevisionId: task.currentCopyRevisionId, drafts: [] }); return; }
      if (path.endsWith('/approve-copy')) {
        if (body.decision === 'SAVE_PLAN') {
          const current = task.copyRevisions.find(revision => revision.id === task.currentCopyRevisionId);
          const saved = structuredClone(current);
          saved.id += 1; saved.revision += 1;
          saved.content.imagePlan = body.edits.imagePlan;
          task.copyRevisions.push(saved);
          task.currentCopyRevisionId = saved.id;
          reply(task); return;
        }
        if (body.decision !== 'APPROVE' || body.edits) { reply('Only unchanged copy approval is expected', 400); return; }
        task.state = 'COPY_QC_PENDING'; reply(task); return;
      }
      reply(`Unexpected API: ${req.method} ${path}`, 404);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, channel: process.env.IMAGE_PLAN_REVIEW_BROWSER_CHANNEL || 'msedge' });
    const errors = [];
    const newPage = async () => {
      const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base);
      await page.locator('#review-copy-title').waitFor();
      await page.locator('input[type="radio"][value="3"]').check();
      return { context, page };
    };
    const submitButton = page => page.getByRole('button', { name: '提交并下一条', exact: true });
    const waitReady = async page => {
      await page.waitForFunction(() => [...document.querySelectorAll('button')]
        .some(button => button.textContent?.includes('提交并下一条') && !button.disabled));
    };

    // An input edit can change raw JSON while leaving the saved plan's effective content unchanged.
    {
      const { context, page } = await newPage();
      await page.locator('#review-plan-headline-0').fill('正式规划第 1 页  ');
      await page.getByRole('status').filter({ hasText: '仅有空格或数据格式差异，无需单独保存' }).waitFor();
      assert.equal(await page.getByRole('button', { name: '单独保存图片规划', exact: true }).count(), 0);
      await waitReady(page);
      await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/approve-copy')),
        submitButton(page).click(),
      ]);
      assert.equal(task.state, 'COPY_QC_PENDING');
      assert.ok(requests.some(request => request.path.endsWith('/approve-copy') && request.body?.decision === 'APPROVE'));
      assert.equal(requests.some(request => request.path.endsWith('/approve-copy') && request.body?.decision === 'SAVE_PLAN'), false);
      await context.close();
    }

    // A substantive difference names its page and line, and the link reveals and selects that line.
    resetTask();
    {
      const { context, page } = await newPage();
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await page.locator('#review-plan-bullets-1').fill('分类整理\n留出空间\n复查结果');
      await page.getByRole('button', { name: '上一页', exact: true }).click();
      await waitReady(page);
      await submitButton(page).click();
      await page.getByRole('alert').filter({ hasText: '图片文案规划有 1 处未保存修改' }).waitFor();
      const difference = page.getByRole('list', { name: '未保存的图片规划差异' })
        .getByRole('button', { name: '第 2 页画面要点第 3 行与正式版本不同', exact: true });
      await difference.click();
      await page.getByText('第 2 / 3 页', { exact: true }).waitFor();
      await page.waitForFunction(() => document.activeElement?.id === 'review-plan-bullets-1');
      assert.equal(await page.locator('#review-plan-bullets-1').evaluate(element =>
        element.value.slice(element.selectionStart, element.selectionEnd)), '复查结果');
      await page.setViewportSize({ width: 390, height: 780 });
      await page.locator('.workbench-review-pane-switch').getByRole('button', { name: '文案', exact: true }).click();
      assert.equal(await page.locator('#review-plan-pane .workbench-image-plan-section').isVisible(), false);
      assert.equal(await page.locator('#review-plan-pane .workbench-copy-original-rating textarea').isVisible(), true,
        'the copy tab keeps the compact score explanation available');
      await difference.click();
      await page.locator('#review-plan-pane .workbench-image-plan-section').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.activeElement?.id === 'review-plan-bullets-1');
      assert.equal(await page.locator('#review-plan-bullets-1').evaluate(element =>
        element.value.slice(element.selectionStart, element.selectionEnd)), '复查结果');
      assert.equal(requests.filter(request => request.path.endsWith('/approve-copy')).length, 1,
        'the differing draft did not submit another request');
      await context.close();
    }

    // The save path reports a concrete invalid line before any server request.
    resetTask();
    {
      const { context, page } = await newPage();
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await page.locator('#review-plan-bullets-1').fill('分类整理\n留出空间\n  ');
      await page.getByRole('button', { name: '上一页', exact: true }).click();
      await page.getByRole('button', { name: '单独保存图片规划', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: '第 2 页画面要点第 3 行为空' }).waitFor();
      await page.getByText('第 2 / 3 页', { exact: true }).waitFor();
      await page.waitForFunction(() => document.activeElement?.id === 'review-plan-bullets-1');
      assert.equal(requests.filter(request => request.path.endsWith('/approve-copy')).length, 1,
        'invalid plan was rejected in the browser');
      await context.close();
    }
    // Every visible layout field changes the actual saved image plan.
    resetTask();
    {
      const { context, page } = await newPage();
      assert.equal(await page.locator('#review-plan-kind-0').isDisabled(), true, 'cover page type is fixed');
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await page.locator('#review-plan-kind-1').click();
      const kinds = await page.getByRole('option').allTextContents();
      assert.ok(kinds.length >= 3);
      await page.getByRole('option').last().click();
      await page.getByRole('button', { name: '画面生成指令', exact: true }).click();
      await page.locator('#review-plan-prompt-1').fill('具体画面生成指令：保留清晰文字与整理后的桌面。');
      await page.getByRole('button', { name: /^页面排版/ }).click();
      await page.locator('#review-plan-layout-mode-1').click();
      await page.getByRole('option', { name: '自定义排版', exact: true }).click();
      const choices = { '标题位置': '底部', '主体位置': '右侧', '文字区域': '左侧', '文字对齐': '居中', '留白': '宽松' };
      for (const [label, name] of Object.entries(choices)) {
        await page.getByRole('combobox', { name: label, exact: true }).click();
        await page.getByRole('option', { name, exact: true }).click();
        assert.equal(await page.getByRole('combobox', { name: label, exact: true }).textContent(), name);
      }
      const share = page.getByRole('slider', { name: /主体占比/ });
      await share.focus(); await page.keyboard.press('Home'); assert.equal(await share.inputValue(), '20');
      await page.keyboard.press('End'); assert.equal(await share.inputValue(), '90');
      await page.getByLabel('补充布局要求', { exact: true }).fill('主体靠右，左侧留给文字。');
      const schematic = page.getByLabel('布局意图示意，非成品预览', { exact: true });
      assert.equal(await schematic.getAttribute('data-subject'), 'right');
      assert.equal(await schematic.getAttribute('data-title'), 'bottom');
      const savedPlan = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/approve-copy'));
      await page.getByRole('button', { name: '单独保存图片规划', exact: true }).click();
      assert.equal((await savedPlan).status(), 200);
      const saved = requests.findLast(request => request.body?.decision === 'SAVE_PLAN').body.edits.imagePlan[1];
      assert.equal(saved.prompt, '具体画面生成指令：保留清晰文字与整理后的桌面。');
      assert.equal(saved.layout.mode, 'CUSTOM'); assert.equal(saved.layout.imageShare, 90);
      assert.equal(saved.layout.direction, '主体靠右，左侧留给文字。');
      assert.equal(saved.layout.subjectPosition, 'right'); assert.equal(saved.layout.alignment, 'center');
      await page.locator('#review-plan-layout-mode-1').click();
      await page.getByRole('option', { name: '自动匹配版式', exact: true }).click();
      assert.equal(await page.getByLabel('补充布局要求', { exact: true }).count(), 0);
      await context.close();
    }

    // Existing over-limit plans cannot be approved, and edits cannot bypass either page-type limit.
    for (const { kind, limit } of [{ kind: 'steps', limit: 30 }, { kind: 'checklist', limit: 40 }]) {
      resetTask();
      const initialOverflow = '字'.repeat(limit + 1);
      task.copyRevisions[0].content.imagePlan[1].kind = kind;
      task.copyRevisions[0].content.imagePlan[1].bullets[2] = initialOverflow;
      const requestCount = requests.filter(request => request.path.endsWith('/approve-copy')).length;
      const { context, page } = await newPage();
      const bullets = page.locator('#review-plan-bullets-1');
      const assertRejected = async (length, selectedText) => {
        const alert = page.getByRole('alert').filter({ hasText: '第 2 页' }).filter({ hasText: `${length} 字` });
        await alert.waitFor();
        const message = await alert.textContent();
        assert.match(message, /第 3 (?:条|行)/u);
        assert.ok(message.includes(`${length} 字`), 'the error reports the actual bullet length');
        assert.ok(message.includes(`${limit} 字`), 'the error reports the applicable page-type limit');
        await page.getByText('第 2 / 3 页', { exact: true }).waitFor();
        await page.waitForFunction(() => document.activeElement?.id === 'review-plan-bullets-1');
        assert.equal(await bullets.getAttribute('aria-invalid'), 'true');
        assert.equal(await bullets.evaluate(element =>
          element.value.slice(element.selectionStart, element.selectionEnd)), selectedText);
        assert.match(await page.locator('#review-plan-bullets-help-1').textContent(), /不能保存或提交/u);
        assert.equal(await page.getByRole('button', { name: '确认超长并继续', exact: true }).count(), 0);
        assert.equal(requests.filter(request => request.path.endsWith('/approve-copy')).length, requestCount,
          'over-limit plans never send an approval or plan-save request');
      };

      await waitReady(page);
      await submitButton(page).click();
      await assertRejected(limit + 1, initialOverflow);
      assert.equal(task.state, 'COPY_REVIEW_PENDING');
      assert.equal(await bullets.inputValue(), `分类整理\n留出空间\n${initialOverflow}`,
        'approval rejects the existing plan before any edits');
      assert.equal(task.currentCopyRevisionId, 101);

      const editedOverflow = '字'.repeat(limit + 2);
      await bullets.fill(`分类整理\n留出空间\n${editedOverflow}`);
      await page.getByRole('button', { name: '上一页', exact: true }).click();
      await page.getByRole('button', { name: '单独保存图片规划', exact: true }).click();
      await assertRejected(limit + 2, editedOverflow);

      const correctedBullet = '字'.repeat(limit);
      await bullets.fill(`分类整理\n留出空间\n${correctedBullet}`);
      assert.equal(await bullets.getAttribute('aria-invalid'), 'false');
      assert.doesNotMatch(await page.locator('#review-plan-bullets-help-1').textContent(), /不能保存或提交/u);
      const savedPlan = page.waitForResponse(response => response.request().method() === 'POST'
        && response.url().endsWith('/approve-copy'));
      await page.getByRole('button', { name: '单独保存图片规划', exact: true }).click();
      assert.equal((await savedPlan).status(), 200);
      await waitReady(page);
      assert.equal(task.currentCopyRevisionId, 102);
      assert.equal(task.copyRevisions.at(-1).content.imagePlan[1].bullets[2], correctedBullet);
      assert.equal(await page.getByRole('button', { name: '单独保存图片规划', exact: true }).count(), 0);
      await Promise.all([
        page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/approve-copy')),
        submitButton(page).click(),
      ]);
      assert.equal(task.state, 'COPY_QC_PENDING');
      const newRequests = requests.filter(request => request.path.endsWith('/approve-copy')).slice(requestCount);
      assert.deepEqual(newRequests.map(request => request.body.decision), ['SAVE_PLAN', 'APPROVE']);
      assert.equal(newRequests[0].body.imagePlanBulletOverflowConfirmed, undefined);
      assert.equal(newRequests[1].body.revisionId, 102);
      await context.close();
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    assert.ok(directory.startsWith(join(tmpdir(), 'image-plan-review-browser-')));
    await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});
