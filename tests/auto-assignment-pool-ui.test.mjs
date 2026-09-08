import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('users page loads the automatic assignment overview for the pool manager', async () => {
  const page = await source('app/users/page.tsx');

  assert.match(page, /Promise\.all\(\[/u);
  assert.match(page, /readCentralData\('\/v1\/users', session\)/u);
  assert.match(page, /readCentralData\('\/v1\/auto-assignment', session\)/u);
  assert.match(page, /<AutoAssignmentPoolManager[\s\S]*users=\{users\}[\s\S]*initialSnapshot=\{autoAssignment\}/u);
});

test('automatic assignment pool is explicit, versioned and built from shared controls', async () => {
  const [manager, userManager] = await Promise.all([
    source('app/users/auto-assignment-pool-manager.tsx'),
    source('app/users/user-manager.tsx'),
  ]);

  assert.match(manager, /^'use client';/u);
  for (const control of ['Button', 'Input', 'Switch', 'Select', 'Dialog', 'useConfirmDialog', 'SearchInput']) {
    assert.match(manager, new RegExp(`\\b${control}\\b`, 'u'));
  }
  assert.doesNotMatch(manager, /<(?:button|input|select)\b/u);

  assert.match(manager, /user\.role === 'USER'\s*&& user\.status === 'ACTIVE'/u);
  assert.match(manager, /!memberUsernames\.has\(user\.username\)/u);
  assert.match(manager, /<Select name="username"/u);
  assert.doesNotMatch(manager, /<Select name="username"[^>]*(?:defaultValue|value)=/u);
  assert.match(manager, /min=\{1\}[\s\S]*max=\{500\}/u);
  assert.doesNotMatch(userManager, /autoAssignment|assignmentLimit/u);

  assert.match(manager, /\/api\/control-plane\/v1\/auto-assignment\/settings/u);
  assert.match(manager, /method: 'PATCH'[\s\S]*enabled[\s\S]*expectedVersion: initialSnapshot\.settings\.version/u);
  assert.match(manager, /body: JSON\.stringify\(\{ status: 'ACTIVE', assignmentLimit \}\)/u);
  assert.match(manager, /status: nextStatus,[\s\S]*assignmentLimit: worker\.assignmentLimit,[\s\S]*expectedVersion: worker\.version/u);
  assert.match(manager, /status: worker\.status,[\s\S]*assignmentLimit,[\s\S]*expectedVersion: worker\.version/u);
  assert.match(manager, /method: 'DELETE'[\s\S]*expectedVersion: worker\.version/u);
});

test('automatic assignment pool exposes safe pause and removal semantics without a run-now action', async () => {
  const manager = await source('app/users/auto-assignment-pool-manager.tsx');

  assert.match(manager, /新建用户默认不会加入自动分配池/u);
  assert.match(manager, /不会回收已经分配的任务/u);
  assert.match(manager, /停用账号不能恢复自动接单/u);
  assert.match(manager, /worker\.userRole === 'USER' && worker\.userStatus === 'ACTIVE'/u);
  assert.match(manager, /disabled=\{Boolean\(busy\) \|\| \(!isAccountEligible && worker\.status === 'PAUSED'\)\}/u);
  assert.doesNotMatch(manager, /run.?now|立即补充|立即调度/iu);
});
