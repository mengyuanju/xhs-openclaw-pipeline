import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Isolated UI and in-memory API responses: no application credentials, workers,
// production database, or model calls. Same fixture approach as test-task-review.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.codex_artifacts', 'skip-copy-review');
await mkdir(output, { recursive: true });
const fixture = await mkdtemp(path.join(output, 'ui-'));
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
await copySource('app/workbench/creation-workbench.tsx');
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
import { CreationWorkbench } from './workbench/creation-workbench';
import { TaskReviewDialog } from './workbench/task-review-dialog';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog';
export default function Page() {
  const [role, setRole] = useState('ADMIN');
  const [taskId, setTaskId] = useState<number | null>(null);
  return <ConfirmDialogProvider><main><h1>免审核功能隔离测试 · 全部为假数据</h1>
    <label>测试角色<select value={role} onChange={event => setRole(event.target.value)}><option>ADMIN</option><option>REVIEWER</option><option>USER</option></select></label>
    <button onClick={() => setTaskId(900001)}>查看免审核记录</button>
    <CreationWorkbench key={role} nodeId="fixture-node" creatorUserId="fixture-user" role={role} viewKey="PERSONAL" />
    <TaskReviewDialog taskId={taskId} nodeId="fixture-node" role={role} onOpenChange={open => { if (!open) setTaskId(null); }} onUpdated={() => {}} />
  </main></ConfirmDialogProvider>;
}`);
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', fixture,
  '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: fixture, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
});
let logs = '', browser;
server.stdout.on('data', chunk => { logs += chunk; });
server.stderr.on('data', chunk => { logs += chunk; });
try {
  let ready = false;
  for (let attempt = 0; attempt < 160; attempt++) {
    if (server.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1500) })).ok) { ready = true; break; } } catch { /* Compilation. */ }
    await delay(300);
  }
  assert.ok(ready, logs);
  const playwrightPath = process.env.PLAYWRIGHT_MODULE || path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  const writes = [], errors = [];
  let releaseSubmission;
  await context.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    let data;
    if (request.method() === 'POST') {
      assert.equal(pathname, '/api/control-plane/v1/tasks');
      writes.push(request.postDataJSON());
      await new Promise(resolve => { releaseSubmission = resolve; });
      data = [{ id: 900001 }];
    } else if (pathname === '/api/control-plane/v1/tasks') data = { items: [], total: 0, limit: 20, offset: 0 };
    else if (pathname === '/api/control-plane/v1/task-views') data = [];
    else if (pathname === '/api/control-plane/v1/nodes') data = [];
    else if (pathname === '/api/workbench-statistics') data = { state: 'ready', updatedAt: new Date().toISOString(), retryAfterMs: 60000 };
    else if (pathname === '/api/control-plane/v1/tasks/900001') data = {
      id: 900001, query: '桌面整理', state: 'IMAGE_QUEUED', aiDisclosureEnabled: true, currentCopyRevisionId: 901,
      currentImageRunId: null, currentExecutionId: null, progressPercent: 0, currentStage: 'IMAGE_QUEUED',
      progressMessage: '管理员免审核，等待图片执行机领取', copyRevisions: [{ id: 901, revision: 1,
        approvedAt: new Date().toISOString(), approvalMode: 'ADMIN_BYPASS', content: {
          copy: { title: '桌面整理', body: '整理桌面。'.repeat(90), tags: ['#收纳', '#桌面', '#整理'] },
          imagePlan: Array.from({ length: 3 }, (_, i) => ({ kind: i ? 'steps' : 'hero', headline: '整理桌面', subtitle: '物品分区摆放', bullets: ['清理杂物', '整理线材'], prompt: '明亮整洁的桌面，展示物品分区收纳。' })),
        } }], imageRuns: [], assets: [],
    };
    else { errors.push(`Unexpected API: ${pathname}`); data = {}; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  await page.goto(url);
  const checkbox = page.getByRole('checkbox', { name: '免人工文案审核，直接生图' });
  async function open() { await page.getByRole('button', { name: '创建笔记', exact: true }).click(); }
  async function submit(expected) {
    await page.getByLabel('笔记选题（Query）').fill('桌面整理\n书架整理');
    const count = writes.length;
    await page.getByRole('button', { name: '创建并加入队列', exact: true }).click();
    await page.getByRole('button', { name: '正在创建…', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('#workbench-query-text')?.disabled);
    if (await checkbox.count()) assert.equal(await checkbox.isDisabled(), true);
    for (let attempt = 0; writes.length === count && attempt < 100; attempt++) await delay(20);
    assert.equal(writes.length, count + 1);
    assert.equal(writes.at(-1).skipCopyReview, expected);
    assert.equal(writes.at(-1).tasks.length, 2);
    releaseSubmission();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  }
  await open();
  assert.equal(await checkbox.isChecked(), true);
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.getByRole('dialog').evaluate(node => node.scrollWidth <= node.clientWidth));
    await page.screenshot({ path: path.join(fixture, `create-${width}.png`) });
  }
  await submit(true);
  await open();
  assert.equal(await checkbox.isChecked(), true);
  await checkbox.focus();
  await page.keyboard.press('Space');
  assert.equal(await checkbox.isChecked(), false);
  await submit(false);
  await open();
  assert.equal(await checkbox.isChecked(), true, 'new batches restore the admin default');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  for (const role of ['REVIEWER', 'USER']) {
    await page.getByLabel('测试角色').selectOption(role);
    await open();
    assert.equal(await checkbox.count(), 0);
    await submit(false);
  }
  await page.getByLabel('测试角色').selectOption('ADMIN');
  await page.getByRole('button', { name: '查看免审核记录', exact: true }).click();
  await page.getByText('管理员免审核 · 当前文案已自动放行生图', { exact: true }).waitFor();
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const label = await page.getByText('管理员免审核 · 当前文案已自动放行生图', { exact: true }).boundingBox();
    const form = await page.locator('.workbench-review-form').boundingBox();
    assert.ok(label.y + label.height <= form.y, 'audit label must not overlap the review form');
    await page.screenshot({ path: path.join(fixture, `bypass-detail-${width}.png`) });
  }
  assert.deepEqual(errors, []);
  console.log('PASS: defaults, keyboard toggle, batch payload, submit lock, reset, roles, audit label, responsive layout, clean console.');
  console.log(`Screenshots and isolated fixture: ${fixture}`);
} finally {
  if (browser) await browser.close();
  if (server.exitCode === null) {
    if (process.platform === 'win32') {
      await new Promise(resolve => spawn('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' }).on('exit', resolve));
    } else server.kill();
  }
  await writeFile(path.join(fixture, 'server.log'), logs);
}
