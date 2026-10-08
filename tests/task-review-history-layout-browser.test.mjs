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
const draftContent = {
  version: 1, draft: revision.content, aiDisclosureEnabled: false,
  copyOriginalScore: null, copyOriginalReasons: [], copyOriginalNote: '',
};
const drafts = Array.from({ length: 9 }, (_, index) => ({
  id: index + 1, taskId: 41, baseCopyRevisionId: 12, reviewerAccountId: 7,
  version: index + 1, content: {
    ...draftContent, draft: { ...revision.content, copy: {
      ...copy, title: index === 8 ? copy.title : `合成草稿 ${index + 1}`,
    } },
  },
  createdAt: new Date(Date.now() - (9 - index) * 60_000).toISOString(),
}));
const modelCalls = ['RESEARCH', 'TEXT_GENERATION', 'COPY_LENGTH_REPAIR'].map((stage, index) => ({
  id: `fixture-call-${index + 1}`, executionId: 'fixture-execution', sequence: index + 1,
  stage, kind: 'COPY', nodeId: 'fixture', provider: 'fixture', operation: 'TEXT',
  model: 'synthetic-layout', status: 'SUCCEEDED', truncated: false,
  startedAt: '2026-10-02T08:00:00Z', executionStartedAt: '2026-10-02T08:00:00Z', durationMs: 1000,
}));
const modelPrompt = '合成长提示词用于验证通栏详情，所有内容都来自隔离 fixture。\n'.repeat(60);
const modelResponse = '# 合成返回内容\n\n' + '这是一段布局测试数据，没有请求任何模型。\n\n'.repeat(45);

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
    if (path.endsWith('/copy-review-drafts')) { reply({ baseCopyRevisionId: 12, drafts }); return; }
    if (path.endsWith('/model-calls')) { reply({ items: modelCalls, total: modelCalls.length }); return; }
    if (path.includes('/model-calls/')) {
      const item = modelCalls.find(call => path.endsWith(`/${call.id}`));
      reply(item ? { ...item, request: '{}', prompt: modelPrompt, response: modelResponse } : 'Unknown synthetic call', item ? 200 : 404);
      return;
    }
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
    const support = scroll.querySelector(':scope > .workbench-review-support');
    return { scroll: { ...bounds(scroll), scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight },
      history: bounds(history), trigger: bounds(trigger), panes, sectionTitles,
      support: support ? bounds(support) : null,
      header: bounds(document.querySelector('.workbench-review-heading')),
      footer: bounds(document.querySelector('.workbench-review-footer')),
      viewport: { width: innerWidth, height: innerHeight, scrollY, documentWidth: document.documentElement.scrollWidth } };
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
  assert.equal(await page.locator('.workbench-copy-original-rating label[data-score]').count(), 4,
    `${label}: all four score choices remain available`);
  if (!(await body.isVisible())) return;
  const layout = await page.evaluate(() => {
    const copyPane = document.querySelector('#review-copy-pane');
    const planPane = document.querySelector('#review-plan-pane');
    const body = document.querySelector('#review-copy-body');
    const plan = planPane.querySelector('.workbench-image-plan-section');
    const score = planPane.querySelector('.workbench-copy-original-rating');
    const bounds = element => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, width: rect.width };
    };
    return { copy: bounds(copyPane), planPane: bounds(planPane), body: bounds(body),
      plan: bounds(plan), score: bounds(score),
      overflow: getComputedStyle(copyPane).overflowY,
      columns: getComputedStyle(document.querySelector('.workbench-review-scroll')).gridTemplateColumns.trim().split(/\s+/u).length };
  });
  assert.equal(layout.overflow, 'visible', `${label}: copy pane has no independent scrollbar`);
  if (layout.columns < 2) return;
  assert.ok(layout.copy.width > layout.planPane.width * 1.5, `${label}: desktop copy column has the wider share`);
  assert.ok(layout.plan.top >= layout.score.bottom - 1 && layout.plan.top - layout.score.bottom <= 12,
    `${label}: planning follows the score with at most 12px gap, independent of the body position`);
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
  assert.ok(layout.support, `${label}: secondary review details have a separate support section`);
  assert.ok(layout.support.left <= left + 1 && layout.support.right >= right - 1,
    `${label}: secondary details span the active review columns`);
  assert.ok(layout.support.top >= Math.max(...layout.panes.map(pane => pane.bottom)) - 1,
    `${label}: secondary details follow both review panes`);
  assert.ok(layout.history.top >= layout.support.bottom - 1, `${label}: history follows secondary details`);
}

async function measurePrimaryContent(page) {
  return page.evaluate(() => {
    const scroll = document.querySelector('.workbench-review-scroll');
    const contentBounds = selector => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { top: rect.top + scroll.scrollTop, bottom: rect.bottom + scroll.scrollTop, height: rect.height };
    };
    return { copy: contentBounds('.workbench-copy-review-section'),
      score: contentBounds('.workbench-copy-original-rating'), plan: contentBounds('.workbench-image-plan-section') };
  });
}

