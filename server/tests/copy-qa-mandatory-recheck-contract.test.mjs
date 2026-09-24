import assert from 'node:assert/strict';
import test from 'node:test';

import { releaseCopyQaFreeze } from '../src/copy-quality-control.mjs';

const FREEZE_PUBLIC_ID = '81818181-8181-4818-8818-818181818181';
const reviewer = Object.freeze({ userId: 91, username: 'qa-reviewer', role: 'REVIEWER' });
test('a synthetic mandatory round cannot be bypassed through release-rest', async () => {
  const calls = [];
  const client = {
    release() {},
    async query(sql, values = []) {
      const source = String(sql).replace(/\s+/gu, ' ').trim();
      calls.push({ sql: source, values });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(source)) return { rows: [] };
      if (source.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}] };
      if (source.startsWith('SELECT id FROM app_users')) return { rows: [{ id: reviewer.userId }] };
      if (source.startsWith('SELECT id FROM copy_sampling_freezes')) return { rows: [{ id: 99 }] };
      if (source.startsWith('SELECT task.id FROM copy_sampling_items')) return { rows: [] };
      if (source.startsWith('SELECT * FROM copy_sampling_freezes') && source.includes('WHERE id = $1')) {
        return { rows: [{ id: 99, public_id: FREEZE_PUBLIC_ID, status: 'REVIEW_REQUIRED', blind_review_enabled: true }] };
      }
      if (source.startsWith('SELECT * FROM copy_sampling_mutation_requests')) return { rows: [] };
      if (source.startsWith('INSERT INTO copy_sampling_events')) return { rows: [] };
      if (source.startsWith('SELECT COUNT(*) FILTER')) return { rows: [{ returned_random_count: '0' }] };
      throw new Error(`unexpected SQL: ${source}`);
    },
  };

  await assert.rejects(releaseCopyQaFreeze({ connect: async () => client }, FREEZE_PUBLIC_ID, {
    note: '错误尝试跳过强制复检',
    requestId: '91919191-9191-4919-8919-919191919191',
  }, { ...reviewer, role: 'ADMIN' }), { code: 'BATCH_NOT_RELEASABLE' });
  assert.equal(calls.some(({ sql }) => sql.startsWith('SELECT item.id, task.id AS task_id')), false);
  assert.equal(calls.some(({ sql }) => sql.startsWith('UPDATE tasks SET')), false);
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
});

test('release-rest excludes an unresolved returned task and updates only eligible member ids', async () => {
  const calls = [];
  const releasedTaskIds = [];
  const releasedItemIds = [];
  const client = {
    release() {},
    async query(sql, values = []) {
      const source = String(sql).replace(/\s+/gu, ' ').trim();
      calls.push({ sql: source, values });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(source)) return { rows: [] };
      if (source.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}] };
      if (source.startsWith('SELECT id FROM app_users')) return { rows: [{ id: reviewer.userId }] };
      if (source.startsWith('SELECT id FROM copy_sampling_freezes')) return { rows: [{ id: 18 }] };
      if (source.startsWith('SELECT task.id FROM copy_sampling_items')) return { rows: [] };
      if (source.startsWith('SELECT * FROM copy_sampling_freezes') && source.includes('WHERE id = $1')) {
        return { rows: [{
          id: 18, public_id: FREEZE_PUBLIC_ID, production_batch_id: 27,
          status: 'REVIEW_REQUIRED', blind_review_enabled: true,
        }] };
      }
      if (source.startsWith('SELECT * FROM copy_sampling_mutation_requests')) return { rows: [] };
      if (source.startsWith('SELECT COUNT(*) FILTER')) return { rows: [{ returned_random_count: '1' }] };
      if (source.startsWith('SELECT item.id, task.id AS task_id')) {
        assert.match(source, /returned\.status IN \('RETURNED', 'BATCH_AFFECTED', 'BATCH_RETURNED'\)/u);
        assert.match(source, /recheck\.sample_kind = 'MANDATORY_RECHECK'[\s\S]*recheck\.status IN \('PASSED', 'RELEASED'\)/u);
        return { rows: [{ id: 21, task_id: 102 }] };
      }
      if (source.startsWith("UPDATE tasks task SET state = 'IMAGE_QUEUED'")) {
        releasedTaskIds.push(102);
        return { rows: [{ id: 102 }] };
      }
      if (source.startsWith("UPDATE copy_sampling_items SET status = 'RELEASED'")) {
        releasedItemIds.push(...values[0].map(Number));
        return { rows: [] };
      }
      if (source.startsWith('UPDATE copy_sampling_freezes SET status = $2')) {
        return { rows: [{ production_batch_id: 27 }] };
      }
      if (source.startsWith('UPDATE production_batches SET status = $2')) return { rows: [] };
      if (source.startsWith('INSERT INTO copy_sampling_events')) return { rows: [] };
      if (source.startsWith('INSERT INTO copy_sampling_mutation_requests')) return { rows: [] };
      throw new Error(`unexpected SQL: ${source}`);
    },
  };

  const result = await releaseCopyQaFreeze({ connect: async () => client }, FREEZE_PUBLIC_ID, {
    note: '退回项继续返工，只放行无关等待成员',
    requestId: '92929292-9292-4929-8929-929292929292',
  }, { ...reviewer, role: 'ADMIN' });
  assert.deepEqual(result, {
    taskIds: [102],
    freezePublicId: FREEZE_PUBLIC_ID,
    status: 'RELEASED_WITH_EXCEPTIONS',
    releasedCount: 1,
  });
  assert.deepEqual(releasedTaskIds, [102]);
  assert.deepEqual(releasedItemIds, [21], 'status updates are scoped to the locked eligible rows, not the whole freeze');
});
