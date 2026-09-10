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

test('the Query package page admits and renders only administrators', async () => {
  const page = await readFile(queryPageUrl, 'utf8');
  assert.match(page, /if \(role !== 'ADMIN'\) redirect\(role === 'REVIEWER' \? '\/copy-qa' : '\/workbench\/personal'\)/u);
  assert.match(page, /<QueryPackageWorkbench \/>/u);
});

test('query package filters keep their longest options on one line', async () => {
  const [source, styles] = await Promise.all([
    readFile(queryWorkbenchUrl, 'utf8'),
    readFile(queryStylesUrl, 'utf8'),
  ]);

  assert.equal(source.match(/<SelectTrigger className=\{styles\.filterSelect\}>/gu)?.length, 2);
  assert.match(styles, /\.filterSelect\s*\{[^}]*min-width:\s*148px;/su);
});

test('Query package screening is pending-first and no longer exposes assignment or manual production', async () => {
  const source = await readFile(queryWorkbenchUrl, 'utf8');
  assert.match(source, /useState<QueryPackageItemFilter>\('PENDING'\)/u);
  assert.match(source, /setItemStatus\('PENDING'\)/u);
  assert.match(source, /自动进入文案生成/u);
  assert.match(source, /\['INVALID', 'DUPLICATE'\]\.includes\(item\.validationStatus\)[\s\S]*DECISION_LABELS\[item\.screeningDecision\]/u,
    'a produced row must still display its screening decision in the screening-result column');
  assert.doesNotMatch(source, /openAssignment|assignPackage|负责人|\/assignee/u);
  assert.doesNotMatch(source, /production-batches|创建生产批次|本次投产/u);
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
