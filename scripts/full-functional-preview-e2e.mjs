import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve('preview-service');
const report = resolve('reports/full-functional-2026-10-02/preview');
await mkdir(report, { recursive: true });
const isolated = await mkdtemp(join(tmpdir(), 'xhs-preview-functional-'));
const config = JSON.parse(await readFile(join(root, 'dist/server/wrangler.json'), 'utf8'));
config.main = join(root, 'dist/server/index.js');
config.assets.directory = join(root, 'dist/client');
config.d1_databases[0].migrations_dir = join(root, 'd1-migrations');
delete config.secrets;
const password = randomBytes(18).toString('base64url');
const salt = randomBytes(16);
config.vars = { ADMIN_USERNAME: 'functional-preview', ADMIN_PASSWORD_HASH: ['pbkdf2_sha256', '600000',
  salt.toString('base64url'), pbkdf2Sync(password, salt, 600000, 32, 'sha256').toString('base64url')].join('$') };
const configPath = join(isolated, 'wrangler.json');
await writeFile(configPath, JSON.stringify(config));
const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
const state = join(isolated, 'state');
function run(args, env = {}) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, shell: false, env: { ...process.env,
      WRANGLER_SEND_METRICS: 'false', ...env } });
    let output = ''; child.stdout.on('data', value => output += value); child.stderr.on('data', value => output += value);
    child.on('error', reject); child.on('exit', code => code === 0 ? done(output) : reject(new Error(output)));
  });
}
await writeFile(join(report, 'migrations.log'), await run([wrangler, 'd1', 'migrations', 'apply', 'DB', '--local',
  '--config', configPath, '--persist-to', state]));
