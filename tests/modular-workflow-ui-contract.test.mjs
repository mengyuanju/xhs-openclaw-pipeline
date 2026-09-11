import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  applyQueryPackageScreening,
  normalizePackageDetail,
  queryPackageItemMatchesFilter,
} from '../app/query-packages/types.ts';

const queryWorkbenchUrl = new URL('../app/query-packages/query-package-workbench.tsx', import.meta.url);
const queryPageUrl = new URL('../app/query-packages/page.tsx', import.meta.url);
const queryStylesUrl = new URL('../app/query-packages/query-packages.module.css', import.meta.url);

test('the Query package page admits every current account role', async () => {
  const page = await readFile(queryPageUrl, 'utf8');
  assert.match(page, /if \(!\['ADMIN', 'REVIEWER', 'USER'\]\.includes\(role\)\) redirect\('\/workbench\/personal'\)/u);
  assert.match(page, /<QueryPackageWorkbench role=\{role as 'ADMIN' \| 'REVIEWER' \| 'USER'\} \/>/u);
});

test('query package filters keep their longest options on one line', async () => {
  const [source, styles] = await Promise.all([
    readFile(queryWorkbenchUrl, 'utf8'),
    readFile(queryStylesUrl, 'utf8'),
  ]);

  assert.equal(source.match(/<SelectTrigger className=\{styles\.filterSelect\}>/gu)?.length, 2);
  assert.match(styles, /\.filterSelect\s*\{[^}]*min-width:\s*148px;/su);
});

test('the Query screening header keeps text clear of the close button', async () => {
  const [source, styles] = await Promise.all([
    readFile(queryWorkbenchUrl, 'utf8'),
    readFile(queryStylesUrl, 'utf8'),
  ]);
  const mobileStyles = styles.slice(styles.indexOf('@media (max-width: 760px)'));

  assert.match(source, /<DialogContent className=\{styles\.screeningDialog\}>[\s\S]*className=\{styles\.screeningHead\}/u);
  assert.match(styles, /\.screeningHead\s*\{[^}]*padding:\s*20px 64px 16px 24px;/su);
  assert.match(mobileStyles, /\.screeningHead\s*\{[^}]*padding-right:\s*64px;/su);
});

test('the Query screening dialog keeps optional notices from displacing an empty result toolbar', async () => {
  const [source, styles] = await Promise.all([
    readFile(queryWorkbenchUrl, 'utf8'),
    readFile(queryStylesUrl, 'utf8'),
  ]);

  assert.match(source, /detail && !detailAllowsScreening && <div className="notice"/u,
    'ended packages render an extra read-only notice before the toolbar');
  assert.match(styles, /\.screeningDialog\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/su,
    'the dialog must accept optional vertical sections without assigning them to fixed grid rows');
  assert.match(styles, /\.screeningList\s*\{[^}]*min-height:\s*0;[^}]*flex:\s*1 1 auto;[^}]*overflow:\s*auto;/su,
    'the results region, rather than the toolbar, must consume the remaining dialog height');
  assert.doesNotMatch(styles, /\.screeningDialog\s*\{[^}]*grid-template-rows:/su);
});

test('Query package screening is pending-first, administrator-assignable, and has no manual production action', async () => {
  const source = await readFile(queryWorkbenchUrl, 'utf8');
  assert.match(source, /useState<QueryPackageItemFilter>\('PENDING'\)/u);
  assert.match(source, /setItemStatus\('PENDING'\)/u);
  assert.match(source, /自动进入文案生成/u);
  assert.match(source, /\['INVALID', 'DUPLICATE'\]\.includes\(item\.validationStatus\)[\s\S]*DECISION_LABELS\[item\.screeningDecision\]/u,
    'a produced row must still display its screening decision in the screening-result column');
  assert.match(source, /role === 'ADMIN'[\s\S]*openAssignment/u);
  assert.match(source, /\/v1\/query-packages\/\$\{assignPackage\.id\}\/assignee/u);
  assert.match(source, /!\['REVIEWER', 'USER'\]\.includes\(role\) \|\| status !== 'ACTIVE'\) continue/u);
  assert.match(source, /仅管理员（取消分配）/u);
  assert.match(source, /setAssignReady\(false\)[\s\S]*setAssignReady\(true\)/u);
  assert.match(source, /disabled=\{assignLoading \|\| !assignReady \|\| acting === 'assign'\}/u,
    'a failed assignee-list read must not turn Save into an accidental unassign action');
  assert.doesNotMatch(source, /production-batches|创建生产批次|本次投产/u);
});

test('Query package assignment fails closed for malformed or incomplete user lists', async () => {
  const source = await readFile(queryWorkbenchUrl, 'utf8');

  assert.match(source, /function userListFromPayload\(value: unknown\): UserDirectory \| null[\s\S]*Array\.isArray\(payload\?\.items\) \? payload\.items : null;[\s\S]*if \(entries === null\) return null;/u);
  assert.match(source, /if \(!Number\.isSafeInteger\(id\)[\s\S]*!\['ACTIVE', 'DISABLED'\]\.includes\(status\)\) return null;/u,
    'a malformed successful response must not be treated as a valid empty user list');
  assert.match(source, /const directory = userListFromPayload\(payload\);[\s\S]*if \(directory === null\) throw new Error\('中心返回的可分配用户列表不完整，请刷新后重试。'\);/u);
  assert.match(source, /const hasCurrentAssignment = item\.assignedToAccountId !== null && item\.assignedToUserId !== null;[\s\S]*const currentExists = directory\.identities\.some[\s\S]*if \(hasCurrentAssignment && !currentExists\)[\s\S]*当前筛选人不在可分配用户列表中/u,
    'a partial user list must not silently convert an existing assignment into unassigned');
  assert.match(source, /if \(hasAccountId !== hasUsername\) return '分配记录异常（仅管理员可筛选）'/u,
    'a half-cleared legacy assignment stays visibly inaccessible but can be repaired by an administrator');
  assert.ok(source.indexOf('if (hasCurrentAssignment && !currentExists)') < source.indexOf('setAssignReady(true)'),
    'assignment readiness is set only after the current assignee has been verified');
  assert.match(source, /directory\.assignableUsers\.find[\s\S]*directory\.identities\.some/u,
    'an existing but disabled assignee remains repairable without becoming an assignable target');
});

