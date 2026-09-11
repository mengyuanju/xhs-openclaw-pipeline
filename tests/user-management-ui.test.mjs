import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('central user management exposes the three fixed roles and default-password workflow', async () => {
  const [page, manager, profile, loginPage, loginForm, styles, migration] = await Promise.all([
    source('app/users/page.tsx'),
    source('app/users/user-manager.tsx'),
    source('app/profile/profile-manager.tsx'),
    source('app/login/page.tsx'),
    source('app/login/login-form.tsx'),
    source('app/globals.css'),
    source('server/migrations/0005_user_management.sql'),
  ]);
  assert.match(page, /用户管理/u);
  assert.match(manager, /ADMIN: '管理员', REVIEWER: '审核员', USER: '普通用户'/u);
  assert.match(manager, /初始密码为 123456/u);
  assert.match(profile, /currentPassword/u);
  assert.match(profile, /newPassword/u);
  assert.match(profile, /if \(user\.mustChangePassword\) return <Dialog open/u);
  assert.match(profile, /showCloseButton=\{false\}/u);
  assert.match(profile, /onEscapeKeyDown=\{\(event\) => event\.preventDefault\(\)\}/u);
  assert.match(profile, /onPointerDownOutside=\{\(event\) => event\.preventDefault\(\)\}/u);
  assert.match(profile, /onInteractOutside=\{\(event\) => event\.preventDefault\(\)\}/u);
  assert.match(profile, /必须先修改初始密码/u);
  assert.match(profile, /修改密码并重新登录前，其他功能暂不可用/u);
  assert.match(profile, /修改密码并重新登录/u);
  assert.match(profile, /新密码不能与当前密码相同/u);
  assert.match(profile, /退出并切换账号/u);
  assert.match(profile, /const LOGOUT_TIMEOUT_MS = 4_000/u);
  assert.match(profile, /const controller = new AbortController\(\)/u);
  assert.match(profile, /window\.setTimeout\(\(\) => controller\.abort\(\), LOGOUT_TIMEOUT_MS\)/u);
  assert.match(profile, /window\.location\.replace\('\/login\?reauth=1'\)/u);
  assert.match(profile, /window\.location\.replace\('\/login\?reauth=1&passwordChanged=1'\)/u);
  assert.match(loginPage, /passwordChanged=\{params\.passwordChanged === '1'\}/u);
  assert.match(loginForm, /密码已修改，请使用新密码重新登录/u);
  assert.doesNotMatch(loginForm, /初始管理员账号|默认密码|123456/u);
  assert.doesNotMatch(loginForm, /defaultValue=["']admin["']/u);
  assert.match(styles, /\.profile-password-grid \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[^}]*align-items: start;[^}]*max-width: 560px;/u);
  assert.match(styles, /\.forced-password-dialog \{[^}]*width: min\(calc\(100vw - 32px\), 560px\);[^}]*max-height: min\(92dvh, 720px\);/u);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS app_users/u);
});

test('workbench separates assignee from creator and limits controls to stable owners or unassigned creators', async () => {
  const [workbench, repository, server] = await Promise.all([
    source('app/workbench/creation-workbench.tsx'),
    source('server/src/postgres-repository.mjs'),
    source('server/src/http-server.mjs'),
  ]);
  assert.match(workbench, /<th[^>]*>负责人 \/ 创建人<\/th>/u);
  assert.match(workbench, /task\.assignedToDisplayName/u);
  assert.match(workbench, /task.createdByDisplayName/u);
  assert.match(workbench, /const hasOwnerControl = role === 'ADMIN' \|\| isTaskAssignee\(task, creatorUserId, creatorAccountId\)/u);
  assert.match(workbench, /const creatorCanControlMachineCopy = taskOwnerId\(task\) === null[\s\S]*isTaskCreator\(task, creatorUserId, creatorAccountId\)/u);
  assert.match(repository, /assignee\.display_name AS assigned_to_display_name/u);
  assert.match(repository, /creator\.display_name AS creator_display_name/u);
  assert.match(server, /ownerOnly: actor\.role !== 'ADMIN'/u);
});