async function settleLayout(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

function assertStableBounds(before, after, label) {
  for (const key of ['top', 'bottom', 'height']) {
    assert.ok(Math.abs(before[key] - after[key]) <= 1, `${label}: ${key} stays stable`);
  }
}

async function assertFixedFooter(page, label) {
  const scroll = page.locator('.workbench-review-scroll');
  await scroll.evaluate(element => { element.scrollTop = 0; });
  await settleLayout(page);
  const before = await measureLayout(page);
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await settleLayout(page);
  const after = await measureLayout(page);
  assertStableBounds(before.header, after.header, `${label} header`);
  assertStableBounds(before.footer, after.footer, `${label} footer`);
  assert.ok(after.footer.top >= 0 && after.footer.bottom <= after.viewport.height + 1,
    `${label}: every footer action remains inside the viewport`);
  assert.ok(after.scroll.bottom <= after.footer.top + 1, `${label}: the footer does not cover review content`);
  assert.equal(after.viewport.scrollY, 0, `${label}: the document does not scroll with review content`);
  assert.ok(after.viewport.documentWidth <= after.viewport.width + 1, `${label}: no horizontal overflow`);
  assert.ok(after.history.bottom <= after.scroll.bottom + 1, `${label}: the final history section is reachable above the footer`);
}

test('task review separates the editing columns from expandable support details and keeps fixed actions accessible', {
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
    for (const width of [320, 390, 768, 1023, 1024, 1440]) {
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
          await assertFixedFooter(page, label);
          if (expanded) {
            await page.getByRole('button', { name: '人工评分', exact: true }).click();
            await page.getByRole('button', { name: /人工评分 · #801/ }).click();
            await page.getByText('合成审核记录用于布局验证', { exact: true }).waitFor();
            await history.click();
          }
        }
      }
    }
    await page.setViewportSize({ width: 1440, height: 883 });
    await page.goto(origin);
    await page.locator('#review-copy-title').waitFor();
    await assertCompactCopyLayout(page, 'desktop before draft expansion');
    const beforeDrafts = await measurePrimaryContent(page);
    await page.getByRole('button', { name: /审核草稿/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('.workbench-review-draft-history li').length === 9);
    await settleLayout(page);
    const afterDrafts = await measurePrimaryContent(page);
    assertStableBounds(beforeDrafts.score, afterDrafts.score, 'opening nine local drafts preserves the score position');
    assertStableBounds(beforeDrafts.plan, afterDrafts.plan, 'opening nine local drafts preserves the planning position');
    await assertCompactCopyLayout(page, 'nine local drafts expanded');
    await page.locator('.workbench-review-scroll').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: join(directory, '1440-nine-local-drafts-expanded.png') });
    layouts.push({ label: '1440px nine local drafts expanded', ...await measureLayout(page) });

    const beforeCalls = await measurePrimaryContent(page);
    const trace = page.locator('.workbench-review-support .model-call-trace');
    await trace.getByRole('button', { name: /模型调用链路/ }).click();
    await trace.getByText('共 3 次调用', { exact: true }).waitFor();
    assert.equal(await trace.locator('.model-call-card').count(), 3);
    const firstCall = trace.locator('.model-call-card').first();
    await firstCall.getByRole('button', { name: /第 1 步/ }).click();
    await firstCall.getByRole('button', { name: '完整提示词原文（已脱敏）', exact: true }).waitFor();
    await firstCall.getByRole('button', { name: '完整提示词原文（已脱敏）', exact: true }).click();
    await firstCall.locator('.model-call-request pre').waitFor();
    assert.equal(await firstCall.locator('.model-call-request pre').textContent(), modelPrompt);
    await firstCall.getByRole('heading', { name: '合成返回内容', exact: true }).waitFor();
    await settleLayout(page);
    const afterCalls = await measurePrimaryContent(page);
    assertStableBounds(beforeCalls.copy, afterCalls.copy, 'long model details do not stretch the copy card');
    assertStableBounds(beforeCalls.score, afterCalls.score, 'long model details preserve the score position');
    assertStableBounds(beforeCalls.plan, afterCalls.plan, 'long model details preserve the planning position');
    const callsLayout = await measureLayout(page);
    assertHistoryFollowsPanes(callsLayout, 'expanded model support');
    layouts.push({ label: '1440px expanded model details', ...callsLayout });
    await page.screenshot({ path: join(directory, '1440-model-details-expanded.png') });
    for (const viewport of [{ width: 1440, height: 600 }, { width: 1024, height: 720 }, { width: 390, height: 600 }, { width: 320, height: 600 }]) {
      await page.setViewportSize(viewport);
      await assertCompactCopyLayout(page, `${viewport.width}x${viewport.height} expanded support`);
      await assertFixedFooter(page, `${viewport.width}x${viewport.height} expanded support`);
      await page.screenshot({ path: join(directory, `${viewport.width}-${viewport.height}-fixed-footer.png`) });
    }

    await page.setViewportSize({ width: 1440, height: 883 });
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
    await settleLayout(page);
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
