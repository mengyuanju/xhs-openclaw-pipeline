import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { DEFAULT_HUMAN_QUALITY_SETTINGS } from '../src/human-quality-settings.mjs';
import { DEFAULT_IMAGE_SETTINGS } from '../server/src/image-options.mjs';

const copy = {
  title: '国内国际坐飞机充电宝，4项要求',
  body: Array.from({ length: 6 }, (_, index) => `${index + 1}、合成审核布局要点\n充电宝随身携带，需要核对容量和产品标识。这里是隔离测试的合成正文，用来验证长文案、标签与评分区域不会被历史记录遮挡。`).join('\n\n'),
  tags: ['#充电宝', '#出行整理', '#合成测试'],
};
const revision = {
  id: 12, revision: 3, approvedAt: null,
  content: {
    copy, imageSettings: DEFAULT_IMAGE_SETTINGS,
    imagePlan: ['hero', 'steps', 'summary'].map((kind, index) => ({
      kind, headline: `合成第 ${index + 1} 页`, subtitle: '出行前核对四项要求',
      bullets: ['检查产品标识', '确认测试要求', '检查额定容量', '随身携带并遵守规定'],
      prompt: '隔离合成规划；不会调用任何模型',
    })),
  },
};
const task = {
  id: 41, query: '坐飞机时需要核对哪些充电宝要求', state: 'COPY_REVIEW_PENDING',
  assignedToUserId: 'reviewer', assignedToAccountId: 7,
  currentCopyRevisionId: 12, currentImageRunId: null, aiDisclosureEnabled: false,
  copyRevisions: [revision], imageRuns: [], assets: [], humanQualityAssessments: [],
};

async function bundleFixture(directory) {
  const { build } = await import('esbuild');
  await build({
    stdin: {
      contents: `import './app/globals.css';import React from 'react';import{createRoot}from'react-dom/client';import{TaskReviewDialog}from'./app/workbench/task-review-dialog';import{ConfirmDialogProvider}from'./components/ui/confirm-dialog';import{TextInputDialogProvider}from'./components/ui/text-input-dialog';import{BackgroundTasksProvider}from'./app/components/background-tasks';createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><TextInputDialogProvider><BackgroundTasksProvider accountKey="history-layout" accountUsername="reviewer" accountId={7}><TaskReviewDialog taskId={41} nodeId="fixture" role="ADMIN" currentUsername="reviewer" currentAccountId={7} onOpenChange={()=>{}} onUpdated={async()=>{}}/></BackgroundTasksProvider></TextInputDialogProvider></ConfirmDialogProvider>);`,
      resolveDir: process.cwd(), loader: 'tsx',
    },
    bundle: true, outfile: join(directory, 'bundle.js'), jsx: 'automatic', platform: 'browser',
    conditions: ['style'], alias: { '@': process.cwd() },
    define: { 'process.env.NODE_ENV': '"test"', 'process.env': '{}' },
  });
  const [{ default: postcss }, { default: tailwind }] = await Promise.all([
    import('postcss'), import('@tailwindcss/postcss'),
  ]);
  const rawCss = await readFile(join(directory, 'bundle.css'), 'utf8');
  const { css } = await postcss([tailwind()]).process(rawCss, { from: resolve('app/globals.css') });
  return { js: await readFile(join(directory, 'bundle.js')), css };
}