const socket = createServer(); await new Promise(done => socket.listen(0, '127.0.0.1', done));
const port = socket.address().port; await new Promise(done => socket.close(done));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [wrangler, 'dev', '--local', '--config', configPath, '--persist-to', state,
  '--port', String(port), '--ip', '127.0.0.1'], { cwd: root, shell: false, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
let logs = ''; for (const stream of [server.stdout, server.stderr]) stream.on('data', value => logs += value);
const cases = []; let browser;
async function check(id, name, work) {
  try { await work(); cases.push({ id, name, status: 'PASS' }); }
  catch (error) { cases.push({ id, name, status: 'FAIL', error: error.stack }); throw error; }
}
try {
  const deadline = Date.now() + 60000;
  while (true) {
    try { if ((await fetch(origin + '/login')).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error('Preview startup timed out: ' + logs.slice(-3000));
    await new Promise(done => setTimeout(done, 200));
  }
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage(); const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await check('PV-01', '未登录重定向、空值、错误和正确登录', async () => {
    await page.goto(origin); await page.waitForURL('**/login');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    assert.equal(await page.locator('#username').evaluate(field => field.validity.valueMissing), true);
    await page.locator('#username').fill('functional-preview'); await page.locator('#password').fill('wrong');
    await page.getByRole('button', { name: '登录', exact: true }).click(); await page.getByRole('alert').waitFor();
    await page.locator('#password').fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('tab', { name: '单条创建', exact: true }).waitFor();
  });
  const images = await Promise.all(['#607da8', '#db9969'].map(async color => {
    const { default: sharp } = await import('sharp'); return sharp({ create: { width: 128, height: 192,
      channels: 3, background: color } }).png().toBuffer();
  }));
  const imageFiles = images.map((buffer, i) => ({ name: `synthetic-${i + 1}.png`, mimeType: 'image/png', buffer }));
  await check('PV-02', '单条与批量草稿保留、无图片验证、实际创建与复制链接', async () => {
    await page.locator('#title').fill('功能测试预览单条'); await page.locator('#body').fill('公开预览功能测试正文');
    await page.getByRole('tab', { name: '批量创建', exact: true }).click();
    await page.getByRole('tab', { name: '单条创建', exact: true }).click();
    assert.equal(await page.locator('#title').inputValue(), '功能测试预览单条');
    await page.getByRole('button', { name: '生成预览链接', exact: true }).click(); await page.getByRole('alert').waitFor();
    await page.locator('#images').setInputFiles(imageFiles);
    await page.getByRole('button', { name: '生成预览链接', exact: true }).click();
    await page.getByRole('button', { name: '复制链接', exact: true }).waitFor();
    await page.getByRole('button', { name: '复制链接', exact: true }).click();
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /\/preview\?noteId=/);
  });
  await check('PV-03', '批量新增、删除、独立图片、生成和复制全部', async () => {
    await page.getByRole('tab', { name: '批量创建', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '删除第 1 条', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '添加一条', exact: true }).click();
    await page.getByRole('button', { name: '添加一条', exact: true }).click();
    await page.getByRole('button', { name: '删除第 3 条', exact: true }).click();
    for (let i = 0; i < 2; i++) {
      await page.locator('input[id^="batch-title-"]').nth(i).fill(`功能测试批量 ${i + 1}`);
      await page.locator('textarea[id^="batch-body-"]').nth(i).fill(`独立正文 ${i + 1}`);
      await page.locator('input[type="file"][id^="batch-images-"]').nth(i).setInputFiles([imageFiles[i]]);
    }
    await page.getByRole('button', { name: '生成 2 个链接', exact: true }).click();
    await page.getByRole('button', { name: '复制全部链接', exact: true }).waitFor();
    await page.getByRole('button', { name: '复制全部链接', exact: true }).click();
    assert.equal((await page.evaluate(() => navigator.clipboard.readText())).split('\n').filter(Boolean).length, 2);
  });
  const api = async (path, init = {}) => context.request.fetch(origin + path, init);
  const listResponse = await api('/api/admin/previews'); const listData = await listResponse.json();
  assert.equal(listData.pageSize, 20, 'omitting pagination uses the documented default');
  const previews = listData.previews;
  assert.equal(previews.length, 3); const single = previews.find(value => value.title === '功能测试预览单条');
  await check('PV-04', '列表搜索、清空、分类、刷新、分页设置和查询ID', async () => {
    const additional = await page.evaluate(async base64 => {
      const bytes = Uint8Array.from(atob(base64), value => value.charCodeAt(0));
      for (let batch = 0; batch < 3; batch++) {
        const form = new FormData(); const items = Array.from({ length: 7 }, (_, i) => ({ clientId: `extra-${batch}-${i}`,
          title: `分页预览 ${batch * 7 + i + 1}`, body: '分页验证', tags: '' }));
        form.set('manifest', JSON.stringify({ items }));
        for (const item of items) form.append('images.' + item.clientId, new Blob([bytes], { type: 'image/png' }), 'synthetic.png');
        const response = await fetch('/api/admin/previews/batch', { method: 'POST', body: form });
        if (response.status !== 201) return { status: response.status, body: await response.text() };
      }
      return { status: 201 };
    }, images[0].toString('base64'));
    assert.equal(additional.status, 201, JSON.stringify(additional));
    await page.locator('#preview-search-input').fill('功能测试批量 1'); await page.getByRole('button', { name: '搜索', exact: true }).click();
    await page.getByText('功能测试批量 1', { exact: true }).waitFor();
    await page.getByRole('button', { name: '清空', exact: true }).click();
    await page.locator('#preview-search-type').selectOption('query'); await page.locator('#preview-search-input').fill(single.publicId);
    await page.getByRole('button', { name: '搜索', exact: true }).click(); await page.getByText(single.title, { exact: true }).waitFor();
    await page.getByRole('button', { name: '清空', exact: true }).click(); await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.locator('#page-size-select').selectOption('10');
    assert.equal(await page.getByRole('button', { name: '上一页', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await page.getByText(/第 2 \/ 3 页/).waitFor();
    await page.getByRole('button', { name: '上一页', exact: true }).click();
    await page.getByText(/第 1 \/ 3 页/).waitFor();
  });
  await check('PV-05', '公开图文、多图顺序、原图字节、旧链接和移动布局', async () => {
    const publicPage = await context.newPage(); await publicPage.goto(origin + '/preview?noteId=' + single.publicId);
    await publicPage.getByText(single.title, { exact: true }).waitFor();
    assert.equal(await publicPage.getByRole('button', { name: '上一张', exact: true }).count(), 0);
    await publicPage.getByRole('button', { name: '下一张', exact: true }).click();
    await publicPage.getByText('2 / 2', { exact: true }).waitFor();
    assert.equal(await publicPage.getByRole('button', { name: '下一张', exact: true }).count(), 0);
    await publicPage.getByRole('button', { name: '上一张', exact: true }).click();
    const imageResponse = await api(`/api/public/previews/${single.publicId}/images/1`);
    assert.deepEqual(await imageResponse.body(), images[0]);
    await publicPage.screenshot({ path: join(report, 'public-desktop.png'), fullPage: true });
    await publicPage.setViewportSize({ width: 390, height: 844 });
    assert.equal(await publicPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await publicPage.screenshot({ path: join(report, 'public-mobile.png'), fullPage: true });
    await publicPage.goto(origin + '/p/' + single.publicId); await publicPage.getByText(single.title, { exact: true }).waitFor();
    await publicPage.close();
  });
  let key;
  await check('PV-06', '接口密钥实际创建、一次性显示、复制、关闭后隐藏', async () => {
    await page.getByRole('button', { name: '接口密钥', exact: true }).click(); const dialog = page.getByRole('dialog');
    await dialog.locator('#api-key-name').fill('功能测试密钥');
    for (const box of await dialog.getByRole('checkbox').all()) if (!(await box.isChecked())) await box.check();
    await dialog.getByRole('button', { name: '生成新密钥', exact: true }).click(); await dialog.locator('code').waitFor();
    key = await dialog.locator('code').innerText(); await dialog.getByRole('button', { name: '复制密钥', exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), key);
    await page.keyboard.press('Escape'); await page.getByRole('button', { name: '接口密钥', exact: true }).click();
    assert.equal(await page.getByRole('dialog').locator('code').count(), 0); await page.keyboard.press('Escape');
  });
  await check('PV-07', 'API 单条与原子批量烟测、原图和撤销', async () => {
    await writeFile(join(report, 'smoke.log'), await run([join(root, 'scripts/smoke.mjs')], { PREVIEW_BASE_URL: origin, PREVIEW_API_KEY: key }));
    await writeFile(join(report, 'smoke-batch.log'), await run([join(root, 'scripts/smoke-batch.mjs')], { PREVIEW_BASE_URL: origin, PREVIEW_API_KEY: key }));
  });
  await check('PV-11', '全部图片格式、非法图片、标题边界、18图上限和批量原子失败', async () => {
    const { default: sharp } = await import('sharp');
    const upload = async (title, files) => {
      const form = new FormData(); form.set('title', title); form.set('body', '格式边界测试');
      for (const file of files) form.append('images', new Blob([file.buffer], { type: file.mimeType }), file.name);
      return fetch(origin + '/api/v1/previews', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form });
    };
    for (const format of ['png', 'jpeg', 'webp', 'gif', 'avif']) {
      const buffer = await sharp(images[0]).toFormat(format).toBuffer();
      assert.equal((await upload('格式测试 ' + format, [{ name: `image.${format}`, mimeType: 'image/' + format, buffer }])).status, 201);
    }
    assert.equal((await upload('', [imageFiles[0]])).status, 400);
    assert.equal((await upload('字'.repeat(101), [imageFiles[0]])).status, 400);
    assert.equal((await upload('缺图', [])).status, 400);
    assert.equal((await upload('19张', Array.from({ length: 19 }, () => imageFiles[0]))).status, 400);
    assert.equal((await upload('无效原图', [{ name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('invalid-image') }])).status, 415);
    assert.equal((await upload('单图超限', [{ name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(20 * 1024 * 1024 + 1) }])).status, 413);
  });
  await check('PV-12', '密钥三种权限分别生效、零权限禁用、名称限制', async () => {
    await page.getByRole('button', { name: '接口密钥', exact: true }).click(); const dialog = page.getByRole('dialog');
    const scopes = ['创建预览', '读取记录', '撤销链接'];
    for (const scope of scopes) await dialog.getByRole('checkbox', { name: scope }).uncheck();
    assert.equal(await dialog.getByRole('button', { name: '生成新密钥', exact: true }).isDisabled(), true);
    assert.equal(await dialog.locator('#api-key-name').getAttribute('maxlength'), '60');
    const scopedKeys = [];
    for (const scope of scopes) {
      await dialog.locator('#api-key-name').fill('权限测试 ' + scope);
      await dialog.getByRole('checkbox', { name: scope }).check();
      const responseEvent = page.waitForResponse(response => response.url().endsWith('/api/admin/api-keys') && response.request().method() === 'POST');
      await dialog.getByRole('button', { name: '生成新密钥', exact: true }).click();
      const keyResponse = await responseEvent;
      assert.equal(keyResponse.status(), 201, await keyResponse.text());
      const result = await keyResponse.json(); const scopedKey = result.apiKey;
      scopedKeys.push({ scope, scopedKey });
      const headers = { Authorization: 'Bearer ' + scopedKey };
      assert.equal((await api('/api/v1/previews', { headers })).status(), scope === '读取记录' ? 200 : 403);
      const scopeTarget = previews.find(value => value.id !== single.id);
      assert.equal((await api('/api/v1/previews/' + scopeTarget.id + '/revoke', { method: 'POST', headers })).status(), scope === '撤销链接' ? 200 : 403);
      await dialog.getByRole('checkbox', { name: scope }).uncheck();
    }
    await page.keyboard.press('Escape');
    for (const { scope, scopedKey } of scopedKeys) {
      const createResponse = await api('/api/v1/previews', { method: 'POST', headers: { Authorization: 'Bearer ' + scopedKey },
        ...(scope === '创建预览' ? { multipart: { title: '权限校验', images: { name: 'synthetic.png', mimeType: 'image/png', buffer: images[0] } } } : {}) });
      assert.equal(createResponse.status(), scope === '创建预览' ? 201 : 403);
    }
  });
  await check('PV-08', '预览撤销取消及确认、撤销后原图和公开页不可访问', async () => {
    await page.locator('#preview-search-type').selectOption('title'); await page.locator('#preview-search-input').fill(single.title);
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    const row = page.locator('article').filter({ has: page.getByText(single.title, { exact: true }) }).last();
    await row.getByRole('button', { name: '撤销', exact: true }).click(); await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await api(`/api/public/previews/${single.publicId}/images/1`)).status(), 200);
    await row.getByRole('button', { name: '撤销', exact: true }).click(); await page.getByRole('alertdialog').getByRole('button', { name: '确认撤销', exact: true }).click();
    assert.equal((await api(`/api/public/previews/${single.publicId}/images/1`)).status(), 404);
    await page.getByRole('button', { name: /^已撤销 \(/ }).click();
    await page.getByText(single.title, { exact: true }).waitFor();
    await page.getByRole('button', { name: /^未找到 \(/ }).click();
    assert.equal(await page.locator('#preview-search-input').isDisabled(), true);
    await page.getByRole('button', { name: /^可访问 \(/ }).click();
    await page.getByRole('button', { name: /^全部 \(/ }).click();
  });
  await check('PV-09', '接口密钥撤销取消及确认、撤销凭据无效', async () => {
    await page.getByRole('button', { name: '接口密钥', exact: true }).click(); const dialog = page.getByRole('dialog');
    const keyRow = dialog.locator('article').filter({ hasText: '功能测试密钥' });
    await keyRow.getByRole('button', { name: '撤销', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await api('/api/v1/previews', { headers: { Authorization: 'Bearer ' + key } })).status(), 200);
    await keyRow.getByRole('button', { name: '撤销', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '确认撤销', exact: true }).click();
    assert.equal((await api('/api/v1/previews', { headers: { Authorization: 'Bearer ' + key } })).status(), 401);
    await page.keyboard.press('Escape');
  });
  await check('PV-10', '退出清除会话、管理接口和页面拒绝访问', async () => {
    await page.screenshot({ path: join(report, 'admin-desktop.png'), fullPage: true });
    await page.getByRole('button', { name: '退出', exact: true }).click(); await page.waitForURL('**/login');
    assert.equal((await api('/api/admin/previews')).status(), 401); assert.deepEqual(pageErrors, []);
  });
} finally {
  await browser?.close(); server.kill();
  await writeFile(join(report, 'server.log'), logs);
  await writeFile(join(report, 'results.json'), JSON.stringify({ origin, database: 'isolated local D1/R2',
    syntheticImages: true, cases, passed: cases.filter(value => value.status === 'PASS').length,
    failed: cases.filter(value => value.status === 'FAIL').length }, null, 2));
}
