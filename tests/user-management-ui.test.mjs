import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('central user management exposes the three fixed roles and default-password workflow', async () => {
  const [page, manager, profile, styles, migration] = await Promise.all([
    source('app/users/page.tsx'),
    source('app/users/user-manager.tsx'),
    source('app/profile/profile-manager.tsx'),
    source('app/globals.css'),
    source('server/migrations/0005_user_management.sql'),
  ]);
  assert.match(page, /用户管理/u);
  assert.match(manager, /ADMIN: '管理员', REVIEWER: '审核员', USER: '普通用户'/u);
  assert.match(manager, /初始密码为 123456/u);
  assert.match(profile, /currentPassword/u);
  assert.match(profile, /newPassword/u);
  assert.match(styles, /\.profile-password-grid \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[^}]*align-items: start;[^}]*max-width: 560px;/u);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS app_users/u);
});

test('workbench separates assignee from creator and limits discard controls to assignees or administrators', async () => {
  const [workbench, repository, server] = await Promise.all([
    source('app/workbench/creation-workbench.tsx'),
    source('server/src/postgres-repository.mjs'),
    source('server/src/http-server.mjs'),
  ]);
  assert.match(workbench, /<th[^>]*>负责人 \/ 创建人<\/th>/u);
  assert.match(workbench, /task\.assignedToDisplayName/u);
  assert.match(workbench, /task.createdByDisplayName/u);
  assert.match(workbench, /role === 'ADMIN' \|\| taskOwnerId\(task\) === creatorUserId/u);
  assert.match(repository, /assignee\.display_name AS assigned_to_display_name/u);
  assert.match(repository, /creator\.display_name AS creator_display_name/u);
  assert.match(server, /ownerOnly: actor\.role !== 'ADMIN'/u);
});
