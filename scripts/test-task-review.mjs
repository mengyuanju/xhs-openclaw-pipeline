import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// A standalone copy of the UI: no application routes, credentials, database,
// workers, or model clients. Every control-plane request is answered in memory.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.codex_artifacts', 'task-review');
await mkdir(output, { recursive: true });
const fixture = await mkdtemp(path.join(output, 'run-'));

async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function write(relative, content) {
  const target = path.join(fixture, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}
const copied = new Set();
async function copySource(relative) {
  if (copied.has(relative)) return;
  copied.add(relative);
  const source = path.join(root, relative);
  const content = await readFile(source, 'utf8');
  await write(relative, content);
  for (const match of content.matchAll(/(?:from\s*|import\s*\(?\s*)['"]([^'"]+)['"]/g)) {
    const imported = match[1];
    if (!imported.startsWith('.') && !imported.startsWith('@/')) continue;
    const base = imported.startsWith('@/') ? path.join(root, imported.slice(2)) : path.resolve(path.dirname(source), imported);
    let resolved;
    for (const candidate of [base, ...['.tsx', '.ts', '.mjs', '.js', '.css'].map(ext => base + ext)]) {
      if (await exists(candidate)) { resolved = candidate; break; }
    }
    assert.ok(resolved, `Cannot resolve ${imported}`);
    assert.ok(!path.relative(root, resolved).startsWith('..'));
    await copySource(path.relative(root, resolved));
  }
}
await copySource('app/workbench/task-review-dialog.tsx');
await copySource('components/ui/confirm-dialog.tsx');
await copySource('app/globals.css');
for (const file of ['postcss.config.mjs', 'tsconfig.json', 'package.json']) {
  await copyFile(path.join(root, file), path.join(fixture, file));
}
await symlink(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
await write('next.config.mjs', `export default { devIndicators: false, turbopack: { root: ${JSON.stringify(root)} } };`);
await write('app/layout.tsx', `import './globals.css';
export default function Layout({ children }: { children: React.ReactNode }) { return <html lang="zh-CN"><body>{children}</body></html>; }`);
await write('app/page.tsx', `'use client';
import { useState } from 'react';
import { TaskReviewDialog } from './workbench/task-review-dialog';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog';
export default function Page() {
  const [taskId, setTaskId] = useState<number | null>(null);
  const [role, setRole] = useState('USER');
  return <ConfirmDialogProvider><main><h1>隔离审核测试 · 全部为假数据</h1>
    <label>测试角色<select value={role} onChange={event => setRole(event.target.value)}><option>USER</option><option>REVIEWER</option><option>ADMIN</option></select></label>
    <button onClick={() => setTaskId(900001)}>打开测试任务</button>
    <TaskReviewDialog taskId={taskId} nodeId="test-only" role={role} onOpenChange={open => { if (!open) setTaskId(null); }} onUpdated={() => {}} />
  </main></ConfirmDialogProvider>;
}`);

const settings = { version: 1, format: 'WEBP', quality: 73, background: 'TRANSPARENT', backgroundColor: '#123456' };
function task(state = 'COPY_REVIEW_PENDING') {
  const copy = { title: '小户型桌面整理指南', body: '从清理桌面开始，把每天使用的物品放在伸手可及的位置。分类收纳以后，给充电线留出固定通道，避免影响日常操作。'.repeat(9), tags: ['桌面整理', '收纳', '小户型'] };
  return {
    id: 900001, query: '  小户型桌面如何整理？\n保留原始需求与空格。', state, aiDisclosureEnabled: false,
    currentCopyRevisionId: 901, currentImageRunId: null, currentExecutionId: null,
    error: state === 'COPY_FAILED' ? '测试生成失败，请重试。' : null,
    copyRevisions: state === 'COPY_RUNNING' || state === 'COPY_FAILED' ? [] : [{ id: 901, revision: 1,
      approvedAt: state === 'COPY_REVIEW_PENDING' ? null : '2026-09-07T00:00:00Z', content: {
        copy, imageSettings: settings,
        imagePlan: Array.from({ length: 4 }, (_, index) => ({ kind: index ? 'steps' : 'hero', headline: `桌面整理第${index + 1}页`, subtitle: '从分类开始改善桌面空间', bullets: ['清理闲置物品', '集中管理线材'], prompt: '画面保持整洁明亮，展示收纳前后的桌面对比。', layout: { mode: 'AUTO' } })),
        generation: { research: { sources: [{ title: '测试资料', url: 'https://example.invalid/source' }] } },
      } }], imageRuns: [], assets: [],
  };
}

function withImages(value) {
  value.currentImageRunId = 'test-current';
  value.imageRuns = ['test-current', 'test-history'].map((id, index) => ({ id, result: {
    imageSettings: settings, images: [{ assetId: 910 + index, pageIndex: 1, provider: 'test-fixture' }],
  } }));
  value.assets = value.imageRuns.map((run, index) => ({ id: 910 + index, imageRunId: run.id, originalName: '假图片.svg', url: `/v1/assets/${910 + index}` }));
  return value;
}

const portProbe = createServer();
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', fixture, '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: fixture, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
});
let logs = '';
server.stdout.on('data', chunk => { logs += chunk; });
server.stderr.on('data', chunk => { logs += chunk; });
let browser;
const failures = [];
try {
  let ready = false;
  for (let attempt = 0; attempt < 160; attempt++) {
    if (server.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1500) })).ok) { ready = true; break; } } catch { /* Wait for isolated compilation. */ }
    await delay(300);
  }
  assert.ok(ready, logs);
  const playwrightPath = process.env.PLAYWRIGHT_MODULE || path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  let detail = task();
  let failSubmission = false;
  const writes = [];
  const blocked = [];
  await context.route('**/*', async route => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    if (requestUrl.origin !== url) { blocked.push(request.url()); return route.abort(); }
    if (!requestUrl.pathname.startsWith('/api/control-plane/')) return route.continue();
    if (request.method() === 'GET' && /\/assets\/91[01]$/.test(requestUrl.pathname)) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="#e7ded0"/><text x="25" y="70" font-size="24">TEST IMAGE</text></svg>' });
    let data;
    if (request.method() === 'GET' && /\/tasks\/900001$/.test(requestUrl.pathname)) data = detail;
    else if (request.method() === 'GET' && requestUrl.pathname.endsWith('/image-capabilities')) data = { version: 1 };
    else if (request.method() === 'GET' && requestUrl.pathname.endsWith('/model-calls')) data = { items: [], total: 0 };
    else if (request.method() === 'POST' && requestUrl.pathname.endsWith('/approve-copy')) {
      writes.push(request.postDataJSON());
      if (failSubmission) return route.fulfill({ status: 409, json: { error: { message: '测试提交失败，保留草稿。' } } });
      data = { state: 'IMAGE_QUEUED' };
    } else { blocked.push(request.url()); return route.abort(); }
    return route.fulfill({ json: { data } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', native => { void native.accept().catch(error => errors.push(error.message)); });
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('409')) errors.push(message.text()); });
  const dialog = () => page.locator('.workbench-review-dialog');
  async function open(role = 'USER', state = 'COPY_REVIEW_PENDING', decorate = value => value) {
    detail = decorate(task(state));
    await page.goto(url);
    await page.getByLabel('测试角色').selectOption(role);
    await page.getByRole('button', { name: '打开测试任务' }).click();
    await dialog().getByText('Query 原文', { exact: true }).waitFor();
  }
  async function check(name, fn) {
    try { await fn(); console.log(`PASS ${name}`); }
    catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
  }

  await check('query remains verbatim inside copy, with no overview or non-admin image settings', async () => {
    await open();
    await page.screenshot({ path: path.join(fixture, 'review-desktop.png') });
    assert.equal(await dialog().getByText('当前任务概览').count(), 0);
    assert.equal(await dialog().getByText('交付格式与背景', { exact: true }).count(), 0);
    assert.equal(await page.locator('.workbench-review-query-text').textContent(), detail.query);
    assert.equal(await page.locator('[data-review-pane="copy"] .workbench-review-query-text').count(), 1);
  });
  if (!process.argv.includes('--baseline')) {
    await check('desktop panes scroll independently and page edits survive switching', async () => {
      await page.setViewportSize({ width: 1440, height: 800 });
      const left = page.locator('[data-review-pane="copy"]');
      const right = page.locator('[data-review-pane="plan"]');
      const l = await left.boundingBox(); const r = await right.boundingBox();
      assert.ok(l.x + l.width <= r.x && Math.abs(l.y - r.y) < 3);
      await page.locator('#review-copy-title').fill('修改后的标题');
      await page.locator('#review-plan-headline-0').fill('修改后的封面');
      await page.getByRole('button', { name: /^第 2 页 ·/ }).click();
      await page.locator('#review-plan-headline-1').fill('修改后的步骤');
      await page.getByRole('button', { name: /^第 1 页 ·/ }).click();
      assert.equal(await page.locator('#review-plan-headline-0').inputValue(), '修改后的封面');
      const leftScroll = await left.evaluate(node => node.scrollTop);
      await right.hover(); await page.mouse.wheel(0, 800);
      await page.waitForTimeout(150);
      assert.equal(await left.evaluate(node => node.scrollTop), leftScroll);
      assert.ok(await right.evaluate(node => node.scrollTop > 0));
    });
    await check('close and refresh protect unsaved edits without posting', async () => {
      await page.getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByRole('alertdialog').waitFor();
      await page.getByRole('button', { name: '继续编辑', exact: true }).click();
      await page.getByRole('button', { name: '刷新', exact: true }).click();
      await page.getByRole('alertdialog').waitFor();
      await page.getByRole('button', { name: '继续编辑', exact: true }).click();
      assert.equal(await page.locator('#review-copy-title').inputValue(), '修改后的标题');
      assert.equal(writes.length, 0);
    });
    await check('mock submit keeps all edits and original hidden settings; failure keeps the draft', async () => {
      failSubmission = true;
      await page.getByRole('button', { name: '审核通过并开始生图', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: '提交审核', exact: true }).click();
      await page.getByText('测试提交失败，保留草稿。', { exact: true }).waitFor();
      assert.equal(await page.locator('#review-copy-title').inputValue(), '修改后的标题');
      assert.equal(writes.at(-1).edits.imagePlan[1].headline, '修改后的步骤');
      assert.deepEqual(writes.at(-1).edits.imageSettings, settings);
      failSubmission = false;
      await page.getByRole('button', { name: '审核通过并开始生图', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: '提交审核', exact: true }).click();
      await dialog().waitFor({ state: 'detached' });
    });
    await check('reviewer has no delivery controls; admin controls start collapsed', async () => {
      await open('REVIEWER');
      assert.equal(await dialog().getByText('交付格式与背景', { exact: true }).count(), 0);
      await open('ADMIN');
      const toggle = page.getByRole('button', { name: '交付格式与背景', exact: true });
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      await toggle.click();
      await page.getByLabel('文件格式').waitFor();
      await page.screenshot({ path: path.join(fixture, 'review-admin.png') });
    });
    await check('mobile switches panes without losing edits and reveals invalid hidden fields', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await open();
      await page.locator('#review-copy-title').fill('手机修改的标题');
      await page.getByRole('button', { name: '图片文案规划', exact: true }).click();
      await page.getByRole('button', { name: /^第 2 页 ·/ }).click();
      await page.locator('#review-plan-headline-1').fill('');
      await page.getByRole('button', { name: /^第 1 页 ·/ }).click();
      await page.getByRole('button', { name: '文案', exact: true }).click();
      assert.equal(await page.locator('#review-copy-title').inputValue(), '手机修改的标题');
      const before = writes.length;
      await page.getByRole('button', { name: '审核通过并开始生图', exact: true }).click();
      await page.locator('#review-plan-headline-1').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#review-plan-headline-1').evaluate(node => node === document.activeElement), true);
      assert.equal(writes.length, before);
      await page.screenshot({ path: path.join(fixture, 'review-mobile.png') });
      assert.ok(await dialog().evaluate(node => node.scrollWidth <= node.clientWidth));
    });
    await check('readonly and no-copy tasks retain query and errors without an approval action', async () => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      for (const state of ['COPY_RUNNING', 'COPY_FAILED', 'REVIEWED']) {
        await open('USER', state);
        assert.equal(await page.locator('.workbench-review-query-text').textContent(), detail.query);
        assert.equal(await page.getByRole('button', { name: '审核通过并开始生图', exact: true }).count(), 0);
        if (state === 'COPY_FAILED') await page.getByText(detail.error, { exact: true }).waitFor();
        if (state === 'REVIEWED') assert.equal(await page.locator('#review-copy-title').getAttribute('readonly'), '');
      }
    });
    await check('retry exhaustion keeps old images inside the copy pane and both panes usable', async () => {
      await open('USER', 'COPY_REVIEW_PENDING', value => withImages({ ...value, currentStage: 'IMAGE_RETRY_EXHAUSTED' }));
      await page.getByText('生图3次失败', { exact: true }).waitFor();
      assert.equal(await page.locator('[data-review-pane="copy"]').getByRole('heading', { name: '图片审核' }).count(), 1);
      assert.equal(await page.locator('.workbench-review-scroll > [data-review-pane]').count(), 2);
      const left = await page.locator('[data-review-pane="copy"]').boundingBox();
      const right = await page.locator('[data-review-pane="plan"]').boundingBox();
      assert.ok(left.x + left.width <= right.x && Math.abs(left.y - right.y) < 3);
    });
    await check('image review keeps current and historical previews; only admin can restore or convert settings', async () => {
      for (const role of ['USER', 'REVIEWER', 'ADMIN']) {
        await open(role, 'MANUAL_ARCHIVE', withImages);
        await page.getByRole('button', { name: '历史图片 · 对照当前成品' }).click();
        assert.equal(await page.getByRole('button', { name: '恢复此版本的格式与背景参数' }).count(), role === 'ADMIN' ? 1 : 0);
        assert.equal(await page.getByRole('button', { name: '仅转换格式 / 背景（不调用模型）' }).count(), 0);
        if (role === 'ADMIN') {
          await page.getByRole('button', { name: '交付格式与背景', exact: true }).click();
          await page.getByRole('button', { name: '仅转换格式 / 背景（不调用模型）' }).waitFor();
        }
        assert.equal(await page.getByRole('button', { name: '审核通过', exact: true }).count(), role === 'USER' ? 0 : 1);
      }
    });
    await check('refresh confirmation restores saved content, and collapsed prompt errors are revealed', async () => {
      await open();
      await page.locator('#review-copy-title').fill('临时修改');
      await page.getByRole('button', { name: '刷新', exact: true }).click();
      await page.getByRole('button', { name: '放弃修改并刷新', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#review-copy-title')?.value === '小户型桌面整理指南');
      await page.getByRole('button', { name: '画面生成指令', exact: true }).click();
      await page.locator('#review-plan-prompt-0').fill('');
      await page.getByRole('button', { name: '画面生成指令', exact: true }).click();
      const before = writes.length;
      await page.getByRole('button', { name: '审核通过并开始生图', exact: true }).click();
      await page.locator('#review-plan-prompt-0').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#review-plan-prompt-0').evaluate(node => node === document.activeElement), true);
      assert.equal(writes.length, before);
    });
    await check('long query can expand at all target widths, and footer stays on screen', async () => {
      for (const width of [320, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await open('USER', 'COPY_REVIEW_PENDING', value => ({ ...value, query: '长需求原文，保留文本格式。'.repeat(15) }));
        await page.getByRole('button', { name: '展开全文' }).click();
        assert.equal(await page.locator('.workbench-review-query-text').textContent(), detail.query);
        assert.equal(await page.locator('.workbench-review-query-text').getAttribute('data-expanded'), 'true');
        await page.getByRole('button', { name: '收起原文' }).click();
        const footer = await page.locator('.workbench-review-footer').boundingBox();
        assert.ok(footer.y + footer.height <= 900);
        assert.ok(await dialog().evaluate(node => node.scrollWidth <= node.clientWidth));
        await page.screenshot({ path: path.join(fixture, `review-${width}.png`) });
      }
    });
    await check('no unexpected network requests or browser errors', async () => {
      assert.deepEqual(blocked, []);
      assert.deepEqual(errors, []);
    });
  }
  console.log(`Screenshots and isolated fixture: ${fixture}`);
  assert.deepEqual(failures, []);
} finally {
  if (browser) await browser.close();
  // Only terminate this script's newly created server process tree.
  if (server.exitCode === null) {
    if (process.platform === 'win32') {
      await new Promise(resolve => spawn('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' }).on('exit', resolve));
    } else server.kill();
  }
  await writeFile(path.join(fixture, 'server.log'), logs);
}
