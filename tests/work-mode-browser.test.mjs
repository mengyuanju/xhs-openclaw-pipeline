import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_HUMAN_QUALITY_SETTINGS } from '../src/human-quality-settings.mjs';
import { DEFAULT_IMAGE_SETTINGS } from '../server/src/image-options.mjs';

test('work mode browser: embedded review, draft-safe navigation, failure retention, completion, QA and rework', {
  skip: process.env.RUN_WORK_MODE_BROWSER !== '1', timeout: 120_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const output = resolve('.codex_artifacts/work-mode'); await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, 'browser-'));
  const bundle = join(directory, 'bundle.js');
  await build({ stdin: { contents: `
    import './app/globals.css';
    import React from 'react';import{createRoot}from'react-dom/client';
    import{ConfirmDialogProvider}from'./components/ui/confirm-dialog';
    import{TextInputDialogProvider}from'./components/ui/text-input-dialog';
    import{WorkMode}from'./app/work-mode/work-mode';
    import{BackgroundTasksProvider,BackgroundTaskNotifications}from'./app/components/background-tasks';
    import{Toaster}from'./components/ui/sonner';
    const kinds=['COPY','IMAGE','COPY_QA','IMAGE_QA'];
    createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><TextInputDialogProvider><BackgroundTasksProvider accountKey="work-mode-browser"><div className="app-shell" data-work-mode="true"><aside className="sidebar" aria-label="应用导航"><div className="sidebar-head">创作工作台</div><nav className="nav-list"><a className="nav-item active" href="/work-mode">作业模式</a></nav></aside><div className="app-workspace"><header className="app-topbar"><span>作业中心 / 作业模式</span><BackgroundTaskNotifications/></header><main className="main-shell"><WorkMode kinds={kinds} role="USER" nodeId="test-only" username="worker" accountId={8}/></main></div></div><Toaster/></BackgroundTasksProvider></TextInputDialogProvider></ConfirmDialogProvider>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, outfile: bundle, jsx: 'automatic', platform: 'browser',
    conditions: ['style'], alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"', 'process.env': '{}' } });
  const [js, rawCss] = await Promise.all([readFile(bundle), readFile(join(directory, 'bundle.css'), 'utf8')]);
  const { default: postcss } = await import('postcss'), { default: tailwind } = await import('@tailwindcss/postcss');
  const { css } = await postcss([tailwind()]).process(rawCss, { from: join(process.cwd(), 'app/globals.css') });
  const tasks = [1, 2, 3].map(id => ({ id, query: `Query ${id} · 桌面收纳`, state: 'COPY_REVIEW_PENDING',
    aiDisclosureEnabled: false, assignedToUserId: 'worker', assignedToAccountId: 8,
    currentCopyRevisionId: 100 + id, currentImageRunId: null, currentExecutionId: null,
    currentStage: null, progressPercent: 100, priorityPaused: false,
    xiaohongshuLinks: [], copyRevisions: [{ id: 100 + id, revision: 1, approvedAt: null,
      content: { copy: { title: `桌面收纳文案 ${id}`, body: '常用物品放在手边，备用物品分类放进抽屉。给桌面留出写字和阅读的空间。'.repeat(12), tags: ['桌面收纳', '空间整理', '生活技巧'] },
        imagePlan: [{ kind: 'hero', headline: '桌面整理', subtitle: '常用物品放在手边', bullets: ['分类整理', '留出空间'], prompt: '整洁的桌面和收纳区域，文字清晰可读。', layout: { mode: 'AUTO' } }],
        imageSettings: DEFAULT_IMAGE_SETTINGS } }],
    humanQualityAssessments: [], imageRuns: [], assets: [],
  }));
  const qaId = randomUUID(), qaId2 = randomUUID();
  const qaItems = [qaId, qaId2].map((id, i) => ({ id, freezePublicId: randomUUID(), anonymousCode: `QA-${i+1}`, blindReview: true,
    status: 'PENDING', sampleKind: 'RANDOM', capabilities: { canPass: true, canReturnSingle: true, canReturnBatch: false },
    productionBatch: { anonymousCode: '匿名批次' },
    approvedRevision: { content: { copy: { title: `匿名待检文案 ${i+1}`, body: '常用物品分类放在手边，给桌面留出写字和阅读的空间。'.repeat(24), tags: ['桌面收纳', '内容核验'] },
      imagePlan: [1, 2].map(page => ({ ...structuredClone(tasks[0].copyRevisions[0].content.imagePlan[0]), headline: `待检规划 ${page}` })) },
      contentSha256: 'a'.repeat(64), revisionToken: 'opaque-token-'+id } }));
  const imageTask = { ...structuredClone(tasks[2]), id: 4, query: '图片初审测试', state: 'MANUAL_ARCHIVE',
    currentImageRunId: randomUUID() };
  imageTask.copyRevisions[0].approvedAt = new Date().toISOString();
  imageTask.copyRevisions[0].content.imagePlan.push({ ...structuredClone(imageTask.copyRevisions[0].content.imagePlan[0]), kind: 'detail', headline: '分类收纳' });
  imageTask.assets = [401, 402].map((id, i) => ({ id, imageRunId: imageTask.currentImageRunId, sha256: 'b'.repeat(64),
    mediaType: 'image/png', originalName: `${i + 1}.png`, url: `/v1/assets/${id}` }));
  imageTask.imageRuns = [{ id: imageTask.currentImageRunId, result: { images: [{ assetId: 401, pageIndex: 1 }, { assetId: 402, pageIndex: 2 }],
    imageSettings: DEFAULT_IMAGE_SETTINGS, imagePlan: imageTask.copyRevisions[0].content.imagePlan } }];
  const { default: sharp } = await import('sharp');
  const fixtureImages = await Promise.all([1, 2].map(page => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="${page === 1 ? '#e7ede6' : '#eee5dc'}"/><rect x="55" y="190" width="490" height="480" rx="24" fill="#fffaf4"/><circle cx="300" cy="400" r="130" fill="${page === 1 ? '#91ad99' : '#c09c80'}"/><text x="55" y="95" font-family="sans-serif" font-size="26" fill="#344039">LOCAL TEST IMAGE ${page}</text><text x="55" y="740" font-family="sans-serif" font-size="18" fill="#344039">Layout and preview fixture</text></svg>`)).png().toBuffer()));
  tasks.push(imageTask);
  const imageQaItems = [1, 2].map(i => ({ id: randomUUID(), freezePublicId: randomUUID(), anonymousCode: `IMG-QA-${i}`,
    status: 'PENDING', blindReview: i === 1, query: i === 1 ? null : '请核对这组四页收纳图片，确认标题清晰、说明完整、版式一致，并逐页标记需要修改的位置。'.repeat(3), sampleKind: 'RANDOM',
    assets: [...imageTask.assets, ...imageTask.assets.map((asset, index) => ({ ...asset, id: 403 + index, url: `/v1/assets/${403 + index}` }))],
    capabilities: { canPass: i === 1, canReturnSingle: true, canReturnBatch: false }, blockers: { pendingImageEdits: i === 1 ? 0 : 1 } }));
  const drafts = new Map(); const requests = []; const jobs = new Map(); let failSubmit = false; let failList = false; let failDraft = false; let failQaSubmit = false;
  let browser, page;
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/bundle.js') { res.setHeader('content-type', 'application/javascript'); res.end(js); return; }
      if (req.url === '/bundle.css') { res.setHeader('content-type', 'text/css'); res.end(css); return; }
      if (!req.url.startsWith('/api/')) {
        res.setHeader('content-type', 'text/html'); res.end('<html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/bundle.css"><style>button{cursor:pointer}</style><div id="root"></div><script src="/bundle.js"></script></html>'); return;
      }
      const url = new URL(req.url, 'http://localhost'); const pathname = url.pathname;
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ path: pathname, search: url.search, method: req.method, body });
      const reply = (data, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(status === 200 ? { data } : { error: { code: 'TEST_FAILURE', message: data } })); };
      if (pathname.includes('/assets/')) { res.setHeader('content-type', 'image/png'); res.end(fixtureImages[pathname.includes('/402') ? 1 : 0]); return; }
      if (pathname === '/api/human-quality-settings') { reply(DEFAULT_HUMAN_QUALITY_SETTINGS); return; }
      if (/\/image-edits\/[^/]+$/u.test(pathname)) { reply(jobs.get(pathname.split('/').at(-1))); return; }
      if (pathname.endsWith('/work-mode/items')) {
        if (failList) { reply('测试列表暂时不可用', 503); return; }
        const kind = url.searchParams.get('kind'); const offset = Number(url.searchParams.get('offset')); const limit = Number(url.searchParams.get('limit'));
        const rows = kind === 'COPY' ? tasks.filter(t => t.state === 'COPY_REVIEW_PENDING').map(t => ({ id: String(t.id), taskId: t.id, kind, label: t.query,
          version: t.currentCopyRevisionId, state: t.state, source: '测试词包', rework: !!t.mandatoryCopyQc }))
          : kind === 'IMAGE' ? tasks.filter(t => ['MANUAL_ARCHIVE', 'IMAGE_REWORK_PENDING'].includes(t.state)).map(t => ({ id: String(t.id), taskId: t.id, kind, label: t.query, version: t.currentImageRunId }))
          : (kind === 'COPY_QA' ? qaItems : imageQaItems).filter(q => q.status === 'PENDING').map(q => ({ id: q.id, kind, label: q.anonymousCode, source: null, rework: false, qa: q }));
        const filtered = url.searchParams.has('itemId') ? rows.filter(row => row.id === url.searchParams.get('itemId')) : rows;
        reply({ kind, kinds: ['COPY','IMAGE','COPY_QA','IMAGE_QA'], total: filtered.length, hasMore: filtered.length > offset+limit, items: filtered.slice(offset, offset+limit) }); return;
      }
      const match = pathname.match(/\/tasks\/(\d+)(?:\/(.*))?$/u);
      if (match) {
        const id = Number(match[1]); const task = tasks.find(t => t.id === id); const action = match[2];
        if (!action) { reply(task); return; }
        if (action === 'image-capabilities') { reply({ version: 1, reviewImagePlanEdits: true }); return; }
        if (action === 'image-edits') { reply([]); return; }
        if (action?.startsWith('regenerate-image-plan/')) { reply(jobs.get(action.split('/')[1])); return; }
        if (action === 'submit-image-self-review') { task.state = 'IMAGE_QC_PENDING'; reply(task); return; }
        if (action === 'copy-review-drafts') {
          if (req.method === 'POST' && failDraft) { reply('测试草稿保存失败', 503); return; }
          if (req.method === 'POST') { const record = { id: (drafts.get(id)?.id ?? 0)+1, taskId: id, baseCopyRevisionId: task.currentCopyRevisionId,
            content: body.content, createdAt: new Date().toISOString() }; drafts.set(id, record); reply({ created: true, draft: record }); }
          else reply({ baseCopyRevisionId: task.currentCopyRevisionId, drafts: drafts.has(id) ? [drafts.get(id)] : [] });
          return;
        }
        if (action === 'approve-copy') {
          if (failSubmit) { reply('测试提交失败，草稿保留', 409); return; }
          if (body.decision !== 'SAVE') task.state = body.decision === 'DISCARD' ? 'CANCELLED' : 'COPY_QC_PENDING';
          reply(task); return;
        }
      }
      const qa = pathname.match(/\/copy-qa\/items\/([^/]+)\/(pass|return)$/u);
      if (qa) { if (failQaSubmit) { reply('测试质检提交失败', 409); return; } qaItems.find(q => q.id === qa[1]).status = qa[2] === 'pass' ? 'PASSED' : 'RETURNED'; reply({ ok: true }); return; }
      const imageQa = pathname.match(/\/image-qa\/items\/([^/]+)\/(pass|return)$/u);
      if (imageQa) { imageQaItems.find(q => q.id === imageQa[1]).status = imageQa[2] === 'pass' ? 'PASSED' : 'RETURNED'; reply({ ok: true }); return; }
      reply('未配置的测试接口 '+pathname, 404);
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: { code: 'FIXTURE', message: e.message } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.WORK_MODE_BROWSER_CHANNEL || 'msedge' });
    const context = await browser.newContext({ viewport: { width: 1360, height: 1040 } });
    page = await context.newPage();
    const errors = []; page.on('pageerror', e => { errors.push(e.message); console.error('Browser error:', e.stack); });
    await page.route('**/*', route => route.request().url().startsWith(`http://127.0.0.1:${server.address().port}`) ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('#review-copy-title').waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0, 'editor must be inline');
    const assertViewportWorkspace = async () => {
      assert.equal(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 1), false, 'desktop must not have an outer page scrollbar');
      const submit = page.getByRole('button', { name: /^(提交并下一条|通过并下一条|打回并下一条)$/u }).first();
      const bounds = await submit.boundingBox();
      assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= page.viewportSize().height, 'submission stays within the viewport');
    };
    const assertDocumentScroll = async locator => {
      const nestedScrollers = await locator.evaluate(element => {
        const scrollers = [];
        for (let node = element; node && node !== document.body; node = node.parentElement) {
          if (['auto', 'scroll', 'hidden'].includes(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1) scrollers.push(node.className);
        }
        return scrollers;
      });
      assert.deepEqual(nestedScrollers, [], 'small windows scroll the document without a nested editor scroll');
    };
    const assertImageFits = async (content, thumbnails) => {
      assert.equal(await content.evaluate(element => element.scrollHeight > element.clientHeight + 1), false, 'main image and thumbnails fit without vertical scrolling');
      const bounds = await thumbnails.boundingBox();
      assert.ok(bounds && bounds.height <= 75 && bounds.y + bounds.height <= page.viewportSize().height, 'compact thumbnails stay visible below the main image');
    };
    for (const viewport of [{ width: 1366, height: 768 }, { width: 1280, height: 720 }, { width: 1000, height: 600 }]) {
      await page.setViewportSize(viewport);
      await assertViewportWorkspace();
    }
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.screenshot({ path: join(directory, 'copy-single-scroll-laptop.png'), fullPage: true });
    await page.setViewportSize({ width: 1360, height: 1040 });
    const copyPane = page.locator('#review-copy-pane'), planPane = page.locator('#review-plan-pane');
    const assertCopyColumns = async () => {
      const [copy, plan] = await Promise.all([copyPane.boundingBox(), planPane.boundingBox()]);
      assert.ok(copy && plan && plan.x >= copy.x + copy.width && Math.abs(plan.y - copy.y) < 2, 'copy and image plan must be visible side by side');
      assert.ok(Math.abs(copy.width - plan.width) < 3, 'copy columns should have equal width');
      return copy.width;
    };
    const initialCopyWidth = await assertCopyColumns();
    for (const width of [1280, 1200, 1152]) {
      await page.setViewportSize({ width, height: 1040 });
      await assertCopyColumns();
      assert.equal(await copyPane.evaluate(pane => pane.scrollWidth > pane.clientWidth + 1), false, 'copy fits inside the full application at ' + width);
      assert.equal(await planPane.evaluate(pane => pane.scrollWidth > pane.clientWidth + 1), false, 'plan fits inside the full application at ' + width);
    }
    await page.screenshot({ path: join(directory, 'copy-columns-full-app-1152.png'), fullPage: true });
    await page.setViewportSize({ width: 1360, height: 1040 });
    const footerY = (await page.locator('.workbench-review-footer').boundingBox()).y;
    await copyPane.evaluate(pane => { pane.scrollTop = 180; });
    assert.ok(await copyPane.evaluate(pane => pane.scrollTop) > 0);
    assert.equal(await planPane.evaluate(pane => pane.scrollTop), 0, 'copy scroll must not move the plan');
    assert.equal((await page.locator('.workbench-review-footer').boundingBox()).y, footerY, 'actions stay fixed while reading');
    await copyPane.evaluate(pane => { pane.scrollTop = 0; });
    await page.getByRole('button', { name: '收起待办侧栏', exact: true }).click();
    assert.ok(await assertCopyColumns() > initialCopyWidth, 'collapsing the queue expands both columns');
    await page.getByRole('button', { name: '展开待办侧栏', exact: true }).click();
    await page.setViewportSize({ width: 1000, height: 1040 });
    assert.equal(await planPane.isVisible(), false, 'narrow editor uses pane switching');
    await page.getByRole('button', { name: '收起待办侧栏', exact: true }).click();
    await assertCopyColumns();
    await page.getByRole('button', { name: '展开待办侧栏', exact: true }).click();
    await page.getByRole('button', { name: '图片文案规划', exact: true }).click();
    assert.equal(await planPane.isVisible(), true);
    assert.equal(await copyPane.isVisible(), false);
    await page.setViewportSize({ width: 1360, height: 1040 });
    await assertCopyColumns();
    await page.screenshot({ path: join(directory, 'copy-columns-desktop.png'), fullPage: true });
    await page.locator('input[type="radio"][value="3"]').check();
    await page.getByRole('button', { name: '提交并下一条', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#review-copy-title')?.value === '桌面收纳文案 2');
    assert.equal(await page.getByRole('button', { name: /本次已提交 1/u }).count(), 1);
    assert.equal(tasks[0].state, 'COPY_QC_PENDING');
    assert.equal(await page.getByRole('button', { name: /#1.*Query 1/u }).count(), 0);
    await page.locator('input[type="radio"][value="2.5"]').check();
    await page.locator('#review-copy-title').fill('保留的人工修改稿');
    await page.getByRole('button', { name: /#3.*Query 3/u }).click();
    await page.waitForFunction(() => document.querySelector('#review-copy-title')?.value === '桌面收纳文案 3');
    assert.equal(drafts.get(2).content.draft.copy.title, '保留的人工修改稿');
    await page.getByRole('button', { name: /#2.*Query 2/u }).click();
    await page.waitForFunction(() => document.querySelector('#review-copy-title')?.value === '保留的人工修改稿');
    // Low original scores need an explanation in the existing review form.
    await page.locator('textarea[id*="note"]').first().fill('标题表达需要小修');
    failSubmit = true;
    await page.getByRole('button', { name: '提交并下一条', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '测试提交失败' }).waitFor();
    assert.equal(await page.locator('#review-copy-title').inputValue(), '保留的人工修改稿');
    assert.equal(await page.getByRole('button', { name: /本次已提交 1/u }).count(), 1);
    failSubmit = false; failList = true;
    await page.getByRole('button', { name: '提交并下一条', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#review-copy-title')?.value === '桌面收纳文案 3');
    assert.equal(await page.getByRole('button', { name: /本次已提交 2/u }).count(), 1);
    await page.getByRole('alert').filter({ hasText: '测试列表暂时不可用' }).waitFor();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole('button', { name: /本次已提交 2/u }).click();
    await assertViewportWorkspace();
    await page.getByRole('button', { name: /本次已提交 2/u }).click();
    failList = false;
    tasks[0].state = 'COPY_REVIEW_PENDING'; tasks[0].mandatoryCopyQc = true; tasks[0].currentCopyRevisionId = 201;
    tasks[0].copyRevisions[0].id = 201; tasks[0].copyRevisions[0].revisionOrigin = 'QA_RETURN';
    await page.getByRole('button', { name: '刷新待办', exact: true }).click();
    await page.getByRole('button', { name: /#1.*需要返工/u }).waitFor();
    await page.screenshot({ path: join(directory, 'desktop.png'), fullPage: true });
    for (const width of [768,390,320]) {
      await page.setViewportSize({ width, height: 960 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      assert.equal(overflow, false, 'horizontal overflow at '+width);
      if (width <= 760) await assertDocumentScroll(page.locator('.workbench-review-pane:visible').first());
    }
    await page.screenshot({ path: join(directory, 'mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1366, height: 540 });
    await assertDocumentScroll(copyPane);
    await page.setViewportSize({ width: 1360, height: 1040 });
    await page.getByRole('button', { name: '文案质检', exact: true }).click();
    await page.getByRole('heading', { name: '匿名待检文案 1' }).waitFor();
    assert.equal(await page.getByText('原始 Query', { exact: true }).count(), 0);
    const copyQaContent = page.getByRole('region', { name: '文案核对', exact: true });
    const copyQaActions = page.getByRole('complementary', { name: '文案质检操作', exact: true });
    const assertQualityColumns = async (content, actions) => {
      const [left, right] = await Promise.all([content.boundingBox(), actions.boundingBox()]);
      assert.ok(left && right && right.x >= left.x + left.width && Math.abs(left.y - right.y) < 2, 'quality content and actions must be side by side');
      for (const panel of [content, actions]) assert.equal(await panel.evaluate(element => element.scrollWidth > element.clientWidth + 1), false, 'quality panel must not clip controls horizontally');
    };
    for (const width of [1360, 1280, 1152]) {
      await page.setViewportSize({ width, height: 1040 });
      await assertQualityColumns(copyQaContent, copyQaActions);
      await assertViewportWorkspace();
    }
    await copyQaActions.getByRole('button', { name: '下一页规划', exact: true }).click();
    await copyQaActions.getByRole('heading', { name: '待检规划 2', exact: true }).waitFor();
    const qaFooterY = (await page.getByRole('button', { name: '通过并下一条', exact: true }).boundingBox()).y;
    await copyQaContent.evaluate(element => { element.scrollTop = 220; });
    assert.ok(await copyQaContent.evaluate(element => element.scrollTop) > 0);
    assert.equal(await copyQaActions.evaluate(element => element.scrollTop), 0);
    assert.equal((await page.getByRole('button', { name: '通过并下一条', exact: true }).boundingBox()).y, qaFooterY);
    await copyQaContent.evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: join(directory, 'copy-quality-columns-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 960 });
    await page.getByRole('button', { name: '规划与质检', exact: true }).click();
    assert.equal(await copyQaContent.isVisible(), false);
    await copyQaActions.getByRole('heading', { name: '待检规划 2', exact: true }).waitFor();
    await page.getByRole('button', { name: '查看文案', exact: true }).click();
    assert.equal(await copyQaContent.isVisible(), true);
    await page.setViewportSize({ width: 1360, height: 1040 });
    await page.getByRole('button', { name: '通过并下一条', exact: true }).click();
    await page.getByRole('heading', { name: '匿名待检文案 2' }).waitFor();
    await page.getByRole('button', { name: '打回', exact: true }).click();
    await page.getByPlaceholder('请说明需要修改的位置和内容').fill('需要核对事实依据');
    await page.setViewportSize({ width: 1366, height: 768 });
    await assertViewportWorkspace();
    await page.screenshot({ path: join(directory, 'copy-quality-single-scroll-laptop.png'), fullPage: true });
    await page.getByRole('combobox', { name: '处理建议', exact: true }).click();
    await page.getByRole('option', { name: '建议负责人废弃', exact: true }).click();
    await page.getByRole('button', { name: '暂跳过', exact: true }).click();
    await page.getByRole('button', { name: '继续填写', exact: true }).click();
    assert.equal(await page.getByPlaceholder('请说明需要修改的位置和内容').inputValue(), '需要核对事实依据');
    failQaSubmit = true;
    await page.getByRole('button', { name: '打回并下一条', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '测试质检提交失败' }).waitFor();
    assert.equal(await page.getByPlaceholder('请说明需要修改的位置和内容').inputValue(), '需要核对事实依据');
    assert.equal(qaItems[1].status, 'PENDING');
    failQaSubmit = false;
    await page.getByRole('button', { name: '打回并下一条', exact: true }).click();
    await page.getByRole('heading', { name: '当前暂无待处理作业' }).waitFor();
    assert.equal(qaItems[1].status, 'RETURNED');
    assert.equal(requests.find(r => r.path.endsWith(qaItems[1].id+'/return')).body.recommendedDisposition, 'DISCARD');
    await page.getByRole('button', { name: '图片作业', exact: true }).click();
    await page.getByRole('heading', { name: '图片初审详情' }).waitFor();
    assert.equal(await page.locator('#review-copy-title, #review-copy-body, #review-plan-pane').count(), 0, 'image work must omit copy and image-plan editors');
    const gallery = page.locator('.workbench-image-review-gallery');
    const imagePanel = page.getByRole('complementary', { name: '图片操作与信息' });
    const [galleryBounds, panelBounds] = await Promise.all([gallery.boundingBox(), imagePanel.boundingBox()]);
    assert.ok(panelBounds.x >= galleryBounds.x + galleryBounds.width && Math.abs(panelBounds.y - galleryBounds.y) < 2);
    assert.ok(galleryBounds.width / panelBounds.width > 1.8, 'images receive most of the workspace width');
    for (const width of [1280, 1200, 1152]) {
      await page.setViewportSize({ width, height: 1040 });
      const [imageBounds, actionsBounds] = await Promise.all([gallery.boundingBox(), imagePanel.boundingBox()]);
      assert.ok(actionsBounds.x >= imageBounds.x + imageBounds.width && Math.abs(actionsBounds.y - imageBounds.y) < 2, 'image work keeps two columns in the full application at ' + width);
      assert.equal(await imagePanel.evaluate(panel => panel.scrollWidth > panel.clientWidth + 1), false, 'image actions fit their column at ' + width);
      await assertViewportWorkspace();
    }
    await page.screenshot({ path: join(directory, 'image-columns-full-app-1152.png'), fullPage: true });
    await page.setViewportSize({ width: 1360, height: 1040 });
    const imageToolbar = page.getByRole('group', { name: '当前图片操作', exact: true });
    await page.setViewportSize({ width: 1366, height: 768 });
    await assertViewportWorkspace();
    await assertImageFits(gallery, page.getByRole('navigation', { name: '选择审核图片', exact: true }));
    await page.screenshot({ path: join(directory, 'image-single-scroll-laptop.png'), fullPage: true });
    await page.setViewportSize({ width: 1360, height: 1040 });
    await imageToolbar.getByRole('button', { name: '修改图片', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^下一张图片，第 02 页/u }).click();
    assert.equal(await page.getByRole('button', { name: /^选择第 2 页/u }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: /^放大查看第 2 页/u }).click();
    const preview = page.getByRole('dialog');
    await preview.getByRole('button', { name: '完整显示', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.image-preview-viewport')?.getAttribute('aria-busy') === 'false');
    await preview.getByRole('button', { name: '向右旋转', exact: true }).click();
    assert.match(await preview.locator('.image-preview-full').getAttribute('style'), /rotate\(90deg\)/u);
    await preview.getByRole('button', { name: /上一张/u }).click();
    await preview.getByRole('button', { name: '100% 查看', exact: true }).click();
    assert.equal(await preview.getByRole('slider', { name: '调整预览倍数' }).isEnabled(), true);
    await page.screenshot({ path: join(directory, 'image-preview-desktop.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button', { name: /^选择第 1 页/u }).getAttribute('aria-pressed'), 'true', 'closing preview keeps the last viewed page selected');
    await page.locator('.image-preview-dialog').waitFor({ state: 'detached' });
    await imagePanel.getByRole('button', { name: '交付格式与背景', exact: true }).click();
    await imagePanel.getByRole('combobox', { name: '文件格式', exact: true }).waitFor();
    await page.screenshot({ path: join(directory, 'image-columns-desktop.png'), fullPage: true });
    for (const width of [1000, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'image work overflow at ' + width);
      assert.equal(await imageToolbar.getByRole('button', { name: '修改图片', exact: true }).isVisible(), true);
      if (width <= 760) await assertDocumentScroll(imagePanel);
      await page.getByRole('button', { name: /^放大查看第 1 页/u }).click();
      await preview.waitFor();
      const bounds = await preview.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, 'preview fits viewport at ' + width);
      await page.keyboard.press('Escape');
      await page.locator('.image-preview-dialog').waitFor({ state: 'detached' });
    }
    await page.screenshot({ path: join(directory, 'image-columns-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1360, height: 1040 });
    await page.getByRole('button', { name: '提交并下一条', exact: true }).click();
    await page.getByRole('button', { name: '提交图片抽检', exact: true }).click();
    await page.getByRole('heading', { name: '当前暂无待处理作业' }).waitFor();
    assert.equal(imageTask.state, 'IMAGE_QC_PENDING');
    await page.getByRole('button', { name: '图片质检', exact: true }).click();
    const imageQaContent = page.getByRole('region', { name: '图片核对', exact: true });
    const imageQaActions = page.getByRole('complementary', { name: '图片质检操作', exact: true });
    for (const width of [1360, 1280, 1152]) {
      await page.setViewportSize({ width, height: 1040 });
      assert.equal(await imageQaActions.isVisible(), false, 'image verification reserves the content area for the main image');
      await assertViewportWorkspace();
    }
    assert.equal(await page.getByRole('region', { name: '文案核对', exact: true }).count(), 0);
    await page.setViewportSize({ width: 1366, height: 768 });
    await assertViewportWorkspace();
    await assertImageFits(imageQaContent, page.getByRole('navigation', { name: '选择待检图片', exact: true }));
    await page.screenshot({ path: join(directory, 'image-quality-single-scroll-laptop.png'), fullPage: true });
    const qaNextButton = imageQaContent.locator('.image-carousel-navigation-button[data-direction="next"]');
    const nextBeforeHover = await qaNextButton.boundingBox();
    await qaNextButton.hover();
    await qaNextButton.evaluate(async button => {
      button.getBoundingClientRect();
      await Promise.all(button.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
    });
    const [nextAfterHover, nextIcon] = await Promise.all([qaNextButton.boundingBox(), qaNextButton.locator('.image-carousel-navigation-icon').boundingBox()]);
    assert.deepEqual({
      moved: Math.abs(nextBeforeHover.x - nextAfterHover.x) > .5 || Math.abs(nextBeforeHover.y - nextAfterHover.y) > .5,
      clipped: nextIcon.x < nextAfterHover.x + 1 || nextIcon.x + nextIcon.width > nextAfterHover.x + nextAfterHover.width - 1,
    }, { moved: false, clipped: false }, 'hover must preserve the click target and keep the arrow circle inside the button');
    await page.screenshot({ path: join(directory, 'image-quality-columns-desktop.png'), fullPage: true });
    await page.getByRole('button', { name: '放大查看第 1 页' }).click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('dialog').getByRole('button', { name: '下一张图片', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '向右旋转', exact: true }).click();
    assert.match(await page.locator('.image-preview-full').getAttribute('style'), /rotate\(90deg\)/u);
    await page.keyboard.press('Escape');
    await page.locator('.image-preview-dialog').waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('button', { name: '选择待检图片第 2 页', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: '通过并下一条', exact: true }).click();
    await page.getByText('IMG-QA-2', { exact: true }).last().waitFor();
    assert.equal(await page.getByRole('button', { name: '通过并下一条', exact: true }).isDisabled(), true);
    const queryToggle = page.getByRole('button', { name: /^原始 Query/u });
    await queryToggle.click();
    assert.equal(await queryToggle.getAttribute('aria-expanded'), 'true');
    await queryToggle.click();
    await page.getByRole('button', { name: '标记当前页有问题', exact: true }).click();
    await assertQualityColumns(imageQaContent, imageQaActions);
    assert.equal(await page.getByLabel('第 1 页有问题', { exact: true }).isChecked(), true);
    assert.match(await page.getByRole('button', { name: '选择待检图片第 1 页', exact: true }).innerText(), /问题/u);
    await page.getByRole('combobox', { name: '原图评分', exact: true }).click();
    await page.getByRole('option', { name: '1 分 · 返工', exact: true }).click();
    await page.getByRole('combobox', { name: '返工范围', exact: true }).click();
    await page.getByRole('option', { name: '文案和图片', exact: true }).click();
    await page.getByRole('group', { name: '需要修改的文案字段', exact: true }).getByLabel('标题', { exact: true }).check();
    await page.getByLabel('第 1 页有问题', { exact: true }).check();
    if (DEFAULT_HUMAN_QUALITY_SETTINGS.imageReviewDisplay.showDeductionReasons) {
      await page.getByLabel(DEFAULT_HUMAN_QUALITY_SETTINGS.imageReasons[0].label, { exact: true }).check();
    }
    await page.getByPlaceholder('请说明需要修改的位置和内容').fill('第一张图片需要修正');
    await page.setViewportSize({ width: 1366, height: 768 });
    await assertViewportWorkspace();
    const qaToolbar = page.getByRole('group', { name: '图片质检快捷操作', exact: true });
    const toolbarBeforeScroll = await qaToolbar.boundingBox();
    await imageQaActions.evaluate(element => { element.scrollTop = element.scrollHeight; });
    assert.deepEqual(await qaToolbar.boundingBox(), toolbarBeforeScroll, 'image controls stay fixed while completing the return form');
    await assertImageFits(imageQaContent, page.getByRole('navigation', { name: '选择待检图片', exact: true }));
    await imageQaActions.evaluate(element => { element.scrollTop = 0; });
    await page.getByRole('button', { name: '查看问题候选第 2 页', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '选择待检图片第 2 页', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByPlaceholder('请说明需要修改的位置和内容').inputValue(), '第一张图片需要修正');
    await page.screenshot({ path: join(directory, 'quality-controls-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 960 });
    await page.getByRole('button', { name: '质检操作', exact: true }).click();
    assert.equal(await imageQaContent.isVisible(), false);
    await page.getByRole('combobox', { name: '返工范围', exact: true }).click();
    const menuBounds = await page.getByRole('listbox').boundingBox();
    assert.ok(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= 390);
    await page.screenshot({ path: join(directory, 'quality-controls-mobile.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '查看问题候选第 1 页', exact: true }).click();
    await page.getByRole('button', { name: '放大查看第 1 页', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.image-preview-dialog').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '质检操作', exact: true }).click();
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'quality work has no horizontal overflow at ' + width);
      assert.equal(await imageQaActions.evaluate(element => element.scrollWidth > element.clientWidth + 1), false);
      if (width <= 760) await assertDocumentScroll(imageQaActions);
    }
    assert.equal(await page.getByPlaceholder('请说明需要修改的位置和内容').inputValue(), '第一张图片需要修正');
    await page.getByRole('button', { name: '打回并下一条', exact: true }).click();
    await page.getByRole('heading', { name: '当前暂无待处理作业' }).waitFor();
    assert.equal(imageQaItems[1].status, 'RETURNED');
    assert.deepEqual(requests.find(r => r.path.endsWith(imageQaItems[1].id+'/return')).body.problemAssetIds, [401]);
    const imageReturn = requests.find(r => r.path.endsWith(imageQaItems[1].id+'/return')).body;
    assert.equal(imageReturn.score, 1);assert.equal(imageReturn.reworkTarget, 'BOTH');assert.deepEqual(imageReturn.copyFields, ['TITLE']);

    // Background results stay in work mode, even when the target is beyond page one.
    await page.setViewportSize({ width: 1360, height: 1040 });
    for (let id = 10; id <= 65; id++) {
      const extra = structuredClone(tasks[2]); extra.id = id; extra.query = `后续作业 ${id}`;
      extra.copyRevisions[0].content.copy.title = `后续作业文案 ${id}`; tasks.push(extra);
    }
    await page.getByRole('button', { name: /^文案作业/u }).click();
    await page.getByRole('button', { name: /#3.*Query 3/u }).click();
    await page.waitForFunction(() => document.querySelector('#review-copy-title')?.value === '桌面收纳文案 3');
    const planId = randomUUID(), runningId = randomUUID();
    jobs.set(planId, { id: planId, status: 'SUCCEEDED', copyRevisionId: 103,
      copy: tasks.at(-1).copyRevisions[0].content.copy, result: { imagePlan: tasks.at(-1).copyRevisions[0].content.imagePlan } });
    jobs.set(runningId, { id: runningId, status: 'RUNNING' });
    const storageKey = 'xhs:background-tasks:v1:work-mode-browser';
    await page.evaluate(({ storageKey, planId, runningId }) => {
      localStorage.setItem(storageKey, JSON.stringify([
        { id: planId, kind: 'IMAGE_PLAN', taskId: 65, status: 'SUCCEEDED', createdAt: Date.now(), read: false },
        { id: runningId, kind: 'IMAGE_PLAN', taskId: 1, status: 'RUNNING', createdAt: Date.now(), read: false },
      ])); window.dispatchEvent(new Event('focus'));
    }, { storageKey, planId, runningId });
    const notificationButton = page.getByRole('button', { name: '后台任务，1 项处理中，1 条未读提醒', exact: true });
    await notificationButton.waitFor();
    assert.match(await notificationButton.innerText(), /1 项处理中/u); assert.match(await notificationButton.innerText(), /1 条新提醒/u);
    await page.getByRole('button', { name: /#1.*规划 · 处理中/u }).waitFor();
    assert.equal(await page.getByRole('button', { name: /#65.*后续作业 65/u }).count(), 0);
    failDraft = true;
    await page.locator('input[type="radio"][value="2.5"]').check();
    await page.locator('#review-copy-title').fill('通知切换前必须保留的草稿');
    await notificationButton.click();
    await page.getByRole('dialog').getByRole('article').filter({ hasText: '任务 #65' }).getByRole('button', { name: '查看任务' }).click();
    await page.getByText('草稿保存失败，已保留当前作业，请保存成功后再切换。', { exact: true }).waitFor();
    assert.equal(await page.locator('#review-copy-title').inputValue(), '通知切换前必须保留的草稿');
    assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).find(task => task.taskId === 65).read, storageKey), false);
    failDraft = false;
    await notificationButton.click();
    await page.getByRole('dialog').getByRole('article').filter({ hasText: '任务 #65' }).getByRole('button', { name: '查看任务' }).click();
    await page.waitForFunction(() => document.querySelector('#review-copy-title')?.value === '后续作业文案 65');
    assert.equal(drafts.get(3).content.draft.copy.title, '通知切换前必须保留的草稿');
    assert.equal(new URL(page.url()).pathname, '/');
    await page.getByRole('button', { name: /#65.*规划 · 待确认/u }).waitFor();
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#review-copy-title')?.value === '后续作业文案 65');
    assert.ok(requests.some(request => request.search.includes('itemId=65')));
    await page.getByRole('button', { name: '暂跳过', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#review-copy-title')?.value !== '后续作业文案 65');
    await page.getByRole('button', { name: '加载更多待办', exact: true }).click();
    await page.getByRole('button', { name: /#58.*后续作业 58/u }).waitFor();
    await page.getByRole('button', { name: /#65.*后续作业 65/u }).click();
    await page.waitForFunction(() => document.querySelector('#review-copy-title')?.value === '后续作业文案 65');

    // Another tab sees read/consumed changes; completion is announced once.
    const second = await page.context().newPage();
    second.on('pageerror', error => errors.push(error.message));
    await second.goto(page.url());
    jobs.get(runningId).status = 'FAILED'; jobs.get(runningId).error = '测试后台失败';
    await Promise.all([page.evaluate(() => window.dispatchEvent(new Event('focus'))), second.evaluate(() => window.dispatchEvent(new Event('focus')))]);
    for (const tab of [page, second]) await tab.getByRole('button', { name: '后台任务，0 项处理中，1 条未读提醒', exact: true }).waitFor();
    assert.equal(await page.locator('[data-sonner-toast]').filter({ hasText: '测试后台失败' }).count() + await second.locator('[data-sonner-toast]').filter({ hasText: '测试后台失败' }).count(), 1);
    await page.getByRole('button', { name: '后台任务，0 项处理中，1 条未读提醒', exact: true }).click();
    await page.getByRole('button', { name: '全部标为已读', exact: true }).click();
    await second.getByRole('button', { name: '后台任务，0 项处理中，0 条未读提醒', exact: true }).waitFor();
    await page.getByRole('dialog').getByText('待确认 · 1', { exact: true }).waitFor();
    await page.screenshot({ path: join(directory, 'background-tasks-desktop.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(directory, 'background-tasks-mobile.png'), animations: 'disabled' });
    const dialogBounds = await page.getByRole('dialog').boundingBox();
    assert.ok(dialogBounds.x >= 0 && dialogBounds.x + dialogBounds.width <= 390);
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await page.setViewportSize({ width: 1360, height: 1040 });
    if (await page.getByRole('button', { name: '图片文案规划', exact: true }).isVisible()) await page.getByRole('button', { name: '图片文案规划', exact: true }).click();
    await page.getByRole('button', { name: '载入新规划', exact: true }).click();
    await second.waitForFunction(key => JSON.parse(localStorage.getItem(key)).find(task => task.taskId === 65).consumed === true, storageKey);
    await second.getByRole('button', { name: '后台任务，0 项处理中，0 条未读提醒', exact: true }).click();
    assert.equal(await second.getByRole('dialog').getByText('待确认 · 1', { exact: true }).count(), 0);
    await second.close();
    // If the saved target is no longer pending, reloading selects a valid next item.
    tasks.at(-1).state = 'COPY_QC_PENDING';
    await page.reload();
    await page.getByText('上次作业已不在当前待办中，已为你打开下一条。', { exact: true }).waitFor();
    assert.notEqual(await page.locator('#review-copy-title').inputValue(), '后续作业文案 65');
    // Toast actions also use the guarded in-mode path, including a type switch.
    imageTask.state = 'MANUAL_ARCHIVE';
    const editId = randomUUID(); jobs.set(editId, { id: editId, status: 'PREVIEW_READY' });
    await page.evaluate(({ storageKey, editId }) => {
      const rows = JSON.parse(localStorage.getItem(storageKey));
      rows.unshift({ id: editId, kind: 'IMAGE_EDIT', taskId: 4, page: 1, status: 'RUNNING', createdAt: Date.now(), read: false });
      localStorage.setItem(storageKey, JSON.stringify(rows)); window.dispatchEvent(new Event('focus'));
    }, { storageKey, editId });
    await page.locator('[data-sonner-toast]').filter({ hasText: '任务 #4' }).getByRole('button', { name: '查看任务', exact: true }).click();
    await page.getByRole('heading', { name: '图片初审详情', exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/');
    await page.getByRole('button', { name: /#4.*第 1 页修复 · 待确认/u }).waitFor();
    await page.getByRole('button', { name: /^后台任务，/u }).click();
    await page.getByText('已处理记录 · 2', { exact: true }).click();
    await page.getByRole('dialog').getByRole('article').filter({ hasText: '任务 #65' }).getByRole('button', { name: '查看任务' }).click();
    await page.getByRole('alert').filter({ hasText: '该任务已不在你的文案或图片待办中' }).waitFor();
    await page.getByRole('heading', { name: '图片初审详情', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    assert.ok(requests.filter(r => r.path.endsWith('approve-copy')).length >= 3);
    console.log('Work mode browser screenshots: '+directory);
  } catch (e) {
    if (page) { await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => {}); await writeFile(join(directory, 'failure.html'), await page.content()); }
    console.error('Work mode failure artifacts: '+directory); throw e;
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
