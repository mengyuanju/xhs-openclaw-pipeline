import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { DEFAULT_HUMAN_QUALITY_SETTINGS } from '../src/human-quality-settings.mjs';
import { DEFAULT_IMAGE_SETTINGS } from '../server/src/image-options.mjs';
import { loadWorkModePage } from '../server/src/work-mode.mjs';

test('secondary assignment feedback: safe history, independent rework, draft navigation and responsive layout', {
  skip: process.env.RUN_SECONDARY_ASSIGNMENT_FEEDBACK_BROWSER !== '1', timeout: 120_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const output = resolve('.codex_artifacts/secondary-assignment-feedback');
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, 'browser-'));
  const bundle = join(directory, 'bundle.js');
  await build({ stdin: { contents: `
    import './app/globals.css';
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {ConfirmDialogProvider} from './components/ui/confirm-dialog';
    import {TextInputDialogProvider} from './components/ui/text-input-dialog';
    import {BackgroundTasksProvider,BackgroundTaskNotifications} from './app/components/background-tasks';
    import {WorkMode} from './app/work-mode/work-mode';
    import {Toaster} from './components/ui/sonner';
    const kinds=['COPY','IMAGE'];
    createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><TextInputDialogProvider><BackgroundTasksProvider accountKey="secondary-feedback-browser" accountUsername="worker" accountId={8}><div className="app-shell" data-work-mode="true"><aside className="sidebar" aria-label="应用导航"><div className="sidebar-head">创作工作台</div><nav className="nav-list"><a className="nav-item active" href="/work-mode">作业模式</a></nav></aside><div className="app-workspace"><header className="app-topbar"><span>作业中心 / 作业模式</span><BackgroundTaskNotifications/></header><main className="main-shell"><WorkMode kinds={kinds} role="USER" nodeId="test-only" username="worker" accountId={8}/></main></div></div><Toaster/></BackgroundTasksProvider></TextInputDialogProvider></ConfirmDialogProvider>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, outfile: bundle,
  jsx: 'automatic', platform: 'browser', conditions: ['style'], alias: { '@': process.cwd() },
  define: { 'process.env.NODE_ENV': '"test"', 'process.env': '{}' } });
  const [js, rawCss] = await Promise.all([readFile(bundle), readFile(join(directory, 'bundle.css'), 'utf8')]);
  const { default: postcss } = await import('postcss');
  const { default: tailwind } = await import('@tailwindcss/postcss');
  const { css } = await postcss([tailwind()]).process(rawCss, { from: join(process.cwd(), 'app/globals.css') });
  const plan = [1, 2, 3].map(index => ({ kind: index === 1 ? 'hero' : index === 2 ? 'steps' : 'summary',
    headline: `桌面整理第 ${index} 页`, subtitle: '常用物品放在手边', bullets: ['分类整理', '留出空间'],
    prompt: `自然光下展示整洁的桌面和第 ${index} 页收纳区域，文字清晰可读。`, layout: { mode: 'AUTO' } }));
  const tasks = [108, 236, 950, 237].map(id => ({ id, query: `Query ${id} · 桌面收纳`,
    state: 'COPY_REVIEW_PENDING', assignedToUserId: 'worker', assignedToAccountId: 8,
    currentCopyRevisionId: 1000 + id, currentImageRunId: null, currentExecutionId: null,
    currentStage: null, progressPercent: 100, priorityPaused: false, aiDisclosureEnabled: false,
    mandatoryCopyQc: id !== 950, mandatoryCopyQcOrigin: id === 950 ? null : 'SECOND_ASSIGNMENT',
    copyQaReworkPending: id === 950 || id === 237,
    xiaohongshuLinks: [], humanQualityAssessments: [], imageRuns: [], assets: [],
    copyRevisions: [{ id: 1000 + id, revision: 1, approvedAt: null,
      revisionOrigin: id === 950 || id === 237 ? 'QA_RETURN' : 'SECOND_ASSIGNMENT_RESET',
      content: { copy: { title: `桌面收纳文案 ${id}`, body: '常用物品放在手边，备用物品分类放进抽屉。给桌面留出写字和阅读的空间。'.repeat(12),
        tags: ['桌面收纳', '空间整理', '生活技巧'] }, imagePlan: structuredClone(plan), imageSettings: DEFAULT_IMAGE_SETTINGS } }],
  }));
  const [first, long, regularReturn, returnedAgain] = tasks;
  first.secondaryAssignmentFeedback = { assignedAt: '2026-09-30T05:00:00Z', entries: [
    { stage: 'COPY', reasonLabels: ['标题 · 缺少信息钩子', '正文 · 细节信息错误'],
      note: '最近反馈：标题数量与正文不一致，需要核对适用场景。', reviewedAt: '2026-09-30T04:00:00Z' },
    { stage: 'COPY', reasonLabels: ['图文规划 · 漏字错字'], note: '早期反馈：第 2 页标题需要修正错字。', reviewedAt: '2026-09-30T03:00:00Z' },
  ] };
  const unsafeText = '<img src=x onerror="window.__feedbackInjected=true"><script>window.__feedbackInjected=true</script>';
  const longNote = `${unsafeText}\n第 1 页：请核对标题和正文信息。\n第 2 页：修正图片规划漏字。\n${'长连续反馈内容'.repeat(120)}\n最后一行：完整反馈结束。`;
  long.secondaryAssignmentFeedback = { assignedAt: '2026-09-30T06:00:00Z', entries: [
    { stage: 'COPY', reasonLabels: ['图文规划 · 与正文细节/数据不一致', '连续标签内容'.repeat(30)],
      note: longNote, reviewedAt: '2026-09-30T05:30:00Z' },
  ] };
  for (const task of [regularReturn, returnedAgain]) Object.assign(task.copyRevisions[0], {
    reworkOrigin: 'QA_RETURN', reworkTarget: 'COPY', reworkReasonCodes: ['BODY_DETAIL_ERROR'],
    reworkReasonSnapshots: [{ code: 'BODY_DETAIL_ERROR', group: 'BODY', label: '细节信息错误' }],
    reworkNote: `当前返工要求 ${task.id}：请核对正文数量并修改错误标题。`,
  });
  returnedAgain.secondaryAssignmentFeedback = structuredClone(first.secondaryAssignmentFeedback);
  returnedAgain.secondaryAssignmentFeedback.entries[0].note = '历史参考 237：上轮正文场景说明不足。';
  const imageTask = { ...structuredClone(first), id: 238, query: '图片作业历史反馈测试', state: 'MANUAL_ARCHIVE',
    currentCopyRevisionId: 1238, currentImageRunId: '11111111-1111-4111-8111-111111111111',
    mandatoryImageQc: true, mandatoryImageQcOrigin: 'SECOND_ASSIGNMENT',
    secondaryAssignmentFeedback: { assignedAt: '2026-09-30T06:00:00Z', entries: [
      { stage: 'IMAGE', reasonLabels: ['图片 · 文字可读性', '图片 · 图集不连贯'],
        note: '历史图片反馈：第 2 页标题被遮挡，请逐页检查图集内容。', reviewedAt: '2026-09-30T05:00:00Z' },
      { stage: 'COPY', reasonLabels: ['图文规划 · 漏字错字'],
        note: '此前图片规划反馈：检查第 3 页标题错字。', reviewedAt: '2026-09-30T04:00:00Z' },
    ] } };
  Object.assign(imageTask.copyRevisions[0], { id: imageTask.currentCopyRevisionId, approvedAt: '2026-09-30T06:30:00Z' });
  imageTask.assets = [1401, 1402, 1403].map((id, index) => ({ id, imageRunId: imageTask.currentImageRunId,
    sha256: 'b'.repeat(64), mediaType: 'image/png', originalName: `${index + 1}.png`, url: `/v1/assets/${id}` }));
  imageTask.imageRuns = [{ id: imageTask.currentImageRunId, copyRevisionId: imageTask.currentCopyRevisionId,
    result: { images: imageTask.assets.map((asset, index) => ({ assetId: asset.id, pageIndex: index + 1 })),
      imageSettings: DEFAULT_IMAGE_SETTINGS, imagePlan: structuredClone(plan) } }];
  tasks.push(imageTask);
  const { default: sharp } = await import('sharp');
  const fixtureImages = await Promise.all([1, 2, 3].map(index => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#eee5dc"/><rect x="55" y="190" width="490" height="480" rx="24" fill="#fffaf4"/><circle cx="300" cy="400" r="130" fill="#91ad99"/><text x="55" y="95" font-family="sans-serif" font-size="26" fill="#344039">LOCAL TEST IMAGE ${index}</text></svg>`)).png().toBuffer()));
  const requests = [], unexpected = [], externalRequests = [], errors = [];
  const workUser = { id: 8, username: 'worker', role: 'USER', status: 'ACTIVE', credentialVersion: 1, copyReviewEnabled: true };
  const repository = { getUserByUsername: async () => workUser, listTasks: async options => {
    const rows = tasks.filter(task => options.states.split(',').includes(task.state)
      && task.assignedToUserId === options.assignedToUserId && task.assignedToAccountId === options.assignedToAccountId
      && !task.priorityPaused && (options.taskId === undefined || task.id === options.taskId));
    return { total: rows.length, items: rows.slice(options.offset, options.offset + options.limit) };
  } };
  const server = createServer(async (req, res) => {
    const reply = (data, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(status === 200 ? { data } : { error: { code: 'FIXTURE', message: data } })); };
    try {
      if (req.url === '/bundle.js') { res.setHeader('content-type', 'application/javascript'); res.end(js); return; }
      if (req.url === '/bundle.css') { res.setHeader('content-type', 'text/css'); res.end(css); return; }
      if (!req.url.startsWith('/api/')) { res.setHeader('content-type', 'text/html');
        res.end('<html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script src="/bundle.js"></script></html>'); return; }
      const url = new URL(req.url, 'http://localhost'), pathname = url.pathname;
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ path: pathname, method: req.method, body });
      const assetMatch = pathname.match(/\/assets\/(140[1-3])$/u);
      if (assetMatch) { res.setHeader('content-type', 'image/png'); res.end(fixtureImages[Number(assetMatch[1]) - 1401]); return; }
      if (pathname === '/api/human-quality-settings') { reply(DEFAULT_HUMAN_QUALITY_SETTINGS); return; }
      if (pathname.endsWith('/work-mode/items')) {
        reply(await loadWorkModePage(repository, { kind: url.searchParams.get('kind'), offset: Number(url.searchParams.get('offset')),
          limit: Number(url.searchParams.get('limit')), ...(url.searchParams.has('itemId') ? { itemId: url.searchParams.get('itemId') } : {}) },
        { ...workUser, userId: workUser.id })); return;
      }
      const match = pathname.match(/\/tasks\/(\d+)(?:\/(.*))?$/u);
      if (match) {
        const task = tasks.find(item => item.id === Number(match[1])), action = match[2];
        if (!action) { reply(task); return; }
        if (action === 'copy-review-drafts' && req.method === 'GET') { reply({ baseCopyRevisionId: task.currentCopyRevisionId, drafts: [] }); return; }
        if (action === 'image-capabilities') { reply({ version: 1, reviewImagePlanEdits: true }); return; }
        if (action === 'image-edits') { reply([]); return; }
        if (action === 'approve-copy' && req.method === 'POST') {
          assert.equal(body.decision, 'APPROVE'); task.state = 'COPY_QC_PENDING'; reply(task); return;
        }
      }
      unexpected.push(`${req.method} ${pathname}`); reply(`未配置的测试接口 ${pathname}`, 404);
    } catch (error) { reply(error.message, 500); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  let browser, page;
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.WORK_MODE_BROWSER_CHANNEL || 'msedge' });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route('**/*', route => {
      if (route.request().url().startsWith(origin)) return route.continue();
      externalRequests.push(route.request().url()); return route.abort();
    });
    await page.goto(origin); await page.locator('#review-copy-title').waitFor();
    const card = page.getByRole('region', { name: '二次分配历史质检反馈', exact: true });
    const queue = page.getByRole('complementary', { name: '待处理作业' });
    const submissions = () => requests.filter(request => request.path.endsWith('/approve-copy'));
    const selectTask = async id => {
      await queue.getByRole('button', { name: new RegExp(`#${id}\\b`, 'u') }).click();
      await page.waitForFunction(expected => document.querySelector('#review-copy-title')?.value === expected, `桌面收纳文案 ${id}`);
    };
    const assertLayout = async desktop => {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'page fits horizontally');
      const scrollers = await card.evaluate(element => [...element.querySelectorAll('*'), element].filter(node => {
        const style = getComputedStyle(node);
        return ['auto', 'scroll'].includes(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
      }).map(node => node.className));
      assert.deepEqual(scrollers, [], 'history creates no inner vertical scrollbar');
      if (desktop) {
        const button = await page.getByRole('button', { name: /^(提交并下一条|提交审核并下一条)$/u }).boundingBox();
        assert.ok(button && button.y >= 0 && button.y + button.height <= page.viewportSize().height, 'desktop submit remains in the viewport');
      }
    };
    assert.equal(await card.isVisible(), true);
    assert.equal(await card.getByText(first.secondaryAssignmentFeedback.entries[0].note, { exact: true }).isVisible(), true);
    assert.equal(await card.getByText(first.secondaryAssignmentFeedback.entries[1].note, { exact: true }).isVisible(), false);
    assert.equal(await queue.getByRole('button', { name: /#108.*需要返工/u }).count(), 0);
    const initialSubmit = page.getByRole('button', { name: '提交并下一条', exact: true });
    assert.equal(await initialSubmit.isDisabled(), true, 'secondary assignment still requires the original rating');
    assert.equal(await page.locator('#review-copy-title').getAttribute('readonly') !== null, true);
    const historyToggle = card.getByRole('button', { name: '查看此前 1 次反馈', exact: true });
    assert.equal(await historyToggle.getAttribute('type'), 'button'); await historyToggle.click();
    assert.equal(await card.getByText(first.secondaryAssignmentFeedback.entries[1].note, { exact: true }).isVisible(), true);
    assert.equal(submissions().length, 0, 'history interaction cannot submit the review form');
    await assertLayout(true);
    await page.locator('#review-copy-pane').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: join(directory, '108-desktop-history.png'), fullPage: true });
    await selectTask(236); await card.getByRole('button', { name: '展开完整说明', exact: true }).waitFor();
    await page.locator('#review-copy-pane').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: join(directory, '236-desktop-collapsed-feedback.png'), fullPage: true });
    const expandNote = card.getByRole('button', { name: '展开完整说明', exact: true });
    assert.equal(await expandNote.getAttribute('type'), 'button'); await expandNote.click();
    assert.equal(await card.getByText(longNote, { exact: true }).isVisible(), true);
    assert.equal(await card.locator('img,script').count(), 0, 'historical HTML is rendered as escaped text');
    assert.equal(await page.evaluate(() => window.__feedbackInjected), undefined);
    assert.equal(submissions().length, 0, 'long-note interaction cannot submit the review form');
    await assertLayout(true);
    await page.locator('#review-copy-pane').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: join(directory, '236-desktop-long-feedback.png'), fullPage: true });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 }); await assertLayout(false);
      await page.screenshot({ path: join(directory, `236-mobile-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await selectTask(108);
    assert.equal(await card.getByRole('button', { name: '查看此前 1 次反馈', exact: true }).getAttribute('aria-expanded'), 'false', 'task navigation resets history expansion');
    await selectTask(236);
    assert.equal(await card.getByRole('button', { name: '展开完整说明', exact: true }).getAttribute('aria-expanded'), 'false', 'task navigation resets note expansion');
    await selectTask(950);
    assert.equal(await card.count(), 0, 'ordinary return has no secondary-assignment history card');
    const currentRequirement = page.locator('.workbench-rework-requirements');
    assert.equal(await currentRequirement.getByText(regularReturn.copyRevisions[0].reworkNote, { exact: true }).isVisible(), true);
    assert.equal(await queue.getByRole('button', { name: /#950.*需要返工/u }).count(), 1);
    await selectTask(237);
    assert.equal(await card.getByText(returnedAgain.secondaryAssignmentFeedback.entries[0].note, { exact: true }).isVisible(), true);
    assert.equal(await currentRequirement.getByText(returnedAgain.copyRevisions[0].reworkNote, { exact: true }).isVisible(), true);
    assert.equal(await queue.getByRole('button', { name: /#237.*需要返工/u }).count(), 1);
    const returnSubmit = page.getByRole('button', { name: '提交审核并下一条', exact: true });
    assert.equal(await returnSubmit.isDisabled(), true, 'history does not satisfy the required actual rework');
    assert.equal(await page.locator('#review-copy-title').getAttribute('readonly'), null, 'the current returned draft can be edited');
    await page.locator('#review-copy-title').fill('修正数量后的桌面收纳');
    await page.waitForFunction(() => {
      const button = document.querySelector('.workbench-review-footer button[type="submit"]');
      return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
    });
    await assertLayout(true);
    await page.locator('#review-copy-pane').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: join(directory, '237-desktop-history-and-current-rework.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 1040 });
    await page.screenshot({ path: join(directory, '237-desktop-tall-history-and-current-rework.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 720 });
    await selectTask(108);
    assert.equal(await initialSubmit.isDisabled(), true);
    await page.locator('input[type="radio"][value="3"]').check();
    await initialSubmit.click();
    await page.waitForFunction(() => document.querySelector('#review-copy-title')?.value === '桌面收纳文案 236');
    const submitted = submissions(); assert.equal(submitted.length, 1);
    assert.equal(submitted[0].path, '/api/control-plane/v1/tasks/108/approve-copy');
    assert.equal(submitted[0].body.score, 3);
    assert.equal(Object.hasOwn(submitted[0].body, 'originalScore'), false, 'an untouched original keeps the existing single-score payload');
    assert.equal(Object.hasOwn(submitted[0].body, 'edits'), false, 'reading historical feedback does not create an edited revision');
    assert.equal(submitted[0].body.decision, 'APPROVE');
    assert.doesNotMatch(JSON.stringify(submitted[0].body), /secondaryAssignmentFeedback|reasonLabels|最近反馈|早期反馈/u, 'history never enters the mutation payload');
    assert.equal(first.state, 'COPY_QC_PENDING');
    await page.getByRole('group', { name: '作业类型' }).getByRole('button', { name: /图片作业/u }).click();
    await page.getByRole('heading', { name: '图片初审详情', exact: true }).waitFor();
    assert.equal(await page.locator('#review-copy-title, #review-plan-pane').count(), 0, 'the image-mode editor stays intact');
    assert.equal(await card.count(), 1, 'image work displays history once in the image information panel');
    const imagePanel = page.getByRole('complementary', { name: '图片操作与信息', exact: true });
    assert.equal(await imagePanel.getByRole('region', { name: '二次分配历史质检反馈', exact: true }).count(), 1);
    assert.equal(await card.getByText('最近一次 · 图片质检', { exact: true }).isVisible(), true);
    assert.equal(await card.getByText('图片 · 文字可读性', { exact: true }).isVisible(), true);
    const beforeImageHistory = requests.filter(request => request.method === 'POST').length;
    await card.getByRole('button', { name: '查看此前 1 次反馈', exact: true }).click();
    assert.equal(await card.getByText(imageTask.secondaryAssignmentFeedback.entries[1].note, { exact: true }).isVisible(), true);
    assert.equal(requests.filter(request => request.method === 'POST').length, beforeImageHistory, 'image history never submits the image review');
    assert.equal(await page.getByRole('button', { name: '提交并下一条', exact: true }).isDisabled(), false, 'image self-review submission remains available');
    const imageToolbar = page.getByRole('group', { name: '当前图片操作', exact: true });
    assert.equal(await imageToolbar.getByRole('button', { name: '修改图片', exact: true }).isEnabled(), true);
    await page.getByRole('button', { name: /^下一张图片，第 02 页/u }).click();
    assert.equal(await page.getByRole('button', { name: /^选择第 2 页/u }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: /^放大查看第 2 页/u }).click();
    await page.getByRole('dialog').waitFor(); await page.keyboard.press('Escape');
    await page.locator('.image-preview-dialog').waitFor({ state: 'detached' });
    await assertLayout(true); await imagePanel.evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: join(directory, '238-image-desktop-history.png'), fullPage: true });
    await page.setViewportSize({ width: 320, height: 900 }); await assertLayout(false);
    assert.equal(await card.count(), 1);
    assert.equal(await imageToolbar.getByRole('button', { name: '修改图片', exact: true }).isVisible(), true);
    await page.screenshot({ path: join(directory, '238-image-mobile-320.png'), fullPage: true });
    assert.equal(requests.filter(request => request.method === 'POST').length, beforeImageHistory);
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); assert.deepEqual(externalRequests, []);
    console.log(`secondary assignment feedback screenshots: ${directory}`);
  } catch (error) {
    if (page) await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    console.log(`secondary assignment feedback browser artifacts: ${directory}`); throw error;
  } finally {
    await browser?.close(); await new Promise(done => server.close(done));
  }
});