function serveFixture({ js, css }, requests) {
  return createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname;
    if (path === '/bundle.js' || path === '/bundle.css') {
      response.setHeader('content-type', path.endsWith('.js') ? 'application/javascript' : 'text/css');
      response.end(path.endsWith('.js') ? js : css);
      return;
    }
    if (!path.startsWith('/api/')) {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end('<html><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script src="/bundle.js"></script></html>');
      return;
    }
    requests.push({ method: request.method, path });
    const reply = (data, status = 200) => {
      response.statusCode = status;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(status >= 400 ? { error: { code: 'FIXTURE', message: data } } : { data }));
    };
    if (request.method !== 'GET') { reply('This layout fixture permits read-only requests only', 405); return; }
    if (path === '/api/human-quality-settings') { reply(DEFAULT_HUMAN_QUALITY_SETTINGS); return; }
    if (path === '/api/control-plane/health') { reply({ capabilities: { imageResume: true } }); return; }
    if (path.endsWith('/tasks/41')) { reply(task); return; }
    if (path.endsWith('/copy-review-drafts')) { reply({ baseCopyRevisionId: 12, drafts: [] }); return; }
    if (path.includes('/history/')) {
      const kind = path.split('/history/')[1].split('/')[0];
      if (path.endsWith('/copyRevisions/12')) reply({ item: revision, assets: [] });
      else if (path.endsWith('/assessments/801')) reply({ item: { id: 801, score: 2.5, action: 'APPROVE', note: '合成审核记录用于布局验证' } });
      else reply({ items: [{ id: kind === 'copyRevisions' ? 12 : 801, revision: kind === 'copyRevisions' ? 3 : undefined, score: 2.5, createdAt: '2026-10-02T08:00:00Z' }], hasMore: false, nextCursor: null });
      return;
    }
    reply(`Unexpected fixture request: ${path}`, 404);
  });
}

async function measureLayout(page) {
  return page.evaluate(() => {
    const scroll = document.querySelector('.workbench-review-scroll');
    const trigger = [...scroll.querySelectorAll('button')].find(element => element.textContent.includes('历史版本与审核记录'));
    const history = trigger.closest('.disclosure');
    const bounds = element => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height };
    };
    const panes = [...scroll.querySelectorAll(':scope > [data-review-pane]')]
      .filter(element => getComputedStyle(element).display !== 'none')
      .map(element => ({ name: element.dataset.reviewPane, ...bounds(element),
        contentBottom: Math.max(...[...element.children].map(child => child.getBoundingClientRect().bottom)),
      }));
    const sectionTitles = [...scroll.querySelectorAll('[data-review-pane] .workbench-review-section-title')]
      .filter(element => element.getBoundingClientRect().width > 0).map(bounds);
    return { scroll: { ...bounds(scroll), scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight },
      history: bounds(history), trigger: bounds(trigger), panes, sectionTitles, footer: bounds(document.querySelector('.workbench-review-footer')) };
  });
}

async function assertCompactCopyLayout(page, label) {
  const note = page.locator('#copy-original-41-note');
  assert.equal(await note.isVisible(), true, `${label}: compact original score always includes its explanation field`);
  const body = page.locator('#review-copy-body');
  for (const editor of await page.locator('.workbench-autosize-textarea:visible').all()) {
    await page.waitForFunction(id => {
      const element = document.getElementById(id);
      return element && element.scrollHeight <= element.clientHeight + 1;
    }, await editor.getAttribute('id'));
    assert.equal(await editor.evaluate(element => element.scrollHeight > element.clientHeight + 1), false,
      `${label}: the complete body and every bullet line remain visible`);
  }
  if (!(await body.isVisible())) return;
  await page.waitForFunction(() => {
    const editor = document.querySelector('#review-copy-body');
    const scroll = document.querySelector('.workbench-review-scroll');
    const columns = getComputedStyle(scroll).gridTemplateColumns.trim().split(/\s+/u).length;
    const plan = document.querySelector('.workbench-image-plan-section').getBoundingClientRect();
    const bodyField = editor.closest('.field').getBoundingClientRect();
    return editor.scrollHeight <= editor.clientHeight + 2
      && (columns < 2 || Math.abs(plan.top - bodyField.top) <= 2);
  });
  const layout = await page.evaluate(() => {
    const copyPane = document.querySelector('#review-copy-pane');
    const planPane = document.querySelector('#review-plan-pane');
    const body = document.querySelector('#review-copy-body');
    const bodyField = body.closest('.field');
    const plan = planPane.querySelector('.workbench-image-plan-section');
    const score = planPane.querySelector('.workbench-copy-original-rating');
    const bounds = element => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, width: rect.width };
    };
    return { copy: bounds(copyPane), planPane: bounds(planPane), body: bounds(body),
      bodyField: bounds(bodyField), plan: bounds(plan), score: bounds(score),
      overflow: getComputedStyle(copyPane).overflowY,
      columns: getComputedStyle(document.querySelector('.workbench-review-scroll')).gridTemplateColumns.trim().split(/\s+/u).length };
  });
  assert.equal(layout.overflow, 'visible', `${label}: copy pane has no independent scrollbar`);
  if (layout.columns < 2) return;
  assert.ok(layout.copy.width > layout.planPane.width * 1.5, `${label}: desktop copy column has the wider share`);
  assert.ok(Math.abs(layout.plan.top - layout.bodyField.top) <= 2, `${label}: image planning starts beside the body label`);
  assert.ok(layout.score.bottom <= layout.plan.top + 1, `${label}: score and explanation stay above planning`);
}

