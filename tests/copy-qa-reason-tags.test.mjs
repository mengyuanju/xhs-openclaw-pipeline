import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  COPY_QA_REASON_GROUPS,
  COPY_QA_SYSTEM_REASONS,
  copyQaReasonLabels,
} from '../src/copy-qa-reasons.mjs';
import { resolveCopyQaReasonSnapshots } from '../server/src/copy-qa-reason-tags.mjs';

const projectFile = (path) => new URL(`../${path}`, import.meta.url);
const actor = Object.freeze({ userId: 91, username: 'qa-reviewer', role: 'REVIEWER' });

test('copy QA system taxonomy is complete, grouped and stable', () => {
  assert.deepEqual(COPY_QA_REASON_GROUPS.map((group) => group.code), ['TITLE', 'BODY', 'PLAN']);
  assert.equal(COPY_QA_SYSTEM_REASONS.length, 22);
  assert.deepEqual(Object.fromEntries(COPY_QA_REASON_GROUPS.map((group) => [
    group.code,
    COPY_QA_SYSTEM_REASONS.filter((reason) => reason.group === group.code).length,
  ])), { TITLE: 6, BODY: 10, PLAN: 6 });
  assert.equal(new Set(COPY_QA_SYSTEM_REASONS.map((reason) => reason.code)).size, 22);
  assert.ok(COPY_QA_SYSTEM_REASONS.every((reason) => reason.code.length <= 50 && reason.label.length > 0));
  assert.equal(COPY_QA_SYSTEM_REASONS.find((reason) => reason.code === 'PLAN_DETAIL_MISMATCH')?.label,
    '与正文细节/数据不一致');
});

test('submitted verdict snapshots keep private custom labels readable', async () => {
  const publicId = '11111111-1111-4111-8111-111111111111';
  const queries = [];
  const snapshots = await resolveCopyQaReasonSnapshots({ query: async (sql, values) => {
    queries.push({ sql: String(sql), values });
    return { rows: [{
      public_id: publicId,
      group_code: 'BODY',
      label: '开头铺垫过长',
      visibility: 'PRIVATE',
      status: 'ACTIVE',
      owner_account_id: actor.userId,
    }] };
  } }, ['TITLE_AI_TONE', `CUSTOM:${publicId}`, 'HISTORICAL_REASON'], actor);

  assert.deepEqual(snapshots.map(({ group, label, source }) => ({ group, label, source })), [
    { group: 'TITLE', label: 'AI感严重', source: 'SYSTEM' },
    { group: 'BODY', label: '开头铺垫过长', source: 'CUSTOM' },
    { group: 'BODY', label: 'HISTORICAL_REASON', source: 'LEGACY' },
  ]);
  assert.equal(queries.length, 1);
  assert.deepEqual(copyQaReasonLabels(snapshots.map((snapshot) => snapshot.code), snapshots),
    ['AI感严重', '开头铺垫过长', 'HISTORICAL_REASON']);
});

test('unavailable private custom labels cannot be forged into a return', async () => {
  const publicId = '22222222-2222-4222-8222-222222222222';
  await assert.rejects(resolveCopyQaReasonSnapshots({ query: async () => ({ rows: [] }) }, [
    `CUSTOM:${publicId}`,
  ], actor), { code: 'REASON_TAG_UNAVAILABLE' });
});

test('copy QA tag migration and both review surfaces preserve scoped reusable labels', async () => {
  const [migration, service, picker, standalone, workMode, worker] = await Promise.all([
    readFile(projectFile('server/migrations/0080_copy_qa_reason_tags.sql'), 'utf8'),
    readFile(projectFile('server/src/copy-qa-reason-tags.mjs'), 'utf8'),
    readFile(projectFile('app/copy-qa/copy-qa-reason-picker.tsx'), 'utf8'),
    readFile(projectFile('app/copy-qa/copy-qa-workbench.tsx'), 'utf8'),
    readFile(projectFile('app/work-mode/work-quality-editor.tsx'), 'utf8'),
    readFile(projectFile('app/workbench/task-review-dialog.tsx'), 'utf8'),
  ]);
  assert.match(migration, /CREATE TABLE copy_qa_reason_tags/u);
  assert.match(migration, /visibility IN \('PRIVATE', 'PUBLIC'\)/u);
  assert.match(migration, /status IN \('ACTIVE', 'PENDING', 'DISABLED'\)/u);
  assert.match(service, /THEN \$5::bigint ELSE NULL/u);
  assert.match(service, /THEN \$6::varchar ELSE NULL/u);
  assert.match(picker, /添加我的标签/u);
  assert.match(picker, /REQUEST_PUBLIC/u);
  assert.match(picker, /PUBLISH/u);
  assert.ok((standalone.match(/<CopyQaReasonPicker/gu) ?? []).length >= 2);
  assert.match(workMode, /<CopyQaReasonPicker/u);
  assert.match(worker, /copyQaReasonLabels/u);
  assert.match(worker, /reworkReasonSnapshots/u);
});
