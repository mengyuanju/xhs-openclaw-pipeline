import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('users page loads the automatic assignment overview for the pool manager', async () => {
  const page = await source('app/users/page.tsx');

  assert.match(page, /Promise\.all\(\[/u);
  assert.match(page, /readCentralPageData\('\/v1\/users', session, '\/users'\)/u);
  assert.match(page, /readCentralPageData\('\/v1\/auto-assignment', session, '\/users'\)/u);
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
  assert.match(manager, /method: 'PATCH'[\s\S]*enabled[\s\S]*mode[\s\S]*expectedVersion: initialSnapshot\.settings\.version/u);
  const addStart = manager.indexOf("if (editor.mode === 'add')");
  const editStart = manager.indexOf('const worker = editorWorker;', addStart);
  const statusStart = manager.indexOf('async function updateWorkerStatus', editStart);
  const removeStart = manager.indexOf('async function removeWorker', statusStart);
  const nextFunctionStart = manager.indexOf('function openAddEditor', removeStart);
  assert.ok(addStart >= 0 && editStart > addStart && statusStart > editStart
    && removeStart > statusStart && nextFunctionStart > removeStart);
  assert.match(manager.slice(addStart, editStart),
    /body: JSON\.stringify\(\{ accountId: user\.id, status: 'ACTIVE', assignmentLimit \}\)/u);
  assert.match(manager.slice(editStart, statusStart),
    /accountId: worker\.accountId,[\s\S]*status: worker\.status/u);
  assert.match(manager.slice(statusStart, removeStart),
    /accountId: worker\.accountId,[\s\S]*status: nextStatus/u);
  assert.match(manager.slice(removeStart, nextFunctionStart),
    /method: 'DELETE'[\s\S]*body: JSON\.stringify\(\{ accountId: worker\.accountId, expectedVersion: worker\.version \}\)/u);
  assert.match(manager, /status: nextStatus,[\s\S]*assignmentLimit: worker\.assignmentLimit,[\s\S]*expectedVersion: worker\.version/u);
  assert.match(manager, /status: worker\.status,[\s\S]*assignmentLimit,[\s\S]*expectedVersion: worker\.version/u);
  assert.match(manager, /method: 'DELETE'[\s\S]*expectedVersion: worker\.version/u);
});

test('automatic assignment pool lets administrators choose continuous or one-shot fixed quantities', async () => {
  const manager = await source('app/users/auto-assignment-pool-manager.tsx');

  assert.match(manager, /新建用户默认不会加入自动分配池/u);
  assert.match(manager, /initialSnapshot\.autoAssignableTaskCount/u);
  assert.match(manager, /initialSnapshot\.manualAttentionTaskCount/u);
  assert.match(manager, /typeof initialSnapshot\.autoAssignableTaskCount === 'number'[\s\S]*: initialSnapshot\.unassignedTaskCount/u);
  assert.match(manager, /Math\.max\(0, initialSnapshot\.unassignedTaskCount - autoAssignableTaskCount\)/u);
  assert.match(manager, /仍在机器阶段或需要管理员处理/u);
  assert.match(manager, /不会回收已经分配的任务/u);
  assert.match(manager, /停用账号不能恢复自动接单/u);
  assert.match(manager, /worker\.userRole === 'USER' && worker\.userStatus === 'ACTIVE'/u);
  assert.match(manager, /disabled=\{Boolean\(busy\) \|\| \(!isAccountEligible && worker\.status === 'PAUSED'\)\}/u);
  assert.match(manager, /<SelectItem value="CONTINUOUS">持续补位<\/SelectItem>/u);
  assert.match(manager, /<SelectItem value="FIXED_QUANTITY">定量分配<\/SelectItem>/u);
  assert.match(manager, /系统将停止循环补位/u);
  assert.match(manager, /完成后不会自动补位/u);
  assert.match(manager, /\$\{workerPath\(worker\.username\)\}\/allocate/u);
  assert.match(manager, /method: 'POST'[\s\S]*accountId: worker\.accountId,[\s\S]*expectedVersion: worker\.version/u);
  assert.match(manager, /assignmentMode === 'FIXED_QUANTITY'[\s\S]*分配 \{allocationCount\} 条/u);
  assert.match(manager, /fixedQuantityAssignedTotal/u);
  assert.match(manager, /fixedQuantityAssignedToday/u);
  assert.match(manager, /池成员累计已分配/u);
  assert.match(manager, /当前可分配 <strong>\{autoAssignableTaskCount\}<\/strong>/u);
  assert.match(manager, /const currentlyAllocatableCount = Math\.min\(autoAssignableTaskCount, allocationCount\)/u);
  assert.match(manager, /共享池当前 \$\{autoAssignableTaskCount\} 条，本次最多可分配 \$\{currentlyAllocatableCount\} 条/u);
  assert.match(manager, /今日定量已分配/u);
  assert.match(manager, /累计 \{worker\.fixedQuantityAssignedTotal \?\? 0\} 条/u);
  assert.match(manager, /今日已分配 \{worker\.fixedQuantityAssignedToday \?\? 0\} 条/u);
  assert.match(manager, /initialSnapshot\.settings\.enabled && autoAssignableTaskCount === 0[\s\S]*当前没有可分配的数据/u);
  assert.match(manager, /需人工关注的任务不在自动分配队列中/u);
  assert.match(manager, /待新任务进入未分配的待审核队列后，即可执行定量分配/u);
  assert.match(manager, /待新任务进入未分配的待审核队列后，系统会按配置自动补位/u);
});
