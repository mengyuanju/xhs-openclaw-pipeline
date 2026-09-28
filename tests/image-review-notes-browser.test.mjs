import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { DEFAULT_HUMAN_QUALITY_SETTINGS } from '../src/human-quality-settings.mjs';
import { DEFAULT_IMAGE_SETTINGS } from '../server/src/image-options.mjs';

test('image self-review notes retain failed edits and same-version rework submits mandatory rechecks', {
  skip: process.env.RUN_IMAGE_REVIEW_NOTES_BROWSER !== '1', timeout: 120_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const { default: sharp } = await import('sharp');
  const output = resolve('.codex_artifacts/image-review-notes');
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, 'browser-'));
  const bundle = join(directory, 'bundle.js');
  let browser;
  let page;
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
      import styles from './app/work-mode/work-mode.module.css';
      function Fixture() {
        const embedded=new URLSearchParams(location.search).get('embedded')!=='false';
        const [taskId,setTaskId]=React.useState(41);
        const guard=React.useRef(null);
        return <div className={styles.page}>
          <div style={{display:'flex',gap:12,padding:12,flexWrap:'wrap'}}>
            <button type="button" onClick={async()=>{
              if(!guard.current||await guard.current())setTaskId(current=>current===41?42:41);
            }}>切换测试任务</button>
            {taskId===null&&<button type="button" onClick={()=>setTaskId(41)}>重新打开测试任务</button>}
          </div>
          <main className={styles.editor}>
            {taskId!==null?<TaskReviewDialog key={taskId} embedded={embedded} taskId={taskId}
              nodeId="local-note-fixture" role="USER" currentUsername="reviewer" currentAccountId={7}
              navigationGuardRef={guard} onOpenChange={open=>{if(!open)setTaskId(null)}}
              onUpdated={async()=>{}}/>:<p role="status">测试审核窗口已关闭</p>}
          </main>
        </div>;
      }
      createRoot(document.getElementById('root')).render(
        <ConfirmDialogProvider><TextInputDialogProvider>
          <BackgroundTasksProvider accountKey="image-review-note-fixture" accountUsername="reviewer" accountId={7}>
            <Fixture/><Toaster/>
          </BackgroundTasksProvider>
        </TextInputDialogProvider></ConfirmDialogProvider>);
    `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, outfile: bundle,
    jsx: 'automatic', platform: 'browser', conditions: ['style'], alias: { '@': process.cwd() },
    define: { 'process.env.NODE_ENV': '"test"', 'process.env': '{}' } });
    const [js, rawCss] = await Promise.all([
      readFile(bundle), readFile(join(directory, 'bundle.css'), 'utf8'),
    ]);
    const { default: postcss } = await import('postcss');
    const { default: tailwind } = await import('@tailwindcss/postcss');
    const { css } = await postcss([tailwind()]).process(rawCss, { from: join(process.cwd(), 'app/globals.css') });
    const png = await sharp({ create: { width: 600, height: 800, channels: 4, background: '#e6efe9' } })
      .png().toBuffer();
    const oldImageRunId = randomUUID();
    const imageRunId = randomUUID();
    const oldNote = '旧图第 1 页：替换旧包装，仅属于历史图集。';
    const plan = ['hero', 'steps', 'summary'].map((kind, index) => ({ kind,
      headline: `桌面收纳第 ${index + 1} 页`, subtitle: '', bullets: ['分类整理', '预留空间'],
      prompt: '整洁桌面与柔和自然光，画面文字清晰可读。', layout: { mode: 'AUTO' },
    }));
    const makeTask = id => ({ id, query: `本地图片备注测试 ${id}`, state: 'MANUAL_ARCHIVE',
      assignedToUserId: 'reviewer', assignedToAccountId: 7,
      aiDisclosureEnabled: false, currentCopyRevisionId: 12, currentImageRunId: imageRunId,
      currentExecutionId: null, priorityPaused: false, xiaohongshuLinks: [],
      copyRevisions: [{ id: 12, revision: 1, approvedAt: '2026-09-28T01:00:00.000Z',
        content: { copy: { title: '桌面收纳', body: '常用物品分类放在手边。', tags: ['桌面收纳'] },
          imagePlan: structuredClone(plan), imageSettings: DEFAULT_IMAGE_SETTINGS } }],
      imageRuns: [{ id: imageRunId, result: { imageSettings: DEFAULT_IMAGE_SETTINGS,
        imagePlan: structuredClone(plan), images: [401, 402, 403].map((assetId, index) => ({ assetId, pageIndex: index + 1 })) } }],
      assets: [401, 402, 403].map((assetId, index) => ({ id: assetId, imageRunId,
        mediaType: 'image/png', sha256: 'a'.repeat(64), originalName: `${index + 1}.png`, url: `/v1/assets/${assetId}` })),
      humanQualityAssessments: [],
      imageApprovalEvents: [{ id: randomUUID(), imageRunId: oldImageRunId, copyRevisionId: 12,
        manualModificationNote: oldNote, submittedAt: '2026-09-27T01:00:00.000Z' }],
    });
    const tasks = new Map([[41, makeTask(41)], [42, makeTask(42)]]);
    const requests = [];
    const unexpectedRequests = [];
    let failSubmit = true;
    let pendingEdits = [];
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const path = url.pathname;
        if (path === '/bundle.js') { res.setHeader('content-type', 'application/javascript'); res.end(js); return; }
        if (path === '/bundle.css') { res.setHeader('content-type', 'text/css'); res.end(css); return; }
        if (path === '/favicon.ico') { res.statusCode = 204; res.end(); return; }
        if (path === '/') {
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/bundle.css"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
          return;
        }
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = raw ? JSON.parse(raw) : null;
        requests.push({ method: req.method, path, body });
        const reply = (data, status = 200) => {
          res.statusCode = status; res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(status >= 400 ? { error: { code: 'TEST_FAILURE', message: data } } : { data }));
        };
        if (path.includes('/assets/')) { res.setHeader('content-type', 'image/png'); res.end(png); return; }
        if (path === '/api/human-quality-settings') { reply(DEFAULT_HUMAN_QUALITY_SETTINGS); return; }
        const match = path.match(/\/tasks\/(41|42)(?:\/(.*))?$/u);
        if (match) {
          const task = tasks.get(Number(match[1]));
          const action = match[2];
          if (!action) { reply(task); return; }
          if (action === 'image-capabilities') { reply({ version: 1, reviewImagePlanEdits: true }); return; }
          if (action === 'image-edits') { reply(pendingEdits); return; }
          if (action === 'image-edits/resolve-pending' && req.method === 'POST') {
            const accepted = body.decisions.filter(decision => decision.action === 'accept');
            if (accepted.length) {
              const sourceImageRunId = task.currentImageRunId;
              const next = structuredClone(task.imageRuns.find(run => run.id === sourceImageRunId));
              task.currentImageRunId = randomUUID(); next.id = task.currentImageRunId;
              const nextAssets = task.assets.filter(asset => asset.imageRunId === sourceImageRunId)
                .map(asset => ({ ...asset, imageRunId: task.currentImageRunId }));
              for (const decision of accepted) {
                const edit = pendingEdits.find(item => item.id === decision.id);
                const assetId = edit.result.asset_id;
                next.result.images[edit.target_page - 1] = { assetId, pageIndex: edit.target_page };
                nextAssets[edit.target_page - 1] = { ...nextAssets[edit.target_page - 1],
                  id: assetId, url: `/v1/assets/${assetId}` };
              }
              task.imageRuns.unshift(next); task.assets.push(...nextAssets);
            }
            pendingEdits = pendingEdits.filter(edit => !body.decisions.some(decision => decision.id === edit.id));
            reply({ imageRunId: task.currentImageRunId, processed: body.decisions.length }); return;
          }
          if (action === 'submit-image-self-review' && req.method === 'POST') {
            if (failSubmit) { reply('本地测试提交失败，备注应保留', 409); return; }
            const requiresRecheck = task.state === 'IMAGE_REWORK_PENDING' || task.mandatoryImageQc === true;
            task.state = requiresRecheck ? 'IMAGE_QC_PENDING' : 'REVIEWED';
            task.deliveryStatus = requiresRecheck ? null : 'READY';
            task.mandatoryImageQc = requiresRecheck;
            task.imageApprovalEvents.unshift({ id: randomUUID(), imageRunId: body.imageRunId,
              copyRevisionId: task.currentCopyRevisionId, manualModificationNote: body.manualModificationNote,
              submittedAt: new Date().toISOString() });
            reply(task); return;
          }
        }
        unexpectedRequests.push(`${req.method} ${path}`);
        reply(`未配置的本地测试接口 ${path}`, 404);
      } catch (error) {
        res.statusCode = 500; res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { code: 'FIXTURE', message: error.message } }));
      }
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, channel: process.env.IMAGE_REVIEW_NOTES_BROWSER_CHANNEL || 'msedge' });
    page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    const errors = [];
    const consoleErrors = [];
    const externalRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', entry => { if (entry.type() === 'error') consoleErrors.push(entry.text()); });
    await page.route('**/*', route => {
      if (route.request().url().startsWith(`${base}/`)) return route.continue();
      externalRequests.push(route.request().url()); return route.abort();
    });
    await page.goto(base);
    const note = page.getByLabel(/^图片审核备注（选填）/u);
    const explanation = '如需手动修改图片请备注具体点位，图片质检可先通过，后续自行修改后小豆芽替换';
    await note.waitFor();
    assert.equal(await note.inputValue(), '', 'historical image notes do not become a new version draft');
    assert.equal(await note.getAttribute('maxlength'), '1000');
    assert.equal(await page.getByText(explanation, { exact: true }).count(), 1);
    const rawNote = '  第 1 页右下角：替换为新版包装。\n第 2 页标题第二行：修正“分类”的错字。  ';
    const savedNote = rawNote.trim();
    await note.fill(rawNote);
    const assertViewportFits = async label => {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert.ok(overflow <= 1, `${label} has no horizontal overflow: ${overflow}px`);
      await note.scrollIntoViewIfNeeded();
      const bounds = await note.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize().width + 1,
        `${label} note input remains within the viewport: ${JSON.stringify(bounds)}`);
      await page.screenshot({ path: join(directory, `${label}.png`), fullPage: true, animations: 'disabled' });
    };
    await assertViewportFits('desktop-note');
    await page.setViewportSize({ width: 390, height: 844 });
    await assertViewportFits('mobile-note');
    assert.equal(await page.getByText(explanation, { exact: true }).count(), 1, 'guidance stays visible after typing');
    await page.setViewportSize({ width: 1366, height: 900 });

    // Leaving requires a choice; cancelling keeps the current note and task.
    await page.getByRole('button', { name: '切换测试任务', exact: true }).click();
    const leave = page.getByRole('alertdialog');
    await leave.waitFor();
    await leave.getByRole('button', { name: '继续填写', exact: true }).click();
    assert.equal(await note.inputValue(), rawNote);
    assert.equal(requests.some(request => request.path.endsWith('/tasks/42')), false);
    await page.getByRole('button', { name: '暂跳过', exact: true }).click();
    await leave.waitFor();
    await leave.getByRole('button', { name: '继续填写', exact: true }).click();
    assert.equal(await note.inputValue(), rawNote);

    const submit = async ({ recheck = false, embedded = true } = {}) => {
      await page.getByRole('button', { name: embedded ? '提交并下一条'
        : recheck ? '提交图片复检' : '初审完成，提交图片抽检', exact: true }).click();
      const confirm = page.getByRole('alertdialog', { name: recheck ? '确认提交图片复检？' : '确认完成图片初审？' });
      await confirm.getByRole('button', { name: recheck ? '提交图片复检' : '提交图片抽检', exact: true }).click();
    };
    const failedFeedback = page.getByRole('alert').filter({ hasText: '本地测试提交失败，备注应保留' });
    await submit();
    await failedFeedback.waitFor();
    assert.equal(await note.inputValue(), rawNote, 'failure preserves the editable multiline note');
    const submissions = () => requests.filter(request => request.path.endsWith('/submit-image-self-review'));
    const first = submissions()[0].body;
    assert.equal(first.manualModificationNote, savedNote);
    assert.equal(first.imageRunId, imageRunId);
    assert.match(first.reviewSessionId, /^[a-f0-9-]{36}$/u);
    await submit();
    await failedFeedback.waitFor();
    assert.equal(submissions().length, 2);
    assert.deepEqual(submissions()[1].body, first, 'an unchanged failed payload retains its review session');

    // A changed review gets a new identity; retrying that exact review reuses it.
    const changedRawNote = `${rawNote}\n第 2 页底部：对齐文字与按钮。  `;
    const changedSavedNote = changedRawNote.trim();
    await note.fill(changedRawNote);
    await submit();
    await failedFeedback.waitFor();
    const changed = submissions()[2].body;
    assert.notEqual(changed.reviewSessionId, first.reviewSessionId);
    assert.equal(changed.manualModificationNote, changedSavedNote);
    failSubmit = false;
    await submit();
    await page.getByText('测试审核窗口已关闭', { exact: true }).waitFor();
    assert.deepEqual(submissions()[3].body, changed);
    await page.getByRole('button', { name: '重新打开测试任务', exact: true }).click();
    await page.getByText(changedSavedNote, { exact: true }).waitFor();
    assert.equal(await page.getByLabel(/^图片审核备注（选填）/u).count(), 0,
      'the delivered review note is shown read-only');
    assert.equal(await page.getByText(oldNote, { exact: true }).count(), 0,
      'the current review shows the note from the current image version');
    await page.screenshot({ path: join(directory, 'delivered-note.png'), fullPage: true, animations: 'disabled' });

    // Replacing the image keeps historical notes but starts the next self-review empty.
    const task = tasks.get(41);
    const nextImageRunId = randomUUID();
    task.state = 'MANUAL_ARCHIVE'; task.deliveryStatus = null; task.currentImageRunId = nextImageRunId;
    const nextRun = structuredClone(task.imageRuns[0]); nextRun.id = nextImageRunId;
    task.imageRuns.unshift(nextRun);
    for (const asset of task.assets) asset.imageRunId = nextImageRunId;
    await page.reload();
    await note.waitFor();
    assert.equal(await note.inputValue(), '', 'a replaced image version requires its own manual note');
    assert.equal(task.imageApprovalEvents.length, 2, 'historical submitted notes remain in the fixture');

    // Pending-edit adoption changes the image version: the old draft stays visible
    // for an explicit choice, while automatic self-review is stopped.
    const pendingNote = '第 1 页右下角：手动对齐新版包装，第二页标题待自行修正。';
    await note.fill(pendingNote);
    pendingEdits = [{ id: randomUUID(), version: 1, status: 'PREVIEW_READY', target_page: 1,
      source_asset_id: 401, source_image_run_id: task.currentImageRunId, copy_revision_id: 12,
      operation: 'AI_LOCAL', config: { instruction: '本地预览替换第一张产品包装' },
      result: { asset_id: 501, validation: { passed: true, mock: false } } }];
    const beforePending = submissions().length;
    await page.getByRole('button', { name: '提交并下一条', exact: true }).click();
    const pendingDialog = page.getByRole('dialog', { name: '集中处理图片修改', exact: true });
    await pendingDialog.getByRole('button', { name: '一键采用 1 项', exact: true }).click();
    const previousNote = page.locator('.workbench-image-manual-note-previous');
    await previousNote.waitFor();
    await pendingDialog.waitFor({ state: 'hidden' });
    assert.equal(await note.isDisabled(), true, 'the new input waits for an explicit old-note choice');
    assert.equal(await note.inputValue(), '', 'a pending edit starts a new image version without silently copying a draft');
    assert.equal(await previousNote.getByText(pendingNote, { exact: true }).count(), 1,
      'the unsubmitted old-version note remains visible after adopting the image edit');
    assert.equal(submissions().length, beforePending, 'adoption does not silently submit the new version');
    assert.equal(await page.getByRole('alertdialog', { name: '确认完成图片初审？' }).count(), 0,
      'adoption stops automatic review until the old draft is handled');
    assert.notEqual(task.currentImageRunId, nextImageRunId);
    await page.screenshot({ path: join(directory, 'pending-version-note.png'), fullPage: true, animations: 'disabled' });
    await previousNote.getByRole('button', { name: '沿用到当前图集', exact: true }).click();
    assert.equal(await note.inputValue(), pendingNote);
    assert.equal(await previousNote.count(), 0);
    await submit();
    await page.getByText('测试审核窗口已关闭', { exact: true }).waitFor();
    const adoptedReview = submissions().at(-1).body;
    assert.equal(adoptedReview.imageRunId, task.currentImageRunId);
    assert.equal(adoptedReview.manualModificationNote, pendingNote);
    assert.notEqual(adoptedReview.reviewSessionId, changed.reviewSessionId);

    // A new browser client connected to an old center must refuse to lose notes.
    task.state = 'MANUAL_ARCHIVE'; task.deliveryStatus = null;
    delete task.imageApprovalEvents;
    await page.reload();
    await note.waitFor();
    const oldCenterNote = '旧中心版本不应丢失这条待提交的修图备注。';
    await note.fill(oldCenterNote);
    const beforeOldCenter = submissions().length;
    await page.getByRole('button', { name: '提交并下一条', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '中心服务尚不支持保存图片审核备注' }).waitFor();
    assert.equal(await note.inputValue(), oldCenterNote);
    assert.equal(submissions().length, beforeOldCenter, 'unsupported centers never receive a nonempty note submission');

    const closeDirtyReview = async () => {
      await page.getByRole('button', { name: '暂跳过', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: '放弃并关闭', exact: true }).click();
      await page.getByText('测试审核窗口已关闭', { exact: true }).waitFor();
    };
    const reopenReview = async () => {
      await page.getByRole('button', { name: '重新打开测试任务', exact: true }).click();
    };
    await closeDirtyReview();

    // Rework can submit the current image set without an edit or a manual note.
    task.state = 'IMAGE_REWORK_PENDING'; task.imageApprovalEvents = [];
    await reopenReview();
    await note.waitFor();
    assert.equal(await note.isDisabled(), false, 'the assigned operator may draft notes during image rework');
    assert.equal(await note.inputValue(), '');
    assert.equal(await page.getByText(explanation, { exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '提交并下一条', exact: true }).isDisabled(), false,
      'rework does not require an adopted image or a note before submission');
    const reworkImageRunId = task.currentImageRunId;
    const reworkImages = structuredClone(task.imageRuns.find(run => run.id === reworkImageRunId).result.images);
    const imageResolutions = () => requests.filter(request => request.path.endsWith('/image-edits/resolve-pending'));
    const beforeEmptyRecheck = submissions().length;
    const beforeReworkResolutions = imageResolutions().length;
    await page.screenshot({ path: join(directory, 'rework-empty-submit.png'), fullPage: true, animations: 'disabled' });
    await submit({ recheck: true });
    await page.getByText('测试审核窗口已关闭', { exact: true }).waitFor();
    assert.equal(submissions().length, beforeEmptyRecheck + 1);
    assert.equal(submissions().at(-1).body.imageRunId, reworkImageRunId);
    assert.equal(submissions().at(-1).body.manualModificationNote, '');
    assert.equal(task.state, 'IMAGE_QC_PENDING', 'same-version rework always enters mandatory image QA');
    assert.equal(task.deliveryStatus, null, 'same-version rework cannot enter the delivery pool');
    assert.equal(task.mandatoryImageQc, true);
    assert.equal(task.currentImageRunId, reworkImageRunId);
    assert.deepEqual(task.imageRuns.find(run => run.id === reworkImageRunId).result.images, reworkImages);
    assert.equal(imageResolutions().length, beforeReworkResolutions,
      'an empty-note recheck does not require an image edit or adoption request');

    // Rework notes retain the same draft and request identity across failed retries.
    task.state = 'IMAGE_REWORK_PENDING';
    await reopenReview();
    await note.waitFor();
    const decision = page.locator('.workbench-image-review-decision');
    const [noteBox, qualityBox] = await Promise.all([
      decision.locator('.workbench-image-manual-note').boundingBox(),
      decision.locator('.workbench-quality-summary').boundingBox(),
    ]);
    assert.ok(noteBox && qualityBox && noteBox.y + noteBox.height <= qualityBox.y + 1,
      'manual review notes appear above automatic quality evidence');
    const reworkDraft = '返修草稿：第 1 页包装边缘需要手动修整，第 2 页标题修改错字。';
    await note.fill(reworkDraft);
    await page.getByRole('status').filter({ hasText: '图片审核备注尚未提交' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '提交并下一条', exact: true }).isDisabled(), false,
      'a rework draft may submit the current image set directly');
    await page.getByRole('button', { name: '暂跳过', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '继续填写', exact: true }).click();
    assert.equal(await note.inputValue(), reworkDraft, 'cancelled rework navigation retains the draft');
    const beforeReworkNote = submissions().length;
    await page.screenshot({ path: join(directory, 'rework-note.png'), fullPage: true, animations: 'disabled' });
    pendingEdits = [{ id: randomUUID(), version: 1, status: 'PREVIEW_READY', target_page: 1,
      source_asset_id: 501, source_image_run_id: reworkImageRunId, copy_revision_id: 12,
      operation: 'AI_LOCAL', config: { instruction: '不采用的返修预览' },
      result: { asset_id: 601, validation: { passed: true, mock: false } } }];
    failSubmit = true;
    await page.getByRole('button', { name: '提交并下一条', exact: true }).click();
    await pendingDialog.waitFor();
    assert.equal(submissions().length, beforeReworkNote, 'unresolved image edits still block a rework submission');
    assert.equal(await page.getByRole('alertdialog', { name: '确认提交图片复检？' }).count(), 0);
    await pendingDialog.getByRole('button', { name: '一键拒绝 1 项', exact: true }).click();
    const recheckConfirm = page.getByRole('alertdialog', { name: '确认提交图片复检？' });
    await recheckConfirm.waitFor();
    assert.equal(task.currentImageRunId, reworkImageRunId, 'rejecting an edit preserves the current image version');
    assert.equal(await note.inputValue(), reworkDraft);
    assert.deepEqual(imageResolutions().at(-1).body.decisions.map(item => item.action), ['reject']);
    await recheckConfirm.getByRole('button', { name: '提交图片复检', exact: true }).click();
    await failedFeedback.waitFor();
    const reworkSubmission = submissions().at(-1).body;
    assert.equal(reworkSubmission.imageRunId, reworkImageRunId);
    assert.equal(reworkSubmission.manualModificationNote, reworkDraft);
    assert.equal(await note.inputValue(), reworkDraft, 'failed rework preserves the manual modification note');
    await submit({ recheck: true });
    await failedFeedback.waitFor();
    assert.deepEqual(submissions().at(-1).body, reworkSubmission,
      'an unchanged failed rework submission retains its review session');
    failSubmit = false;
    await submit({ recheck: true });
    await page.getByText('测试审核窗口已关闭', { exact: true }).waitFor();
    assert.equal(submissions().length, beforeReworkNote + 3);
    assert.deepEqual(submissions().at(-1).body, reworkSubmission);
    assert.equal(task.state, 'IMAGE_QC_PENDING');
    assert.equal(task.deliveryStatus, null);
    assert.equal(task.currentImageRunId, reworkImageRunId);
    assert.deepEqual(task.imageRuns.find(run => run.id === reworkImageRunId).result.images, reworkImages);

    // Initial-review viewers without ownership still see the empty note area
    // and guidance, even when no previous review has submitted a note.
    task.state = 'MANUAL_ARCHIVE'; task.mandatoryImageQc = false; task.imageApprovalEvents = [];
    task.assignedToUserId = 'other-worker'; task.assignedToAccountId = 8;
    await reopenReview();
    const emptyReadonlyNote = page.getByRole('region', { name: '图片审核备注', exact: true });
    await emptyReadonlyNote.waitFor();
    assert.equal(await page.getByText(explanation, { exact: true }).count(), 1);
    assert.equal(await emptyReadonlyNote.getByRole('textbox').count(), 1,
      'non-assignees still see the empty note field');
    assert.equal(await note.evaluate(element => element.readOnly), true,
      'non-assignees cannot edit the self-review draft');
    assert.equal(await note.isDisabled(), false, 'read-only notes remain selectable');
    assert.equal(await note.inputValue(), '');
    assert.equal(await note.getAttribute('placeholder'), '暂未填写图片审核备注');
    await page.getByText('此任务的图片审核备注由任务负责人填写。', { exact: true }).waitFor();
    assert.equal(await page.getByText(pendingNote, { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '提交并下一条', exact: true }).count(), 0);
    await page.screenshot({ path: join(directory, 'non-owner-empty-note.png'), fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: '暂跳过', exact: true }).click();
    await page.getByText('测试审核窗口已关闭', { exact: true }).waitFor();

    // An initial-review task with no usable images must still expose the note
    // entry, while keeping image submission disabled until assets are complete.
    task.assignedToUserId = 'reviewer'; task.assignedToAccountId = 7;
    task.assets = [];
    task.imageRuns.find(run => run.id === task.currentImageRunId).result.images = [];
    await reopenReview();
    await note.waitFor();
    assert.equal(await note.isDisabled(), false, 'the note area remains usable when the image set is empty');
    assert.equal(await note.inputValue(), '');
    assert.equal(await page.getByText(explanation, { exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '提交并下一条', exact: true }).isDisabled(), true,
      'an empty image set cannot be approved by adding a note');
    await page.screenshot({ path: join(directory, 'no-assets-note.png'), fullPage: true, animations: 'disabled' });

    // The ordinary task-detail dialog uses the same visible initial/rework area
    // as work mode, so operators do not need to change entry points to write notes.
    const modalTask = makeTask(41);
    tasks.set(41, modalTask);
    await page.goto(`${base}/?embedded=false`);
    const initialModal = page.getByRole('dialog', { name: '图片初审详情', exact: true });
    await initialModal.waitFor();
    const assertModalNoteVisible = async (modal, label) => {
      const region = modal.getByRole('region', { name: '图片审核备注', exact: true });
      await region.waitFor();
      const input = region.getByLabel(/^图片审核备注（选填）/u);
      await input.scrollIntoViewIfNeeded();
      assert.equal(await input.isVisible(), true);
      assert.equal(await input.evaluate(element => element.readOnly), false);
      assert.equal(await input.isDisabled(), false);
      assert.equal(await region.getByText(explanation, { exact: true }).count(), 1);
      const bounds = await input.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize().width + 1
        && bounds.y >= 0 && bounds.y + bounds.height <= page.viewportSize().height + 1,
      `${label} places the note input inside the dialog viewport: ${JSON.stringify(bounds)}`);
      await page.screenshot({ path: join(directory, `${label}.png`), animations: 'disabled' });
      return input;
    };
    await assertModalNoteVisible(initialModal, 'modal-initial-note');
    assert.equal(await initialModal.getByRole('button', { name: '初审完成，提交图片抽检', exact: true }).isDisabled(), false);
    await initialModal.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByText('测试审核窗口已关闭', { exact: true }).waitFor();
    modalTask.state = 'IMAGE_REWORK_PENDING';
    await reopenReview();
    const reworkModal = page.getByRole('dialog', { name: '图片返修详情', exact: true });
    await reworkModal.waitFor();
    const modalReworkNote = await assertModalNoteVisible(reworkModal, 'modal-rework-note');
    const modalReworkDraft = '详情返修备注：第一张边缘补齐，第二张标题修正错字。';
    await modalReworkNote.fill(modalReworkDraft);
    assert.equal(await modalReworkNote.inputValue(), modalReworkDraft);
    assert.equal(await reworkModal.getByRole('button', { name: '提交图片复检', exact: true }).isDisabled(), false);
    const beforeModalRecheck = submissions().length;
    const beforeModalResolutions = imageResolutions().length;
    const modalImageRunId = modalTask.currentImageRunId;
    const modalImages = structuredClone(modalTask.imageRuns.find(run => run.id === modalImageRunId).result.images);
    await page.screenshot({ path: join(directory, 'modal-rework-submit.png'), animations: 'disabled' });
    await submit({ recheck: true, embedded: false });
    await page.getByText('测试审核窗口已关闭', { exact: true }).waitFor();
    assert.equal(submissions().length, beforeModalRecheck + 1);
    assert.equal(submissions().at(-1).body.imageRunId, modalImageRunId);
    assert.equal(submissions().at(-1).body.manualModificationNote, modalReworkDraft);
    assert.equal(modalTask.state, 'IMAGE_QC_PENDING', 'the ordinary detail dialog also submits mandatory image QA');
    assert.equal(modalTask.deliveryStatus, null);
    assert.equal(modalTask.currentImageRunId, modalImageRunId);
    assert.deepEqual(modalTask.imageRuns.find(run => run.id === modalImageRunId).result.images, modalImages);
    assert.equal(imageResolutions().length, beforeModalResolutions, 'ordinary rework submission also needs no new image');
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, [], 'the test only uses its temporary localhost server');
    assert.deepEqual(unexpectedRequests, []);
    assert.ok(consoleErrors.every(message => message.includes('409 (Conflict)')),
      `only deliberate fake submission failures may appear in the browser console: ${JSON.stringify(consoleErrors)}`);
    console.log(`Image review notes browser: no runtime errors; desktop/mobile no horizontal overflow; 5 deliberate failed submissions; pending-edit confirmation, old-center guard, embedded/modal same-version mandatory rechecks with optional notes and safe retries, empty read-only/no-asset note visibility verified. Screenshots: ${directory}`);
  } catch (error) {
    if (page) {
      await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => {});
      await writeFile(join(directory, 'failure.html'), await page.content());
    }
    console.error(`Image review notes failure artifacts: ${directory}`);
    throw error;
  } finally {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  }
});