test('ended Query packages keep assignment management but render screening as read-only', async () => {
  const source = await readFile(queryWorkbenchUrl, 'utf8');

  assert.match(source, /const SCREENABLE_PACKAGE_STATUSES = new Set\(\['IMPORTED', 'SCREENING', 'READY', 'PARTIALLY_USED'\]\)/u);
  assert.match(source, /if \(!detail \|\| !packageAllowsScreening\(detail\.status\) \|\| !checkedItemIds\.length \|\| acting\) return/u);
  assert.match(source, /const detailAllowsScreening = detail !== null && packageAllowsScreening\(detail\.status\)/u);
  assert.match(source, /词包已结束，仅可查看历史筛选结果，不能继续通过或淘汰 Query/u);
  assert.match(source, /disabled=\{!detailAllowsScreening \|\| screenableItems\.length === 0\}/u,
    'the page-selection checkbox must be disabled for a read-only package');
  assert.match(source, /const screenable = detailAllowsScreening && item\.validationStatus === 'READY' && !item\.taskId/u,
    'row checkboxes must be disabled even when abandoned packages retain pending rows');
  assert.ok((source.match(/disabled=\{!detailAllowsScreening \|\| !checkedItemIds\.length \|\| Boolean\(acting\)\}/gu) ?? []).length >= 2,
    'both screening decisions must be disabled for a read-only package');
  assert.match(source, /role === 'ADMIN'[\s\S]*openAssignment\(item\)/u,
    'administrators retain assignment management so historical access can be revoked');
});

test('Query package mutations use request IDs that work without crypto.randomUUID', async () => {
  const source = await readFile(queryWorkbenchUrl, 'utf8');
  assert.match(source, /import \{ createRequestId \} from '\.\.\/components\/request-id';/u);
  assert.equal(source.match(/requestId: createRequestId\(\)/gu)?.length, 4);
  assert.doesNotMatch(source, /crypto\.randomUUID/u);
});

test('selected task-created Query items match both decision and creation filters', () => {
  const detail = normalizePackageDetail({
    id: 7,
    name: '回归词包',
    status: 'USED_UP',
    version: 2,
    counts: { total: 1, pending: 0, selected: 1, rejected: 0, produced: 1 },
    createdAt: '2026-09-10T00:00:00.000Z',
    items: [{
      id: 71,
      rowNumber: 1,
      query: '已通过且已创建作业',
      requestedImageCount: 'auto',
      status: 'selected',
      taskId: 701,
      version: 2,
    }],
  });
  assert.ok(detail);
  const [item] = detail.items;
  assert.equal(item.screeningDecision, 'SELECTED');
  assert.equal(item.validationStatus, 'TASK_CREATED');
  assert.equal(queryPackageItemMatchesFilter(item, 'PENDING'), false);
  assert.equal(queryPackageItemMatchesFilter(item, 'SELECTED'), true);
  assert.equal(queryPackageItemMatchesFilter(item, 'TASK_CREATED'), true);
});

test('a confirmed screening result removes an item from pending without losing the current detail', () => {
  const detail = normalizePackageDetail({
    id: 8,
    name: '待筛词包',
    status: 'SCREENING',
    version: 1,
    counts: { total: 1, pending: 1, selected: 0, rejected: 0, produced: 0 },
    createdAt: '2026-09-10T00:00:00.000Z',
    items: [{ id: 81, rowNumber: 1, query: '待筛 Query', status: 'READY', screeningDecision: 'PENDING', version: 1 }],
  });
  assert.ok(detail);
  const next = applyQueryPackageScreening(detail, {
    ...detail,
    status: 'USED_UP',
    version: 2,
    counts: { total: 1, pending: 0, selected: 1, rejected: 0, produced: 1 },
  }, [81], 'SELECTED');
  assert.equal(queryPackageItemMatchesFilter(next.items[0], 'PENDING'), false);
  assert.equal(queryPackageItemMatchesFilter(next.items[0], 'SELECTED'), true);
  assert.equal(next.version, 2);
});

test('an older screening confirmation cannot overwrite a newer package detail', () => {
  const latest = normalizePackageDetail({
    id: 9,
    name: '并发筛选词包',
    status: 'USED_UP',
    version: 3,
    counts: { total: 1, pending: 0, selected: 0, rejected: 1, produced: 0 },
    createdAt: '2026-09-10T00:00:00.000Z',
    items: [{ id: 91, rowNumber: 1, query: '已被后续操作淘汰', status: 'READY', screeningDecision: 'REJECTED', version: 3 }],
  });
  assert.ok(latest);
  const stale = applyQueryPackageScreening(latest, {
    ...latest,
    status: 'PARTIALLY_USED',
    version: 2,
    counts: { total: 1, pending: 0, selected: 1, rejected: 0, produced: 1 },
  }, [91], 'SELECTED');
  assert.strictEqual(stale, latest);
  assert.equal(stale.version, 3);
  assert.equal(stale.items[0].screeningDecision, 'REJECTED');
});
