import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  PENDING_IMAGE_EDIT_STATUSES,
  assertNoPendingImageEdits,
  createReadyDeliveryEntry,
} from '../src/final-delivery.mjs';

test('pending image edits use a conflict error instead of a generic validation error', async () => {
  const calls = [];
  const queryable = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ count: 2 }] };
    },
  };

  await assert.rejects(
    assertNoPendingImageEdits(queryable, {
      taskId: 7,
      imageRunId: '123e4567-e89b-12d3-a456-426614174000',
    }),
    (error) => {
      assert.equal(error.code, 'IMAGE_EDITS_PENDING');
      assert.match(error.message, /2 个待处理的图片修改/u);
      assert.match(error.message, /采用、拒绝或取消/u);
      return true;
    },
  );
  assert.deepEqual(calls[0].values, [
    7,
    '123e4567-e89b-12d3-a456-426614174000',
    PENDING_IMAGE_EDIT_STATUSES,
  ]);
});

test('completed image edits do not block image review', async () => {
  const queryable = { async query() { return { rows: [{ count: 0 }] }; } };
  assert.equal(await assertNoPendingImageEdits(queryable, {
    taskId: 8,
    imageRunId: '123e4567-e89b-12d3-a456-426614174001',
  }), 0);
});

test('a real-pipeline test run completes review without creating customer delivery inventory', async () => {
  const calls = [];
  const queryable = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (/SELECT task\.input/u.test(sql)) {
        return { rows: [{
          input: { testRun: true, testScope: 'IMAGE_EDIT_FULL_E2E' },
          image_qc_legacy_accepted: false,
          release_event_id: 17,
        }] };
      }
      if (/UPDATE delivery_entries/u.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  const result = await createReadyDeliveryEntry(queryable, {
    taskId: 264,
    copyRevisionId: 458,
    imageRunId: '123e4567-e89b-12d3-a456-426614174002',
    actor: { userId: 1, username: 'admin' },
  });

  assert.equal(result, null);
  assert.equal(calls.length, 2);
  assert.match(calls[1].sql, /status = 'WITHDRAWN'/u);
  assert.deepEqual(calls[1].values, [264]);
});

test('test-task isolation migration withdraws legacy inventory and queues preview revocation', async () => {
  const sql = await readFile(new URL('../migrations/0063_test_task_delivery_isolation.sql', import.meta.url), 'utf8');
  assert.match(sql, /task\.input @> '\{"testRun":true\}'::jsonb/u);
  assert.match(sql, /delivery\.status = 'READY'/u);
  assert.match(sql, /SET status = 'WITHDRAWN'/u);
  assert.match(sql, /'TEST_TASK_EXCLUDED', 'PENDING'/u);
  assert.match(sql, /ON CONFLICT\(preview_id\) DO UPDATE/u);
  assert.doesNotMatch(sql, /DELETE\s+FROM|TRUNCATE|DROP\s+TABLE/iu);
});