function assertHistoryFollowsPanes(layout, label) {
  for (const pane of layout.panes) {
    assert.ok(layout.history.top >= pane.contentBottom - 1,
      `${label}: history top ${layout.history.top} overlaps ${pane.name} content ending at ${pane.contentBottom}`);
  }
  for (const title of layout.sectionTitles) {
    assert.ok(title.bottom <= layout.history.top + 1, `${label}: a sticky section title overlaps history`);
  }
  const left = Math.min(...layout.panes.map(pane => pane.left));
  const right = Math.max(...layout.panes.map(pane => pane.right));
  assert.ok(layout.history.left <= left + 1 && layout.history.right >= right - 1,
    `${label}: history must span the active review columns`);
}

test('task review history stays below copy and image-plan content when collapsed or expanded, including mobile pane switches', {
  skip: process.env.RUN_TASK_REVIEW_HISTORY_LAYOUT_BROWSER !== '1', timeout: 180_000,
}, async () => {
  const { chromium } = await import('playwright-core');
  const base = resolve('.codex_artifacts/task-review-history-layout');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'browser-'));
  const requests = [], errors = [], layouts = [];
  const server = serveFixture(await bundleFixture(directory), requests);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chromium-headless-shell' });
    const page = await browser.newPage();
    page.setDefaultTimeout(8_000);
    page.on('pageerror', error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const width of [1348, 1024, 320, 768]) {
      await page.setViewportSize({ width, height: 883 });
      await page.goto(origin);
      await page.locator('#review-copy-title').waitFor();
      await page.waitForFunction(() => document.querySelectorAll('input[type="radio"]').length > 0);
      await assertCompactCopyLayout(page, `${width}px initial`);
      const history = page.getByRole('button', { name: /历史版本与审核记录/ });
      const variants = width < 1024 ? ['copy', 'plan'] : ['both'];
      for (const pane of variants) {
        if (pane === 'plan') await page.getByRole('button', { name: '图片文案规划', exact: true }).click();
        await assertCompactCopyLayout(page, `${width}px ${pane}`);
        for (const expanded of [false, true]) {
          if (expanded) {
            await history.click();
            const copyVersions = page.getByRole('button', { name: '文案版本', exact: true });
            if (await copyVersions.getAttribute('aria-pressed') !== 'true') await copyVersions.click();
            await page.getByRole('button', { name: /文案版本 · 第 3 版/ }).click();
            await page.getByRole('heading', { name: copy.title, exact: true }).waitFor();
          }
          await page.locator('.workbench-review-scroll').evaluate(element => { element.scrollTop = 0; });
          const layout = await measureLayout(page), label = `${width}px ${pane} ${expanded ? 'expanded' : 'collapsed'}`;
          layouts.push({ label, ...layout });
          await page.screenshot({ path: join(directory, `${width}-${pane}-${expanded ? 'expanded' : 'collapsed'}.png`) });
          assertHistoryFollowsPanes(layout, label);
          await history.scrollIntoViewIfNeeded();
          const visible = await measureLayout(page);
          layouts.push({ label: `${label} scrolled`, ...visible });
          await page.screenshot({ path: join(directory, `${width}-${pane}-${expanded ? 'expanded' : 'collapsed'}-scrolled.png`) });
          assert.ok(visible.trigger.top >= visible.scroll.top - 1 && visible.trigger.bottom <= visible.footer.top + 1,
            `${label}: history control must be accessible above the fixed action footer`);
          assertHistoryFollowsPanes(visible, `${label} scrolled`);
          if (expanded) {
            await page.getByRole('button', { name: '人工评分', exact: true }).click();
            await page.getByRole('button', { name: /人工评分 · #801/ }).click();
            await page.getByText('合成审核记录用于布局验证', { exact: true }).waitFor();
            await history.click();
          }
        }
      }
    }
    await page.setViewportSize({ width: 1348, height: 883 });
    await page.goto(origin);
    await page.locator('#copy-original-41-note').waitFor();
    await page.locator('.workbench-copy-original-rating label[data-score="3"]').click();
    assert.equal(await page.locator('input[type="radio"][value="3"]').isChecked(), true);
    await assertCompactCopyLayout(page, '3-point score');
    await page.locator('.workbench-copy-original-rating label[data-score="2.5"]').click();
    assert.equal(await page.locator('input[type="radio"][value="2.5"]').isChecked(), true);
    await page.locator('#copy-original-41-note').fill('合成说明：核对正文与规划中的四项要求。');
    const bullets = page.locator('#review-plan-bullets-0');
    await bullets.fill('检查产品标识与适用范围，核对页面文字是否完整\n确认测试要求与相关材料，检查长句能否正常换行\n检查额定容量并对照产品标识，保证每行内容可见\n随身携带并遵守规定，核对最后一条没有被截断\n最终复核');
    await assertCompactCopyLayout(page, 'five wrapped bullet lines');
    await bullets.press('Control+End');
    await bullets.evaluate(element => element.scrollIntoView({ block: 'center' }));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => {
      const editor = document.querySelector('#review-plan-bullets-0');
      const scroll = document.querySelector('.workbench-review-scroll');
      window.__typingSamples = [];
      window.__sampleTyping = true;
      function sample() {
        const rect = editor.getBoundingClientRect();
        window.__typingSamples.push({ top: rect.top, left: rect.left, height: rect.height,
          scrollTop: scroll.scrollTop, focused: document.activeElement === editor });
        if (window.__sampleTyping) requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
    await bullets.pressSequentially('已确认', { delay: 40 });
    await page.waitForFunction(() => window.__typingSamples.length >= 6);
    const samples = await page.evaluate(() => { window.__sampleTyping = false; return window.__typingSamples; });
    await writeFile(join(directory, 'continuous-input.json'), JSON.stringify(samples, null, 2));
    for (const key of ['top', 'left', 'height', 'scrollTop']) {
      const values = samples.map(sample => sample[key]);
      assert.ok(Math.max(...values) - Math.min(...values) <= 1, `${key} stays stable during continuous typing`);
    }
    assert.ok(samples.every(sample => sample.focused), 'continuous typing keeps focus in the bullet editor');
    assert.equal(await bullets.evaluate(element => element.selectionStart === element.value.length && element.selectionEnd === element.value.length), true,
      'the caret remains at the end of the text');
    await assertCompactCopyLayout(page, 'continuous bullet typing');
    await page.locator('#copy-original-41-note').evaluate(element => { element.style.height = '150px'; });
    await page.waitForFunction(() => {
      const bodyField = document.querySelector('#review-copy-body').closest('.field').getBoundingClientRect();
      const plan = document.querySelector('.workbench-image-plan-section').getBoundingClientRect();
      return Math.abs(bodyField.top - plan.top) <= 2;
    });
    await assertCompactCopyLayout(page, 'expanded explanation');
    await page.screenshot({ path: join(directory, 'compact-score-with-explanation.png') });
    assert.deepEqual(errors, []);
    assert.equal(requests.some(request => request.method !== 'GET'), false);
  } finally {
    await writeFile(join(directory, 'evidence.json'), JSON.stringify({ modelCalls: 0, backend: 'isolated read-only HTTP fakes', layouts, requests, errors }, null, 2));
    console.log(`Task review history layout evidence: ${directory}`);
    await browser?.close();
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  }
});
