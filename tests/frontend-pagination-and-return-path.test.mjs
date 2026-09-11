import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { normalizeCopyQaPage } from '../app/copy-qa/types.ts';
import {
  normalizePackagePage,
  queryPackageItemPage,
  QUERY_PACKAGE_ITEM_PAGE_SIZE,
  QUERY_PACKAGE_SELECTION_LIMIT,
  updateQueryItemSelection,
} from '../app/query-packages/types.ts';
import { resolveLoginReturnPath } from '../app/login/return-path.ts';

const copyWorkbenchUrl = new URL('../app/copy-qa/copy-qa-workbench.tsx', import.meta.url);
const queryWorkbenchUrl = new URL('../app/query-packages/query-package-workbench.tsx', import.meta.url);
const deliveryWorkbenchUrl = new URL('../app/delivery-pool/delivery-pool-workbench.tsx', import.meta.url);
const modularE2eFixtureUrl = new URL('./fixtures/modular-workflow-e2e.mjs', import.meta.url);

function copyQaRow(id = '12345678-1234-4234-8234-123456789abc') {
  return {
    id,
    freezePublicId: '22345678-1234-4234-8234-123456789abc',
    anonymousCode: 'QA-001',
    blindReview: true,
    status: 'PENDING',
    sampleKind: 'RANDOM',
    approvedRevision: { content: '稿件', revisionToken: 'revision-token', contentSha256: 'hash' },
    productionBatch: { anonymousCode: 'BATCH-001' },
    capabilities: { canPass: true, canReturnSingle: true, canReturnBatch: false },
  };
}

function packageRow(id = 1) {
  return {
    id,
    name: `词包 ${id}`,
    status: 'SCREENING',
    version: 1,
    counts: { total: 10, pending: 10, selected: 0, rejected: 0, produced: 0 },
    createdAt: '2026-09-10T00:00:00.000Z',
  };
}

test('copy QA and Query package page adapters preserve pagination metadata and legacy arrays', () => {
  assert.deepEqual(normalizeCopyQaPage({ items: [copyQaRow()], total: 51 }), {
    items: normalizeCopyQaPage([copyQaRow()]).items,
    total: 51,
    returnedCount: 1,
  });
  assert.equal(normalizeCopyQaPage([copyQaRow()]).total, null);
  assert.equal(normalizeCopyQaPage({ items: [copyQaRow()], total: null }).total, null);

  assert.deepEqual(normalizePackagePage({ items: [packageRow()], total: 88 }), {
    items: normalizePackagePage([packageRow()]).items,
    total: 88,
    returnedCount: 1,
  });
  assert.equal(normalizePackagePage([packageRow()]).total, null);
  assert.equal(normalizePackagePage({ items: [packageRow()], total: null }).total, null);
});

