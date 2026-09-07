import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Isolated browser regression: copies the real components, serves fake images,
// and never connects to the application backend or a model provider.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const before = process.argv.includes('--before');
const fixture = path.join(root, '.codex_artifacts', 'preview-regression', ...(before ? ['before'] : []));
const serveOnly = process.argv.includes('--serve');
const baselineFiles = new Set(['app/components/image-preview.tsx', 'app/tasks/[id]/image-generation-batch.tsx', 'app/globals.css']);

function sourceFile(relative) {
  return before && baselineFiles.has(relative.replaceAll('\\', '/'))
    ? path.join(root, '.codex_artifacts', 'preview-before', path.basename(relative))
    : path.join(root, relative);
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function write(relative, content) {
  const target = path.join(fixture, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function copySourceGraph(relative, copied = new Set()) {
  if (copied.has(relative)) return;
  copied.add(relative);
  const source = path.join(root, relative);
  const target = path.join(fixture, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(sourceFile(relative), target);
  const content = await readFile(sourceFile(relative), 'utf8');
  for (const match of content.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
    const imported = match[1];
    if (!imported.startsWith('.') && !imported.startsWith('@/')) continue;
    const base = imported.startsWith('@/')
      ? path.join(root, imported.slice(2))
      : path.resolve(path.dirname(source), imported);
    const candidates = [base, ...['.tsx', '.ts', '.mjs', '.js', '.css'].map(extension => base + extension), path.join(base, 'index.tsx')];
    let resolved;
    for (const candidate of candidates) {
      if (await exists(candidate)) { resolved = candidate; break; }
    }
    assert.ok(resolved, `Cannot resolve ${imported} from ${relative}`);
    assert.ok(!path.relative(root, resolved).startsWith('..'), 'Fixture dependency must stay in the repository');
    await copySourceGraph(path.relative(root, resolved), copied);
  }
}

async function prepareFixture() {
  await mkdir(fixture, { recursive: true });
  await copySourceGraph('app/tasks/[id]/image-generation-batch.tsx');
  await copySourceGraph('app/components/image-preview.tsx');
  await copySourceGraph('app/globals.css');
  for (const file of ['postcss.config.mjs', 'tsconfig.json']) {
    await write(file, await readFile(sourceFile(file), 'utf8'));
  }
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await write('package.json', JSON.stringify({ name: 'image-preview-regression', private: true, type: 'module', dependencies: packageJson.dependencies, devDependencies: packageJson.devDependencies }, null, 2));
  await write('next.config.mjs', `export default { devIndicators: false, turbopack: { root: ${JSON.stringify(root)} } };\n`);
  if (!await exists(path.join(fixture, 'node_modules'))) {
    await symlink(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  }
  await write('app/layout.tsx', `import './globals.css';\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html lang="zh-CN"><body><main style={{ padding: 32 }}>{children}</main></body></html>; }\n`);
  await write('app/page.tsx', `'use client';
import { ImageGenerationBatch } from './tasks/[id]/image-generation-batch';
const batch = { kind: 'reference', isCurrent: true, assets: [1, 2, 3, 4].map(id => ({ id, sha256: 'fixture-' + id, kind: 'REFERENCE', revision: id, pageIndex: id, width: 1080, height: 1440, alignmentStatus: 'PASSED' })) };
export default function Page() { return <><h1>图片预览回归测试</h1><p>本地固定素材，不连接后台或模型。</p><ImageGenerationBatch batch={batch} config={{}} visualReference={null} imageEditRequests={[]} busy={false} qualityScoreLabel={() => '—'} onEdit={async () => false} /></>; }
`);
  await write('app/api/assets/[id]/route.ts', `export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const colors: Record<string, string> = { '1': '#dce8cb', '2': '#c2d6ee', '3': '#f0d5ad', '4': '#e2cfe5' };
  const color = colors[id] || '#eeeeee';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440"><rect width="1080" height="1440" fill="' + color + '"/><rect x="80" y="120" width="920" height="1180" rx="60" fill="white" fill-opacity=".65"/><text x="120" y="270" font-family="sans-serif" font-size="70" fill="#203026">PREVIEW ' + id + '</text><circle cx="540" cy="670" r="270" fill="' + color + '"/><path d="M200 1080h680M200 1140h420" stroke="#203026" stroke-width="22" stroke-linecap="round"/></svg>';
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' } });
}
`);
}

async function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')].filter(Boolean);
  for (const candidate of candidates) {
    try { return await import(path.isAbsolute(candidate) ? pathToFileURL(candidate).href : candidate); } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error('Playwright is unavailable. Set PLAYWRIGHT_MODULE to its index.mjs path.');
}

async function availablePort() {
  if (process.env.PREVIEW_TEST_PORT) return Number(process.env.PREVIEW_TEST_PORT);
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startServer() {
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', fixture, '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: fixture, shell: false, windowsHide: true,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  server.stdout.on('data', chunk => { logs += chunk; });
  server.stderr.on('data', chunk => { logs += chunk; });
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Fixture server exited: ${logs}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return { server, url, logs: () => logs };
    } catch { /* Wait for Next to compile the isolated page. */ }
    await delay(300);
  }
  server.kill();
  throw new Error(`Fixture server did not become ready: ${logs}`);
}

async function runBrowserChecks(url) {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true, ...(process.env.PREVIEW_BROWSER_CHANNEL ? { channel: process.env.PREVIEW_BROWSER_CHANNEL } : process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const failures = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  async function check(name, action) {
    try { await action(); console.log(`PASS ${name}`); }
    catch (error) { failures.push({ name, message: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
  }
  const preview = () => page.locator('.image-preview-dialog[data-state="open"]');
  const openFirst = async () => {
    await page.getByRole('button', { name: /^预览图片：/ }).first().click();
    await preview().waitFor();
    await page.waitForFunction(() => document.querySelector('.image-preview-full')?.complete);
    await page.waitForFunction(() => document.querySelector('.image-preview-dialog')?.getAnimations().length === 0);
  };
  const close = async () => {
    await page.getByRole('button', { name: '关闭图片预览', exact: true }).click();
    await page.locator('.image-preview-dialog').waitFor({ state: 'detached' });
  };
  try {
    await page.goto(url);
    await openFirst();
    await page.screenshot({ path: path.join(fixture, 'preview-initial.png') });
    await check('navigation retains the dialog, backdrop, and selected fit mode without entrance animations', async () => {
      await page.getByRole('button', { name: '完整显示', exact: true }).click();
      await page.evaluate(() => {
        window.__previewDialog = document.querySelector('.image-preview-dialog');
        window.__previewOverlay = document.querySelector('[data-slot="dialog-overlay"]');
        window.__previewEntranceAnimations = [];
        document.addEventListener('animationstart', event => {
          if (event.target.matches('.image-preview-dialog, [data-slot="dialog-overlay"]')) window.__previewEntranceAnimations.push(event.animationName);
        });
      });
      await page.getByRole('button', { name: '下一张图片', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.image-preview-dialog[data-state="open"] .image-preview-position')?.textContent?.trim() === '2 / 4');
      await page.waitForTimeout(250);
      const state = await page.evaluate(() => ({
        dialogRetained: window.__previewDialog === document.querySelector('.image-preview-dialog[data-state="open"]'),
        overlayRetained: window.__previewOverlay === document.querySelector('[data-slot="dialog-overlay"][data-state="open"]'),
        entranceAnimations: window.__previewEntranceAnimations,
        fitSelected: [...document.querySelectorAll('.preview-mode-button')].find(button => button.textContent === '完整显示')?.getAttribute('aria-pressed'),
      }));
      assert.deepEqual(state, { dialogRetained: true, overlayRetained: true, entranceAnimations: [], fitSelected: 'true' });
    });
    if (before) {
      await page.screenshot({ path: path.join(fixture, 'preview-after-navigation.png') });
      await write('results.json', JSON.stringify({ url, failures, errors }, null, 2));
      assert.equal(failures.length, 0, 'The saved pre-fix source reproduces the preview navigation regression');
      return;
    }
    await check('custom zoom is preserved when moving back to another image', async () => {
      await page.getByRole('button', { name: '100% 查看', exact: true }).click();
      await page.getByRole('slider', { name: '调整预览倍数' }).fill('160');
      await page.getByRole('button', { name: '上一张图片', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.image-preview-dialog[data-state="open"] .image-preview-position')?.textContent?.trim() === '1 / 4');
      assert.equal(await page.getByRole('slider', { name: '调整预览倍数' }).inputValue(), '160');
    });
    await check('the default full-preview switch persists through closing and reloading', async () => {
      const toggle = page.getByRole('switch', { name: '默认完整预览', exact: true });
      await toggle.waitFor({ timeout: 5000 });
      if (await toggle.getAttribute('aria-checked') !== 'true') await toggle.click();
      await close();
      await openFirst();
      assert.equal(await page.getByRole('button', { name: '完整显示', exact: true }).getAttribute('aria-pressed'), 'true');
      await page.reload();
      await openFirst();
      assert.equal(await toggle.getAttribute('aria-checked'), 'true');
      assert.equal(await page.getByRole('button', { name: '完整显示', exact: true }).getAttribute('aria-pressed'), 'true');
      await toggle.click();
      await close();
      await openFirst();
      assert.equal(await page.getByRole('button', { name: '100% 查看', exact: true }).getAttribute('aria-pressed'), 'true');
    });
    await check('preview background uses the custom Select with keyboard support', async () => {
      const select = page.getByRole('combobox', { name: '预览观察底色', exact: true });
      assert.equal(await select.evaluate(element => element.tagName), 'BUTTON');
      await select.focus();
      await select.press('ArrowDown');
      await page.getByRole('listbox').waitFor();
      await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'option');
      await page.keyboard.press('End');
      await page.waitForFunction(() => document.activeElement?.textContent === '深色');
      await page.keyboard.press('Enter');
      await page.getByRole('listbox').waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.querySelector('.image-preview-viewport')?.classList.contains('preview-background-dark'));
      assert.match(await page.locator('.image-preview-viewport').getAttribute('class'), /preview-background-dark/);
    });
    await check('rapid next and previous selections settle on the final image', async () => {
      await page.getByRole('button', { name: '下一张图片', exact: true }).click();
      await page.getByRole('button', { name: '下一张图片', exact: true }).click();
      await page.getByRole('button', { name: '上一张图片', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.image-preview-full')?.getAttribute('src')?.includes('/api/assets/2?'));
      assert.equal(await page.locator('.image-preview-position').textContent(), '2 / 4');
    });
    await check('closing the gallery restores focus to the thumbnail that opened it', async () => {
      await close();
      await page.waitForFunction(() => document.querySelector('.image-preview-trigger') === document.activeElement, undefined, { timeout: 2000 });
      assert.equal(await page.getByRole('button', { name: /^预览图片：/ }).first().evaluate(element => element === document.activeElement), true);
    });
    await check('slow images retain the current bitmap and cannot overwrite a later selection', async () => {
      let release;
      let requested = false;
      const gate = new Promise(resolve => { release = resolve; });
      await page.route('**/api/assets/3?*', async route => {
        requested = true;
        await gate;
        await route.continue();
      });
      try {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await openFirst();
        await page.getByRole('button', { name: '下一张图片', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.image-preview-full')?.getAttribute('src')?.includes('/api/assets/2?'));
        await page.getByRole('button', { name: '下一张图片', exact: true }).click();
        assert.ok(requested, 'The slow image request should be intercepted');
        assert.match(await page.locator('.image-preview-full').getAttribute('src'), /\/api\/assets\/2\?/);
        assert.equal(await page.locator('.image-preview-full').evaluate(image => image.complete && image.naturalWidth > 0), true);
        assert.equal(await page.locator('.image-preview-viewport').getAttribute('aria-busy'), 'true');
        await page.getByRole('button', { name: '下一张图片', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.image-preview-full')?.getAttribute('src')?.includes('/api/assets/4?'));
        release();
        await page.waitForFunction(() => document.querySelectorAll('.image-preview-thumbnail')[2]?.complete);
        await page.waitForTimeout(100);
        assert.match(await page.locator('.image-preview-full').getAttribute('src'), /\/api\/assets\/4\?/);
        assert.equal(await page.locator('.image-preview-position').textContent(), '4 / 4');
      } finally {
        release();
        await page.unroute('**/api/assets/3?*');
      }
    });
    await check('failed image loading preserves the bitmap and retry recovers', async () => {
      let failing = true;
      await page.route('**/api/assets/2?*', async route => {
        if (failing) await route.fulfill({ status: 503, contentType: 'text/plain', body: 'Fixture image unavailable' });
        else await route.continue();
      });
      try {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await openFirst();
        await page.getByRole('button', { name: '下一张图片', exact: true }).click();
        await page.getByRole('button', { name: '重试加载', exact: true }).waitFor();
        assert.match(await page.locator('.image-preview-full').getAttribute('src'), /\/api\/assets\/1\?/);
        failing = false;
        await page.getByRole('button', { name: '重试加载', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.image-preview-full')?.getAttribute('src')?.includes('/api/assets/2?') && document.querySelector('.image-preview-viewport')?.getAttribute('aria-busy') === 'false');
        assert.equal(await page.getByRole('button', { name: '重试加载', exact: true }).count(), 0);
      } finally {
        failing = false;
        await page.unroute('**/api/assets/2?*');
      }
    });
    await check('100% and fit dimensions stay correct at desktop, tablet, and mobile sizes', async () => {
      for (const width of [1440, 768, 320]) {
        await page.setViewportSize({ width, height: width === 320 ? 740 : 1000 });
        await page.getByRole('button', { name: '100% 查看', exact: true }).click();
        const actual = await page.locator('.image-preview-full').evaluate(image => ({ width: image.getBoundingClientRect().width, naturalWidth: image.naturalWidth }));
        assert.equal(actual.width, actual.naturalWidth);
        await page.getByRole('button', { name: '完整显示', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.image-preview-full')?.classList.contains('is-fit'));
        const fits = await page.locator('.image-preview-full').evaluate(image => {
          const rect = image.getBoundingClientRect();
          const viewport = document.querySelector('.image-preview-viewport').getBoundingClientRect();
          return rect.width <= viewport.width && rect.height <= viewport.height;
        });
        assert.equal(fits, true, `Full image must fit the preview viewport at ${width}px`);
        await page.screenshot({ path: path.join(fixture, `preview-${width}.png`) });
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
    });
    await page.screenshot({ path: path.join(fixture, 'preview-final.png') });
    await check('the fixture has no browser runtime errors', async () => assert.deepEqual(errors, []));
    await write('results.json', JSON.stringify({ url, failures, errors }, null, 2));
    assert.equal(failures.length, 0, `${failures.length} preview regression check(s) failed`);
  } finally {
    await context.close();
    await browser.close();
  }
}

await prepareFixture();
const running = await startServer();
console.log(`Preview fixture: ${running.url}`);
if (serveOnly) {
  process.on('SIGINT', () => { running.server.kill(); process.exit(); });
  process.on('SIGTERM', () => { running.server.kill(); process.exit(); });
} else {
  try { await runBrowserChecks(running.url); }
  finally { await write('server.log', running.logs()); running.server.kill(); }
}
