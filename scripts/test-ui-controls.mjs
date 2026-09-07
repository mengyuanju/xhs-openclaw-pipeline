import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Isolated browser regression: copies real controls and representative pages,
// and never connects to the application backend or a model provider.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, '.codex_artifacts', 'ui-controls-regression');
const serveOnly = process.argv.includes('--serve');

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
  await copyFile(source, target);
  const content = await readFile(source, 'utf8');
  for (const match of content.matchAll(/(?:from\s*|import\s*(?:\(\s*)?)['"]([^'"]+)['"]/g)) {
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
  const copied = new Set();
  for (const entry of ['scripts/fixtures/ui-controls.tsx', 'app/globals.css', 'components/ui/controls.css']) await copySourceGraph(entry, copied);
  for (const file of ['postcss.config.mjs', 'tsconfig.json']) await write(file, await readFile(path.join(root, file), 'utf8'));
  await write('package.json', await readFile(path.join(root, 'package.json'), 'utf8'));
  await write('next.config.mjs', 'export default { devIndicators: false, turbopack: { root: ' + JSON.stringify(root) + ' } };');
  if (!await exists(path.join(fixture, 'node_modules'))) await symlink(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await write('app/layout.tsx', 'import "./globals.css"; export default function Layout({ children }: { children: React.ReactNode }) { return <html lang="zh-CN"><body><main style={{ padding: 16 }}>{children}</main></body></html>; }');
  await write('app/page.tsx', 'import Fixture from "../scripts/fixtures/ui-controls"; export default function Page() { return <Fixture />; }');
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
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [], failures = [], calls = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/api/**', route => {
    calls.push(route.request().url());
    return route.fulfill({ json: { data: { items: [], total: 0 } } });
  });
  async function check(name, action) {
    try { await action(); console.log(`PASS ${name}`); }
    catch (error) { failures.push({ name, message: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
  }
  try {
    await page.goto(url);
    await page.getByRole('heading', { name: '共享组件交互验证' }).waitFor();
    await check('search filters, clears and restores focus without submitting', async () => {
      const search = page.getByRole('searchbox', { name: '搜索选题', exact: true });
      await search.fill('桌面');
      assert.equal(await page.getByRole('list', { name: '搜索结果' }).innerText(), '桌面收纳');
      await page.getByRole('button', { name: '清除搜索选题', exact: true }).click();
      assert.equal(await search.inputValue(), '');
      assert.equal(await search.evaluate(element => element === document.activeElement), true);
      assert.equal(await page.getByRole('list', { name: '搜索结果' }).locator('li').count(), 2);
    });
    await check('select supports keyboard selection and real form values', async () => {
      const role = page.getByRole('combobox', { name: '表单角色' });
      await role.focus(); await role.press('Space');
      await page.getByRole('option', { name: '普通用户', exact: true }).waitFor();
      await page.waitForFunction(() => document.activeElement?.textContent === '普通用户');
      await page.keyboard.press('ArrowDown');
      await page.waitForFunction(() => document.activeElement?.textContent === '审核员');
      await page.keyboard.press('Enter');
      assert.match(await role.innerText(), /审核员/);
      await page.getByRole('button', { name: '提交表单' }).click();
      const data = Object.fromEntries(JSON.parse(await page.getByLabel('提交结果').innerText()));
      assert.equal(data.role, 'REVIEWER'); assert.equal(data.query, '默认搜索'); assert.equal(data.from, '2026-09-07'); assert.equal(data.approved, 'on');
    });
    await check('form reset restores select, search, date, and checkboxes together', async () => {
      await page.getByRole('searchbox', { name: '表单搜索', exact: true }).fill('改动');
      await page.getByLabel('开始日期', { exact: true }).fill('2026-09-08');
      await page.getByLabel('已审核', { exact: true }).uncheck();
      await page.getByRole('button', { name: '重置表单' }).click();
      assert.match(await page.getByRole('combobox', { name: '表单角色' }).innerText(), /普通用户/);
      assert.equal(await page.getByRole('searchbox', { name: '表单搜索', exact: true }).inputValue(), '默认搜索');
      assert.equal(await page.getByLabel('开始日期', { exact: true }).inputValue(), '2026-09-07');
      assert.equal(await page.getByLabel('已审核', { exact: true }).isChecked(), true);
    });
    await check('checkbox, radio, switch and slider retain keyboard and disabled semantics', async () => {
      const control = page.getByRole('switch', { name: '启用功能', exact: true });
      await control.focus(); await control.press('Space'); assert.equal(await control.isChecked(), false);
      await page.getByRole('radio', { name: '模式 B' }).check();
      assert.equal(await page.getByRole('radio', { name: '模式 A' }).isChecked(), false);
      const slider = page.getByRole('slider', { name: '质量', exact: true });
      await slider.focus(); await slider.press('ArrowRight'); assert.equal(await slider.inputValue(), '81');
      assert.equal(await page.getByRole('checkbox', { name: '禁用复选框' }).isDisabled(), true);
      assert.equal(await page.getByRole('switch', { name: '禁用开关' }).isDisabled(), true);
      assert.ok((await page.getByRole('switch', { name: '禁用开关' }).boundingBox()).width >= 32);
    });
    await check('component calendar supports keyboard dates, Escape and validation', async () => {
      await page.getByRole('button', { name: '选择开始日期' }).click();
      await page.getByRole('button', { name: '2026-09-07', exact: true }).waitFor();
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '2026-09-07');
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '2026-09-08');
      await page.keyboard.press('Enter');
      assert.equal(await page.getByLabel('开始日期', { exact: true }).inputValue(), '2026-09-08');
      await page.getByRole('button', { name: '选择开始日期' }).click(); await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('dialog').count(), 0);
      await page.getByLabel('开始日期', { exact: true }).fill('2026-02-30'); await page.getByLabel('开始日期', { exact: true }).press('Tab');
      assert.equal(await page.getByLabel('开始日期', { exact: true }).evaluate(element => element.checkValidity()), false);
      await page.getByLabel('开始日期', { exact: true }).fill('2026-09-07');
    });
    await check('disclosures support keyboard, nested content and retain draft values', async () => {
      const trigger = page.getByRole('button', { name: '展开编辑详情' });
      await trigger.focus(); await trigger.press('Enter');
      await page.getByLabel('详情备注').fill('编辑后的备注');
      await page.getByRole('button', { name: '嵌套详情' }).click();
      assert.equal(await page.getByText('嵌套内容', { exact: true }).isVisible(), true);
      await trigger.click(); assert.equal(await page.getByLabel('详情备注').isVisible(), false);
      await trigger.click(); assert.equal(await page.getByLabel('详情备注').inputValue(), '编辑后的备注');
    });
    await check('color picker accepts swatches and guards incomplete hex values', async () => {
      await page.getByRole('button', { name: '填充色 #DBEAFE', exact: true }).first().click();
      assert.equal(await page.getByLabel('颜色值').innerText(), '#DBEAFE');
      await page.getByLabel('填充色', { exact: true }).fill('#12');
      assert.equal(await page.getByLabel('颜色值').innerText(), '#DBEAFE');
      await page.getByLabel('填充色', { exact: true }).fill('#123ABC');
      assert.equal(await page.getByLabel('颜色值').innerText(), '#123ABC');
    });
    await check('prompt group selection updates dependent business stages', async () => {
      await page.getByRole('combobox', { name: /提示词分组/ }).click();
      await page.getByRole('option', { name: '审核与修复', exact: true }).click();
      assert.match(await page.getByRole('combobox', { name: /业务阶段/ }).innerText(), /Query 筛选/);
    });
    await check('user editor select works inside a dialog without closing it', async () => {
      await page.getByRole('button', { name: '编辑', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('combobox', { name: '角色', exact: true }).click();
      await page.getByRole('option', { name: '审核员', exact: true }).click();
      assert.equal(await dialog.isVisible(), true);
      const role = await dialog.locator('form').evaluate(form => new FormData(form).get('role'));
      assert.equal(role, 'REVIEWER');
      await page.keyboard.press('Escape');
    });
    await check('model trace fetches only after expanding its component', async () => {
      assert.equal(calls.filter(url => url.includes('model-calls')).length, 0);
      await page.getByRole('button', { name: /模型调用链路/ }).click();
      await page.getByText(/暂无模型调用记录/).waitFor();
      assert.equal(calls.filter(url => url.includes('model-calls')).length, 1);
    });
    await check('progress announces real values and indeterminate state', async () => {
      assert.equal(await page.getByRole('progressbar', { name: '完成进度' }).getAttribute('aria-valuenow'), '2');
      assert.equal(await page.getByRole('progressbar', { name: '完成进度' }).getAttribute('aria-valuemax'), '5');
      assert.equal(await page.getByRole('progressbar', { name: '读取进度' }).getAttribute('aria-valuenow'), null);
    });
    await check('controls fit narrow and desktop viewports without horizontal overflow', async () => {
      for (const width of [320, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `overflow at ${width}px`);
        const date = await page.getByLabel('开始日期', { exact: true }).boundingBox();
        const calendar = await page.getByRole('button', { name: '选择开始日期' }).boundingBox();
        assert.ok(calendar.x >= date.x && calendar.x + calendar.width <= date.x + date.width, `date icon detached at ${width}px`);
        await page.getByRole('combobox', { name: '表单角色' }).click();
        const box = await page.getByRole('listbox').boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width, `select overflow at ${width}px`);
        await page.keyboard.press('Escape');
      }
      await page.getByRole('button', { name: '选择开始日期' }).click();
      assert.notEqual(await page.getByRole('dialog').evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
      await page.getByRole('dialog').screenshot({ path: path.join(fixture, 'calendar-desktop.png') });
      await page.keyboard.press('Escape');
      await page.screenshot({ path: path.join(fixture, 'controls-desktop.png'), fullPage: true });
      await page.setViewportSize({ width: 320, height: 900 });
      await page.screenshot({ path: path.join(fixture, 'controls-mobile.png'), fullPage: true });
    });
    await check('no native picker UI, console errors or hydration warnings', async () => {
      assert.equal(await page.locator('select:not([aria-hidden="true"]), details, input[type="date"], input[type="color"]').count(), 0);
      assert.deepEqual(errors, []);
    });
    await writeFile(path.join(fixture, 'results.json'), JSON.stringify({ failures, errors }, null, 2));
    if (failures.length) throw new Error(`${failures.length} browser checks failed`);
  } finally { await browser.close(); }
}

await prepareFixture();
if (process.argv.includes('--prepare')) process.exit(0);
const running = await startServer();
console.log(`UI fixture: ${running.url}`);
if (serveOnly) {
  process.on('SIGINT', () => { running.server.kill(); process.exit(); });
  await new Promise(() => {});
} else {
  try { await runBrowserChecks(running.url); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { running.server.kill(); }
}
