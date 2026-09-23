import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_HUMAN_QUALITY_SETTINGS } from '../src/human-quality-settings.mjs';
import { DEFAULT_IMAGE_SETTINGS } from '../server/src/image-options.mjs';

test('copy review drafts use IndexedDB across reloads, account and revision scopes, and legacy import', {
  skip: process.env.RUN_COPY_REVIEW_DRAFT_BROWSER !== '1', timeout: 120_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const root = await mkdtemp(join(tmpdir(), 'copy-review-drafts-browser-'));
  let browser;
  let server;
  try {
    await build({ stdin: { contents: `
      import './app/globals.css';
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {TaskReviewDialog} from './app/workbench/task-review-dialog';
      import {ConfirmDialogProvider} from './components/ui/confirm-dialog';
      import {TextInputDialogProvider} from './components/ui/text-input-dialog';
      import {BackgroundTasksProvider} from './app/components/background-tasks';
      import {Toaster} from './components/ui/sonner';
      const accountId=Number(new URLSearchParams(location.search).get('account')||7);
      createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><TextInputDialogProvider>
        <BackgroundTasksProvider accountKey={'draft-browser-'+accountId}>
          <TaskReviewDialog taskId={41} nodeId="fixture" role="USER" currentUsername="reviewer"
            currentAccountId={accountId} embedded onOpenChange={()=>{}} onUpdated={async()=>{}}/>
          <Toaster/>
        </BackgroundTasksProvider>
      </TextInputDialogProvider></ConfirmDialogProvider>);
    `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true,
    outfile: join(root, 'bundle.js'), jsx: 'automatic', platform: 'browser', conditions: ['style'],
    alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"', 'process.env': '{}' } });
    const [js, rawCss] = await Promise.all([
      readFile(join(root, 'bundle.js')),
      readFile(join(root, 'bundle.css'), 'utf8'),
    ]);
    const { default: postcss } = await import('postcss');
    const { default: tailwind } = await import('@tailwindcss/postcss');
    const { css } = await postcss([tailwind()]).process(rawCss, { from: join(process.cwd(), 'app/globals.css') });

    const plan = ['hero', 'steps', 'summary'].map((kind, index) => ({
      kind, headline: `正式规划第 ${index + 1} 页`, subtitle: '', bullets: ['分类', '整理'], prompt: '整洁桌面和自然光',
    }));
    const revision = (id, title) => ({ id, revision: id - 11, approvedAt: null,
      content: { copy: { title, body: '按使用频率整理桌面，将常用物品放在手边。'.repeat(15), tags: ['#收纳', '#桌面'] },
        imagePlan: structuredClone(plan), imageSettings: DEFAULT_IMAGE_SETTINGS } });
    const revisions = new Map([[12, revision(12, '正式文案 A')], [13, revision(13, '正式文案 B')]]);
    let accountId = 7;
    let revisionId = 12;
    let legacyDrafts = [];
    let savedAssessment = null;
    const requests = [];
    const task = () => ({ id: 41, query: '桌面整理', state: 'COPY_REVIEW_PENDING',
      assignedToUserId: 'reviewer', assignedToAccountId: accountId, currentCopyRevisionId: revisionId,
      aiDisclosureEnabled: false, currentImageRunId: null, copyRevisions: [revisions.get(revisionId)],
      imageRuns: [], assets: [], humanQualityAssessments: savedAssessment ? [savedAssessment] : [] });
    const legacyRecord = (title) => ({ id: 501, taskId: 41, baseCopyRevisionId: 12,
      reviewerAccountId: 7, reviewerUsername: 'reviewer', version: 1,
      createdAt: new Date().toISOString(), content: { version: 1,
        draft: { ...structuredClone(revisions.get(12).content), copy: { ...revisions.get(12).content.copy, title } },
        aiDisclosureEnabled: false, copyOriginalScore: 2.5, copyOriginalReasons: [], copyOriginalNote: '旧服务器草稿' } });
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
      const reply = (data, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(status >= 400 ? { error: { code: 'TEST_ERROR', message: data } } : { data })); };
      if (path === '/api/human-quality-settings') { reply(DEFAULT_HUMAN_QUALITY_SETTINGS); return; }
      if (path.endsWith('/tasks/41')) { reply(task()); return; }
      if (path.endsWith('/image-capabilities')) { reply({ version: 1, reviewImagePlanEdits: true }); return; }
      if (path.endsWith('/copy-review-drafts')) {
        if (req.method === 'POST') { reply('浏览器草稿不应写入服务器', 405); return; }
        reply({ baseCopyRevisionId: revisionId, drafts: legacyDrafts }); return;
      }
      if (path.endsWith('/approve-copy') && body?.decision === 'SAVE_PLAN') {
        const next = Math.max(...revisions.keys()) + 1;
        revisions.set(next, { ...revision(next, revisions.get(revisionId).content.copy.title),
          content: structuredClone(body.edits) });
        revisionId = next;
        reply(task()); return;
      }
      if (path.endsWith('/approve-copy') && body?.decision === 'SAVE') {
        if (body.edits || body.revisionId !== revisionId) {
          reply('本场景只允许保存当前修订版的评分', 400); return;
        }
        savedAssessment = { id: 801, taskId: 41, stage: 'COPY', copyRevisionId: revisionId,
          imageRunId: null, score: body.score, scoreX10: 25, ratingContext: 'ORIGINAL', action: 'SAVE',
          reasonCodes: body.reasons, problemAssetIds: [], note: body.note,
          reviewerUsername: 'reviewer', reviewSessionId: body.reviewSessionId, createdAt: new Date().toISOString() };
        reply(task()); return;
      }
      reply(`Unexpected API: ${req.method} ${path}`, 404);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, channel: process.env.COPY_REVIEW_DRAFT_BROWSER_CHANNEL || 'msedge' });
    const errors = [];
    const makePage = async (context, account = 7) => {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/?account=${account}`);
      await page.locator('#review-copy-title').waitFor();
      return page;
    };
    const waitSaved = page => page.waitForFunction(() => [...document.querySelectorAll('small')]
      .some(item => item.textContent?.startsWith('已保存')));
    const waitAutosaved = async page => {
      await page.waitForFunction(() => [...document.querySelectorAll('small')]
        .some(item => item.textContent?.includes('等待自动保存') || item.textContent?.includes('正在保存')));
      await waitSaved(page);
    };

    // The same origin and browser profile survive reload, while account and revision keys remain isolated.
    const context = await browser.newContext();
    const page = await makePage(context);
    await page.locator('input[type="radio"][value="2.5"]').check();
    await page.locator('#review-copy-title').fill('只保存在本机的文案');
    await waitAutosaved(page);
    await page.reload();
    await page.locator('#review-copy-title').waitFor();
    assert.equal(await page.locator('#review-copy-title').inputValue(), '只保存在本机的文案');
    assert.equal(requests.some(item => item.method === 'POST' && item.path.endsWith('/copy-review-drafts')), false);

    accountId = 8;
    await page.goto(`${base}/?account=8`);
    await page.locator('#review-copy-title').waitFor();
    assert.equal(await page.locator('#review-copy-title').inputValue(), '正式文案 A');
    revisionId = 13;
    await page.reload();
    await page.locator('#review-copy-title').waitFor();
    assert.equal(await page.locator('#review-copy-title').inputValue(), '正式文案 B');
    accountId = 7; revisionId = 12;
    await page.goto(`${base}/?account=7`);
    await page.locator('#review-copy-title').waitFor();
    assert.equal(await page.locator('#review-copy-title').inputValue(), '只保存在本机的文案');
    await context.close();

    // Existing server drafts are imported once for a new browser profile and remain usable offline.
    legacyDrafts = [legacyRecord('迁移来的旧草稿')];
    const migratedContext = await browser.newContext();
    const migratedPage = await makePage(migratedContext);
    assert.equal(await migratedPage.locator('#review-copy-title').inputValue(), '迁移来的旧草稿');
    const legacyGetCount = requests.filter(item => item.method === 'GET' && item.path.endsWith('/copy-review-drafts')).length;
    legacyDrafts = [];
    await migratedPage.reload();
    await migratedPage.locator('#review-copy-title').waitFor();
    assert.equal(await migratedPage.locator('#review-copy-title').inputValue(), '迁移来的旧草稿');
    assert.equal(requests.filter(item => item.method === 'GET' && item.path.endsWith('/copy-review-drafts')).length,
      legacyGetCount, 'completed legacy import does not repeatedly query the server');
    await migratedPage.locator('#review-copy-title').fill('迁移后本机继续编辑');
    await waitAutosaved(migratedPage);
    legacyDrafts = [legacyRecord('过期的旧服务器草稿')];
    await migratedPage.reload();
    await migratedPage.locator('#review-copy-title').waitFor();
    assert.equal(await migratedPage.locator('#review-copy-title').inputValue(), '迁移后本机继续编辑');
    await migratedContext.close();

    // A stale tab cannot overwrite a newer draft from another tab in the same browser profile.
    const conflictContext = await browser.newContext();
    const firstTab = await makePage(conflictContext);
    await firstTab.locator('input[type="radio"][value="2.5"]').check();
    await firstTab.locator('#review-copy-title').fill('第一个窗口初稿');
    await waitAutosaved(firstTab);
    const staleTab = await makePage(conflictContext);
    await firstTab.locator('#review-copy-title').fill('第一个窗口更新稿');
    await waitAutosaved(firstTab);
    await staleTab.getByText('审核草稿', { exact: true }).click();
    await staleTab.locator('#review-copy-title').fill('第二个窗口过期稿');
    await staleTab.getByRole('alert').filter({ hasText: '其他窗口已保存更新的草稿' }).waitFor();
    await firstTab.reload();
    await firstTab.locator('#review-copy-title').waitFor();
    assert.equal(await firstTab.locator('#review-copy-title').inputValue(), '第一个窗口更新稿');
    await conflictContext.close();

    // A formal plan save creates a new copy revision while keeping unsubmitted copy edits and rating locally.
    legacyDrafts = [];
    const planContext = await browser.newContext();
    const planPage = await makePage(planContext);
    await planPage.locator('input[type="radio"][value="2.5"]').check();
    await planPage.locator('#review-copy-title').fill('未提交的文案修改');
    await planPage.locator('#review-plan-headline-0').fill('已正式保存的规划');
    await waitAutosaved(planPage);
    await Promise.all([
      planPage.waitForResponse(async response => response.url().endsWith('/tasks/41')
        && response.request().method() === 'GET'
        && (await response.json()).data?.currentCopyRevisionId === 14),
      planPage.getByRole('button', { name: '单独保存图片规划', exact: true }).click(),
    ]);
    await planPage.reload();
    await planPage.locator('#review-copy-title').waitFor();
    assert.equal(await planPage.locator('#review-copy-title').inputValue(), '未提交的文案修改');
    assert.equal(await planPage.locator('input[type="radio"][value="2.5"]').isChecked(), true);
    assert.equal(await planPage.locator('#review-plan-headline-0').inputValue(), '已正式保存的规划');
    await planContext.close();

    // Rating-only SAVE keeps the revision ID; clearing local history must not revive an older edit.
    revisionId = 12;
    legacyDrafts = [];
    const ratingContext = await browser.newContext();
    const ratingPage = await makePage(ratingContext);
    await ratingPage.locator('input[type="radio"][value="2.5"]').check();
    await ratingPage.locator('textarea[id*="note"]').first().fill('已正式保存的评分说明');
    await ratingPage.locator('#review-copy-title').fill('曾经未提交的文案');
    await waitAutosaved(ratingPage);
    await ratingPage.locator('#review-copy-title').fill('正式文案 A');
    await waitAutosaved(ratingPage);
    await ratingPage.getByText('审核草稿', { exact: true }).click();
    await ratingPage.getByText('草稿 v1', { exact: true }).waitFor();
    await ratingPage.getByText('草稿 v2', { exact: true }).waitFor();
    const getCountBeforeSave = requests.filter(item => item.method === 'GET' && item.path.endsWith('/copy-review-drafts')).length;
    await Promise.all([
      ratingPage.waitForResponse(response => response.url().endsWith('/tasks/41') && response.request().method() === 'GET'),
      ratingPage.getByRole('button', { name: '保存评分，暂不提交', exact: true }).click(),
    ]);
    assert.equal(revisionId, 12, 'rating-only SAVE leaves the formal copy revision unchanged');
    assert.equal(savedAssessment?.score, 2.5);
    legacyDrafts = [legacyRecord('不应再次导入的旧服务器草稿')];
    await ratingPage.reload();
    await ratingPage.locator('#review-copy-title').waitFor({ timeout: 10_000 }).catch(async error => {
      throw new Error(`${error.message}\nPage errors: ${JSON.stringify(errors)}\n${await ratingPage.locator('body').innerText()}\n${JSON.stringify(requests.slice(-8))}`);
    });
    assert.equal(await ratingPage.locator('#review-copy-title').inputValue(), '正式文案 A');
    assert.equal(await ratingPage.locator('input[type="radio"][value="2.5"]').isChecked(), true);
    await ratingPage.getByText('审核草稿', { exact: true }).click();
    await ratingPage.getByText('还没有历史草稿。开始修改后会自动生成第一个版本。', { exact: true }).waitFor();
    assert.equal(requests.filter(item => item.method === 'GET' && item.path.endsWith('/copy-review-drafts')).length,
      getCountBeforeSave, 'cleared drafts retain the migration marker');
    await ratingContext.close();

    assert.equal(requests.some(item => item.method === 'POST' && item.path.endsWith('/copy-review-drafts')), false);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    assert.ok(root.startsWith(join(tmpdir(), 'copy-review-drafts-browser-')));
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});
