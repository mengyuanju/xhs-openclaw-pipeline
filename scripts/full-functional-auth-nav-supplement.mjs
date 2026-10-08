// Real browser account/nav operations in an explicitly isolated 100-task environment.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const origin = process.env.XHS_FUNCTIONAL_ORIGIN;
assert.equal(new URL(origin).hostname, '127.0.0.1');
const root = resolve(process.env.XHS_FUNCTIONAL_REPORT_ROOT ?? 'reports/full-functional-2026-10-02');
await mkdir(root, { recursive: true });
const secrets = [`Auth-${randomUUID()}`, `Auth-${randomUUID()}`, `Delete-${randomUUID()}`, `Delete-${randomUUID()}`];
const username = `auth-nav-supp-${randomUUID().slice(0, 8)}`;
const result = { startedAt: new Date().toISOString(), origin, modelCalls: 0, taskCount: 100, cases: [] };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
const page = await context.newPage(); page.setDefaultTimeout(45000); page.setDefaultNavigationTimeout(60000);
const save = () => writeFile(join(root, 'functional-auth-nav-supplement.json'), JSON.stringify(result, null, 2));
async function login(name, password, next = '') {
  await page.goto(origin + '/login' + next, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const form = document.querySelector('form.login-form');
    return form && Object.keys(form).some(k => k.startsWith('__reactProps') && typeof form[k]?.onSubmit === 'function');
  });
  await page.getByLabel('账号', { exact: true }).fill(name);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '进入后台', exact: true }).click();
  await page.waitForURL(u => !u.pathname.startsWith('/login'));
}
async function api(path, data, method = data === undefined ? 'GET' : 'POST') {
  const r = await context.request.fetch(origin + '/api/control-plane' + path, { method, data, headers: { origin } });
  const payload = await r.json(); assert.ok(r.ok(), `${path}: ${r.status()} ${JSON.stringify(payload)}`); return payload.data;
}
async function check(name, featureIds, action) {
  const entry = { id: `AN${String(result.cases.length + 1).padStart(2, '0')}`, name, featureIds, startedAt: new Date().toISOString() };
  console.log(`AUTH_NAV ${entry.id} ${name}`);
  try { entry.evidence = await action(); entry.status = 'PASS'; }
  catch (e) { entry.status = 'FAIL'; entry.error = secrets.reduce((s, v) => s.replaceAll(v, '[ephemeral test password]'), String(e.stack ?? e)); }
  entry.screenshot = `auth-nav-${entry.id}-${entry.status.toLowerCase()}.png`;
  await page.screenshot({ path: join(root, entry.screenshot), fullPage: true }).catch(() => {});
  entry.durationMs = Date.now() - Date.parse(entry.startedAt); result.cases.push(entry); await save();
}
async function changePassword(prefix, current, next, submitLabel) {
  await page.locator(`#${prefix}-current-password`).fill(current);
  await page.locator(`#${prefix}-new-password`).fill(next);
  await page.locator(`#${prefix}-confirm-password`).fill(next);
  await page.getByRole('button', { name: submitLabel, exact: true }).click();
}
try {
  await check('关闭 JavaScript 的真实 SSR 登录表单使用 POST、输入和提交禁用、无密码查询串', ['F-AUTH-002'], async () => {
    const ssr = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1440, height: 1000 } });
    try {
      const staticPage = await ssr.newPage(); await staticPage.goto(origin + '/login', { waitUntil: 'domcontentloaded' });
      assert.equal(await staticPage.locator('form.login-form').getAttribute('method'), 'post');
      assert.equal(await staticPage.getByLabel('账号', { exact: true }).isDisabled(), true);
      assert.equal(await staticPage.getByLabel('密码', { exact: true }).isDisabled(), true);
      assert.equal(await staticPage.getByRole('button', { name: '进入后台', exact: true }).isDisabled(), true);
      await staticPage.keyboard.press('Enter'); assert.equal(new URL(staticPage.url()).search, '');
      await staticPage.screenshot({ path: join(root, 'auth-nav-ssr-login-no-javascript.png'), fullPage: true });
      return { javaScriptEnabled: false, method: 'post', fieldsDisabled: true, submitDisabled: true, noQueryStringAfterEnter: true,
        screenshot: 'auth-nav-ssr-login-no-javascript.png' };
    } finally { await ssr.close(); }
  });
  await login('functional-helper', '123456');
  assert.equal((await api('/v1/tasks?includeTotal=true&limit=1')).total, 100);
  const account = await api('/v1/users', { username, displayName: '账号导航合成补测', role: 'ADMIN' });
  await context.request.post(origin + '/api/auth/logout', { headers: { origin } });
  await check('强制初始密码弹窗 Escape 不关闭、退出切换账号与有效改密', ['F-AUTH-004', 'F-AUTH-006', 'F-AUTH-007', 'F-NAV-012'], async () => {
    await login(username, '123456'); const dialog = page.getByRole('dialog'); await dialog.waitFor();
    await page.keyboard.press('Escape'); assert.ok(await dialog.isVisible());
    await dialog.getByRole('button', { name: '退出并切换账号', exact: true }).click(); await page.waitForURL('**/login?reauth=1');
    assert.equal((await context.request.get(origin + '/api/control-plane/v1/profile')).status(), 401);
    await login(username, '123456'); await changePassword('forced', '123456', secrets[0], '修改密码并重新登录');
    await page.waitForURL('**/login?reauth=1&passwordChanged=1'); await login(username, secrets[0]);
    return { accountId: account.id, escapeBlocked: true, visibleSwitchAccount: true, invalidatedSession: 401, firstPasswordChanged: true };
  });
  await check('普通登录密码校验不一致、复用、错误当前密码、成功改密旧会话失效', ['F-AUTH-012'], async () => {
    await page.goto(origin + '/profile');
    await page.locator('#profile-current-password').fill(secrets[0]);
    await page.locator('#profile-new-password').fill(secrets[1]);
    await page.locator('#profile-confirm-password').fill('wrong-confirmation');
    await page.getByRole('button', { name: '修改密码', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '两次输入的新密码不一致' }).waitFor();
    await changePassword('profile', secrets[0], secrets[0], '修改密码');
    await page.getByRole('alert').filter({ hasText: '新密码不能与当前密码相同' }).waitFor();
    await changePassword('profile', 'invalid-current-password', secrets[1], '修改密码');
    await page.getByRole('alert').filter({ hasText: '当前密码不正确' }).waitFor();
    await changePassword('profile', secrets[0], secrets[1], '修改密码');
    await page.waitForURL('**/login?reauth=1&passwordChanged=1');
    assert.equal((await context.request.get(origin + '/api/control-plane/v1/profile')).status(), 401);
    await login(username, secrets[1]);
    return { mismatchDenied: true, reuseDenied: true, wrongCurrentDenied: true, changed: true, oldSessionRejected: 401, newLoginPassed: true };
  });
  await check('管理员二级密码长度、不一致、复用和错误登录密码验证、设置及更新持久化', ['F-AUTH-013'], async () => {
    await page.goto(origin + '/profile');
    const ssr = await browser.newContext({ javaScriptEnabled: false, storageState: await context.storageState() });
    try {
      const staticPage = await ssr.newPage(); await staticPage.goto(origin + '/profile', { waitUntil: 'domcontentloaded' });
      const forms = staticPage.locator('form').filter({ has: staticPage.locator('input[type=password]') });
      assert.equal(await forms.count(), 2);
      for (const form of await forms.all()) {
        assert.equal(await form.getAttribute('method'), 'post');
        for (const input of await form.locator('input[type=password]').all()) assert.equal(await input.isDisabled(), true);
        assert.equal(await form.getByRole('button').isDisabled(), true);
      }
      await staticPage.screenshot({ path: join(root, 'auth-nav-ssr-profile-no-javascript.png'), fullPage: true });
    } finally { await ssr.close(); }
    const current = page.locator('#deletion-current-password'), password = page.locator('#deletion-password'), confirm = page.locator('#confirm-deletion-password');
    await current.fill(secrets[1]); await password.fill('short'); await confirm.fill('short');
    assert.equal(await password.evaluate(e => e.checkValidity()), false);
    await password.fill(secrets[2]); await confirm.fill(secrets[3]);
    await page.getByRole('button', { name: '设置二级密码', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '两次输入的二级密码不一致' }).waitFor();
    await password.fill(secrets[1]); await confirm.fill(secrets[1]);
    await page.getByRole('button', { name: '设置二级密码', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '二级密码不能与登录密码相同' }).waitFor();
    await current.fill('wrong-login-password'); await password.fill(secrets[2]); await confirm.fill(secrets[2]);
    await page.getByRole('button', { name: '设置二级密码', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '当前密码不正确' }).waitFor();
    await current.fill(secrets[1]); await page.getByRole('button', { name: '设置二级密码', exact: true }).click();
    await page.getByRole('button', { name: '更新二级密码', exact: true }).waitFor();
    await page.reload(); assert.equal((await api('/v1/profile')).hasDeletionPassword, true);
    await current.fill(secrets[1]); await password.fill(secrets[3]); await confirm.fill(secrets[3]);
    const [response] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/v1/profile/deletion-password') && r.request().method() === 'POST'),
      page.getByRole('button', { name: '更新二级密码', exact: true }).click()]);
    assert.equal(response.status(), 200); await page.reload(); assert.equal((await api('/v1/profile')).hasDeletionPassword, true);
    return { minLengthDenied: true, mismatchDenied: true, reuseDenied: true, wrongLoginDenied: true, setAndUpdated: true, hasDeletionPasswordAfterReload: true };
  });
  await check('桌面全部可见导航、两组子菜单展开收起、当前位置、前进后退及品牌跳转', ['F-NAV-001', 'F-NAV-002', 'F-NAV-004'], async () => {
    const nav = page.getByRole('navigation', { name: '主导航', exact: true });
    for (const name of ['作业中心', '报表统计']) {
      const button = nav.getByRole('button', { name, exact: true });
      if (await button.getAttribute('aria-expanded') === 'true') await button.click();
      assert.equal(await button.getAttribute('aria-expanded'), 'false'); await button.click(); assert.equal(await button.getAttribute('aria-expanded'), 'true');
    }
    const links = await nav.getByRole('link').evaluateAll(nodes => nodes.map(n => ({ href: n.getAttribute('href'), label: n.textContent.trim() })));
    const visited = [];
    for (const { href, label } of links) {
      for (const name of ['作业中心', '报表统计']) { const b = nav.getByRole('button', { name, exact: true }); if (await b.getAttribute('aria-expanded') === 'false') await b.click(); }
      await nav.locator(`a[href="${href}"]`).click(); await page.waitForURL(u => u.pathname === href);
      await page.getByRole('navigation', { name: '当前位置', exact: true }).waitFor({ state: 'visible' });
      assert.equal(await nav.locator(`a[href="${href}"]`).getAttribute('aria-current'), 'page');
      visited.push({ href, label, breadcrumb: await page.getByRole('navigation', { name: '当前位置', exact: true }).innerText() });
    }
    await page.goBack({ waitUntil: 'domcontentloaded' }); await page.waitForURL(u => u.pathname === visited.at(-2).href);
    assert.equal(new URL(page.url()).pathname, visited.at(-2).href);
    await page.goForward({ waitUntil: 'domcontentloaded' }); await page.waitForURL(u => u.pathname === visited.at(-1).href);
    assert.equal(new URL(page.url()).pathname, visited.at(-1).href);
    await page.getByRole('link', { name: '海墨内容工场作业中心', exact: true }).click(); await page.waitForURL('**/workbench/personal');
    return { submenusToggled: ['作业中心', '报表统计'], visited, backForward: true, brandRedirect: '/workbench/personal' };
  });
  await check('移动端主导航展开收起和真实入口跳转后自动关闭、可见退出按钮', ['F-NAV-003', 'F-AUTH-008'], async () => {
    await page.setViewportSize({ width: 390, height: 844 }); const toggle = page.getByRole('button', { name: '切换主导航', exact: true });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false'); await toggle.click(); assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await toggle.click(); assert.equal(await toggle.getAttribute('aria-expanded'), 'false'); await toggle.click();
    await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('link', { name: '知识库', exact: true }).click();
    await page.waitForURL('**/knowledge');
    await page.waitForFunction(() => document.querySelector('[aria-label="切换主导航"]')?.getAttribute('aria-expanded') === 'false');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.click();
    await page.getByRole('button', { name: '退出后台', exact: true }).click(); await page.waitForURL('**/login?reauth=1');
    assert.equal((await context.request.get(origin + '/api/control-plane/v1/profile')).status(), 401);
    return { viewport: '390x844', toggledTwice: true, navigationAutoClosed: true, visibleLogoutClicked: true, sessionRejected: 401 };
  });
  await check('登录空值验证、一次错误密码、返回授权地址及外部返回地址过滤', ['F-AUTH-001', 'F-AUTH-002'], async () => {
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(origin + '/login?reauth=1&next=%2Fknowledge');
    assert.equal(await page.getByLabel('账号', { exact: true }).evaluate(e => e.checkValidity()), false);
    await page.getByLabel('账号', { exact: true }).fill(username); await page.getByLabel('密码', { exact: true }).fill('single-wrong-password');
    await page.getByRole('button', { name: '进入后台', exact: true }).click(); await page.getByRole('alert').waitFor(); assert.equal(new URL(page.url()).pathname, '/login');
    await page.getByLabel('密码', { exact: true }).fill(secrets[1]); await page.getByRole('button', { name: '进入后台', exact: true }).click(); await page.waitForURL('**/knowledge');
    await page.getByRole('button', { name: '退出后台', exact: true }).click(); await page.waitForURL('**/login?reauth=1');
    await login(username, secrets[1], '?reauth=1&next=https%3A%2F%2Fexample.com%2F');
    await page.waitForURL('**/workbench/personal');
    assert.equal((await api('/v1/tasks?includeTotal=true&limit=1')).total, 100);
    return { requiredEmptyDenied: true, incorrectLoginDenied: true, allowedReturn: '/knowledge', unsafeExternalReturn: '/workbench/personal', taskCount: 100 };
  });
} catch (error) {
  result.fatalError = secrets.reduce((s, v) => s.replaceAll(v, '[ephemeral test password]'), String(error.stack ?? error));
} finally {
  result.status = !result.fatalError && result.cases.length === 7 && result.cases.every(c => c.status === 'PASS') ? 'PASS' : 'FAILED'; result.finishedAt = new Date().toISOString();
  await save(); await browser.close();
}
console.log(JSON.stringify({ status: result.status, passed: result.cases.filter(c => c.status === 'PASS').length, failed: result.cases.filter(c => c.status === 'FAIL').length }));
if (result.status !== 'PASS') process.exitCode = 1;
