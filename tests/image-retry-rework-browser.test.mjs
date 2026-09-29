import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_HUMAN_QUALITY_SETTINGS } from '../src/human-quality-settings.mjs';
import { DEFAULT_IMAGE_SETTINGS } from '../server/src/image-options.mjs';

test('image exhaustion requires a fresh edit even after a previously completed copy rework', {
  skip: process.env.RUN_IMAGE_RETRY_REWORK_BROWSER !== '1', timeout: 120_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const directory = await mkdtemp(join(tmpdir(), 'image-retry-rework-browser-'));
  let browser;
  let server;
  try {
    await build({ stdin: { contents: `
      import './app/globals.css';
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {TaskReviewDialog} from './app/workbench/task-review-dialog';
      import {ConfirmDialogProvider} from './components/ui/confirm-dialog';
      import {TextInputDialogProvider} from './components/ui/text-input-dialog';
      createRoot(document.getElementById('root')).render(
        <ConfirmDialogProvider><TextInputDialogProvider>
          <TaskReviewDialog taskId={657} nodeId="fixture" role="USER" currentUsername="worker"
            currentAccountId={8} embedded onOpenChange={()=>{}} onUpdated={async()=>{}}/>
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

    const copy = { title: '已通过复检的标题',
      body: '按使用频率分类物品，将常用物品放在手边并保留整洁空间。'.repeat(20),
      tags: ['#整理', '#桌面', '#收纳'] };
    const imagePlan = ['hero', 'steps', 'summary'].map((kind, index) => ({
      kind, headline: `已审核规划第 ${index + 1} 页`, subtitle: '', bullets: ['分类整理', '留出空间'],
      prompt: '整洁桌面和自然光，画面保持清晰明亮', layout: { mode: 'AUTO' },
    }));
    const content = { copy, imagePlan, imageSettings: DEFAULT_IMAGE_SETTINGS };
    let origin = 'IMAGE_RETRY_REVIEW';
    const task = () => ({ id: 657, query: '桌面整理', state: 'COPY_REVIEW_PENDING',
      currentStage: origin === 'IMAGE_RETRY_REVIEW' ? 'IMAGE_RETRY_EXHAUSTED' : 'COPY_REVIEW_PENDING',
      mandatoryCopyQc: true, mandatoryCopyQcOrigin: origin, aiDisclosureEnabled: false,
      assignedToUserId: 'worker', assignedToAccountId: 8,
      currentCopyRevisionId: 2951, currentImageRunId: null, currentExecutionId: null,
      copyRevisions: [
        { id: 2946, revision: 1, revisionOrigin: origin === 'FINAL_REWORK' ? 'FINAL_REWORK' : 'QA_RETURN',
          parentRevisionId: null, executionId: null, approvedAt: null,
          content: { ...structuredClone(content), copy: { ...copy, title: '较早返工前的标题' } } },
        { id: 2950, revision: 2, revisionOrigin: 'PLAN_EDIT', parentRevisionId: 2946,
          executionId: null, approvedAt: '2026-09-28T00:00:00Z', content: structuredClone(content) },
        { id: 2951, revision: 3, revisionOrigin: 'COPY_EDIT', parentRevisionId: 2950,
          executionId: null, approvedAt: '2026-09-28T00:00:00Z', copyReworkSatisfied: true,
          content: structuredClone(content) },
      ], imageRuns: [], assets: [], humanQualityAssessments: [] });
    const submissions = [];
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
      const reply = (data, status = 200) => {
        res.statusCode = status; res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(status >= 400 ? { error: { code: 'TEST_ERROR', message: data } } : { data }));
      };
      if (path === '/api/human-quality-settings') { reply(DEFAULT_HUMAN_QUALITY_SETTINGS); return; }
      if (path.endsWith('/tasks/657')) { reply(task()); return; }
      if (path.endsWith('/copy-review-drafts')) { reply({ baseCopyRevisionId: 2951, drafts: [] }); return; }
      if (path.endsWith('/image-capabilities')) { reply({ version: 1, reviewImagePlanEdits: true }); return; }
      if (path.endsWith('/approve-copy')) {
        submissions.push(body); reply({ state: 'COPY_QC_PENDING' }); return;
      }
      reply(`Unexpected API: ${req.method} ${path}`, 404);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true,
      channel: process.env.IMAGE_RETRY_REWORK_BROWSER_CHANNEL || 'msedge' });
    const errors = [];
    const open = async () => {
      const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base);
      await page.locator('#review-copy-title').waitFor();
      return { context, page };
    };

    const { context, page } = await open();
    const submit = page.getByRole('button', { name: '提交修订并下一条', exact: true });
    await page.locator('.workbench-review-action-hint').filter({
      hasText: '请先按返工原因实际修改文案或图片规划',
    }).waitFor();
    assert.equal(await submit.isDisabled(), true, 'old QA_RETURN edits cannot satisfy image-failure rework');
    assert.equal(submissions.length, 0);
    await page.locator('#review-copy-title').fill('本次修正后的标题');
    assert.equal(await submit.isEnabled(), true, 'a new copy edit enables mandatory recheck');
    await page.locator('#review-copy-title').fill(copy.title);
    assert.equal(await submit.isDisabled(), true);
    await page.locator('#review-plan-headline-0').fill('本次修正后的图片规划');
    assert.equal(await submit.isEnabled(), true, 'a new plan edit enables mandatory recheck');
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/approve-copy')),
      submit.click(),
    ]);
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].revisionId, 2951);
    assert.equal(submissions[0].decision, 'APPROVE');
    assert.equal(submissions[0].score, 3);
    assert.equal(submissions[0].edits.copy.title, copy.title);
    assert.equal(submissions[0].edits.imagePlan[0].headline, '本次修正后的图片规划');
    await context.close();

    for (origin of ['QA_RETURN', 'FINAL_REWORK']) {
      const ordinary = await open();
      assert.equal(await ordinary.page.getByRole('button', { name: '提交复检并下一条', exact: true }).isEnabled(), true,
        `${origin} retains the original return baseline for saved rework`);
      await ordinary.context.close();
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    assert.ok(directory.startsWith(join(tmpdir(), 'image-retry-rework-browser-')));
    await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});