test('copy QA requests the selected status from the server and exposes load-more scope honestly', async () => {
  const source = await readFile(copyWorkbenchUrl, 'utf8');
  assert.match(source, /const params = new URLSearchParams\(\{[\s\S]*?status,[\s\S]*?limit: String\(COPY_QA_LIST_LIMIT\),[\s\S]*?offset: String\(offset\)/u);
  assert.match(source, /copy-qa\/items\?\$\{params\.toString\(\)\}/u);
  assert.match(source, /role === 'ADMIN' && queryPackageName[\s\S]*params\.set\('queryPackageName', queryPackageName\)/u);
  assert.match(source, /aria-label="按词包名称筛选全部抽检项"/u);
  assert.match(source, /!item\.blindReview && <small>词包：\{item\.productionBatch\.queryPackageName \?\? '未归属词包'\}/u);
  assert.match(source, /!detail\.blindReview && <section[\s\S]*词包名称[\s\S]*detail\.productionBatch\.queryPackageName/u);
  assert.match(source, /load\(\{ silent: true, offset: nextOffset \}\)/u);
  assert.match(source, /仅作用于当前已加载/u);
  assert.doesNotMatch(source, /copy-qa\/items\?status=ALL['"`]/u,
    'historical rows must not starve the default pending queue');
});

test('copy QA keeps the review-mode control admin-only', async () => {
  const source = await readFile(copyWorkbenchUrl, 'utf8');
  assert.match(source, /\{role === 'ADMIN' && <label>评审模式<Select/u);
  assert.match(source, /role !== 'ADMIN' \|\| mode === 'ALL'/u,
    'reviewer rows must not be filtered by local review-mode state');
  assert.match(source, /样本评审模式由管理员预先决定，审核员不可切换或更改/u);
});

test('visible Query packages page through the server and render at most one detail page', async () => {
  const source = await readFile(queryWorkbenchUrl, 'utf8');
  assert.match(source, /query-packages\?limit=\$\{QUERY_PACKAGE_LIST_LIMIT\}&offset=\$\{offset\}/u);
  assert.match(source, /load\(\{ silent: true, offset: nextPackageOffset \}\)/u);
  assert.equal(QUERY_PACKAGE_ITEM_PAGE_SIZE, 100);
  assert.equal(QUERY_PACKAGE_SELECTION_LIMIT, 5_000);
  const largePackage = Array.from({ length: 5_000 }, (_, index) => index + 1);
  assert.deepEqual(queryPackageItemPage(largePackage, 50).items, largePackage.slice(4_900, 5_000));
  assert.deepEqual(updateQueryItemSelection([], largePackage, true), largePackage);
  assert.deepEqual(updateQueryItemSelection(largePackage, largePackage.slice(100, 200), false), [
    ...largePackage.slice(0, 100),
    ...largePackage.slice(200),
  ]);
  assert.match(source, /queryPackageItemPage\(visibleItems, itemPage\)/u);
  assert.match(source, /pagedItems\.map/u);
  assert.doesNotMatch(source, /<tbody>\{visibleItems\.map/u);
  assert.match(source, /new Set\(checkedItemIds\)/u);
  assert.match(source, /deletePreview\?\.packageId !== deletePackage\.id/u,
    'only the preview belonging to the currently open package may authorize deletion');
  assert.match(source, /deletePreviewRequest\.current\?\.controller\.abort\(\)/u);
});

test('administrator delivery pagination advances by the server page offset instead of merged row count', async () => {
  const source = await readFile(deliveryWorkbenchUrl, 'utf8');
  assert.match(source, /const followingOffset = offset \+ page\.items\.length/u);
  assert.match(source, /load\(nextOffset\)/u);
  assert.doesNotMatch(source, /load\(entries\.length\)/u);
  assert.match(source, /文本搜索只覆盖已加载条目/u);
});

test('development E2E fixture mirrors delegated screening, automatic Query production, pagination and held-item closure', async () => {
  const source = await readFile(modularE2eFixtureUrl, 'utf8');
  assert.match(source, /MODULAR_E2E_PAGINATION_SEED === '1'/u);
  assert.match(source, /queryPackageVersion: 3/u);
  assert.match(source, /send\(res, 200, page\.items\.map\(packageSummary\)\)/u,
    'Query package fixture pages must match the current bare-array server response');
  assert.match(source, /const visiblePackages = actorRole\(req\) === 'ADMIN'[\s\S]*?state\.packages\.filter\(\(record\) => canAccessPackage\(req, record\)\)[\s\S]*?paginate\(url, visiblePackages\)/u,
    'non-administrators must only receive Query packages assigned to their exact account');
  assert.match(source, /function createFixtureProductionBatch[\s\S]*?createdByUserId: record\.createdByUserId \?\? 'admin'[\s\S]*?assignedToUserId: null[\s\S]*?assignmentSource: null[\s\S]*?item\.status = 'TASK_CREATED'/u,
    'passing a Query must create unassigned copy work under the package creator and mark the source row as produced');
  assert.match(source, /if \(method === 'PUT' && screenMatch\)[\s\S]*?createFixtureProductionBatch\(record, selectedItems,[\s\S]*?record\.status = packageStatus\(record\)[\s\S]*?send\(res, 200, packageSummary\(record\)\)/u,
    'screening must atomically model the automatic production path');
  assert.match(source, /if \(item\.screeningDecision === 'SELECTED'\) selectedItems\.push\(item\)/u,
    'rejected Query rows must not enter the fixture production batch');
  assert.match(source, /if \(method === 'PATCH' && assigneeMatch\)[\s\S]*?actorRole\(req\) !== 'ADMIN'[\s\S]*?hasUsername !== hasAccountId[\s\S]*?record\.assignedToAccountId = assignee\?\.id \?\? null/u,
    'the fixture assignment route must be administrator-only and require a complete stable assignee identity');
  assert.match(source, /function actorUser\(req\)[\s\S]*?x-actor-user-id[\s\S]*?x-actor-credential-version[\s\S]*?user\.id !== userId[\s\S]*?user\.credentialVersion !== credentialVersion/u,
    'the fixture must authenticate the stable account id and credential version instead of trusting username or role headers');
  assert.match(source, /const actor = actorUser\(req\);[\s\S]*?error\(res, 401, 'SESSION_STALE'/u,
    'protected fixture routes must reject stale or forged actor identities before authorization');
  assert.match(source, /url\.pathname === '\/v1\/users'[\s\S]*?actor\.role !== 'ADMIN'[\s\S]*?error\(res, 403, 'FORBIDDEN'/u,
    'the fixture user directory must remain administrator-only');
  assert.match(source, /if \(method === 'POST' && productionMatch\)[\s\S]*?actorRole\(req\) !== 'ADMIN'[\s\S]*?createFixtureProductionBatch\(record, items,/u,
    'the explicit production route remains only as a historical compatibility path');
  assert.match(source, /send\(res, 200, page\.items\.map\(\(item\) => qaItemFor\(req, item\)\)\)/u,
    'copy QA fixture pages must match the current bare-array server response');
  assert.match(source, /actorRole\(req\) === 'REVIEWER' && item\.status === 'NOT_SELECTED'[\s\S]{0,160}error\(res, 404, 'QA_ITEM_NOT_FOUND'/u,
    'reviewers must not retrieve held, unselected QA details by guessing an opaque id');
});

test('login returns each role only to an authorized workflow page', () => {
  const base = { homePath: '/workbench/personal', mustChangePassword: false };
  assert.equal(resolveLoginReturnPath({ ...base, role: 'USER', requestedPath: '/query-packages' }), '/query-packages');
  assert.equal(resolveLoginReturnPath({ ...base, role: 'USER', requestedPath: '/delivery-pool?task=1' }), base.homePath);
  assert.equal(resolveLoginReturnPath({ ...base, role: 'USER', requestedPath: '/workbench/completed' }), base.homePath);
  assert.equal(resolveLoginReturnPath({ ...base, role: 'USER', requestedPath: '/workbench/personal?taskId=7' }), '/workbench/personal?taskId=7');
  assert.equal(resolveLoginReturnPath({ ...base, role: 'REVIEWER', requestedPath: '/copy-qa' }), '/copy-qa');
  assert.equal(resolveLoginReturnPath({ ...base, role: 'REVIEWER', requestedPath: '/knowledge' }), base.homePath);
  assert.equal(resolveLoginReturnPath({ ...base, role: 'REVIEWER', requestedPath: '/query-packages' }), '/query-packages');
  assert.equal(resolveLoginReturnPath({ ...base, role: 'USER', requestedPath: '/copy-qa' }), base.homePath);
  assert.equal(resolveLoginReturnPath({ ...base, role: 'ADMIN', requestedPath: '/settings' }), '/settings');
  assert.equal(resolveLoginReturnPath({ ...base, role: 'ADMIN', requestedPath: '//evil.example' }), base.homePath);
  assert.equal(resolveLoginReturnPath({ ...base, role: 'ADMIN', requestedPath: '/\\evil.example' }), base.homePath);
  for (const separator of ['\t', '\n', '\r', '\u0000', '\u001f', '\u007f']) {
    const requestedPath = `/${separator}/evil.example`;
    const resolved = resolveLoginReturnPath({ ...base, role: 'ADMIN', requestedPath });
    assert.equal(resolved, base.homePath);
    assert.equal(new URL(resolved, 'https://local.example').origin, 'https://local.example');
  }
  assert.equal(resolveLoginReturnPath({ ...base, role: 'USER', requestedPath: '/query-packages-evil' }), base.homePath);
  assert.equal(resolveLoginReturnPath({ ...base, role: 'USER', requestedPath: '/delivery-pool', mustChangePassword: true }), '/profile');
});
