import assert from 'node:assert/strict';
import test from 'node:test';

import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { hashUserPassword } from '../src/user-auth.mjs';

test('batch permanent deletion closes original production batches after every task row is detached', async () => {
  const passwordHash = await hashUserPassword('delete-secret');
  const calls = [];
  const deleted = [];
  const closedBatches = [];
  const tasks = new Map([
    [41, { id: 41, state: 'REVIEWED', production_batch_id: 70 }],
    [42, { id: 42, state: 'CANCELLED', cancelled_from_state: null, production_batch_id: 60 }],
    [43, { id: 43, state: 'REVIEWED', production_batch_id: 70 }],
  ]);
  const client = {
    release() {},
    async query(sql, values = []) {
      const source = String(sql).replace(/\s+/gu, ' ').trim();
      calls.push({ sql: source, values });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(source)) return { rows: [] };
      if (source.startsWith('SELECT * FROM app_users')) {
        return { rows: [{
          username: 'admin', role: 'ADMIN', status: 'ACTIVE', deletion_password_hash: passwordHash,
        }] };
      }
      if (source === 'SELECT * FROM tasks WHERE id = $1 FOR UPDATE') {
        const task = tasks.get(Number(values[0]));
        return { rows: task ? [{ ...task }] : [] };
      }
      if (source === 'DELETE FROM tasks WHERE id = $1') {
        deleted.push(Number(values[0]));
        tasks.delete(Number(values[0]));
        return { rows: [] };
      }
      if (source === 'SELECT * FROM production_batches WHERE id = $1 FOR UPDATE') {
        return { rows: [{
          id: Number(values[0]), public_id: `batch-${values[0]}`,
          status: 'OPEN', sampling_status: 'OPEN', version: 1,
        }] };
      }
      if (source.startsWith('SELECT COUNT(*) AS total_count')) {
        return { rows: [{
          // ON DELETE SET NULL preserves the immutable batch-member row, so an
          // all-deleted batch still has a non-zero frozen scope and no blockers.
          total_count: '1', approved_count: '0', cancelled_count: '0', blocker_task_ids: [],
        }] };
      }
      if (source === 'SELECT * FROM workflow_quality_settings WHERE singleton = 1') {
        return { rows: [{
          singleton: 1,
          query_package_worker_import_enabled: false,
          copy_sampling_enabled: true,
          copy_sampling_rate_bps: 2500,
          blind_review_enabled: true,
          reviewer_batch_return_enabled: false,
          sampling_seed: 'copy-sampling-v1',
          version: 4,
        }] };
      }
      if (source.startsWith('SELECT task.id AS task_id')) return { rows: [] };
      if (source.startsWith("UPDATE production_batches SET status = 'RELEASED'")) {
        closedBatches.push(Number(values[0]));
        return { rows: [] };
      }
      throw new Error(`unexpected SQL: ${source}`);
    },
  };
  const repository = new PostgresControlPlaneRepository({
    pool: { connect: async () => client },
  });

  const result = await repository.permanentlyDeleteTasks([43, 42, 41], {
    actorUsername: 'admin',
    deletionPassword: 'delete-secret',
  });

  assert.deepEqual(result, { succeeded: [41, 42, 43], failed: [] });
  assert.deepEqual(deleted, [41, 42, 43]);
  assert.deepEqual(closedBatches, [60, 70], 'original production batches close once in numeric order');
  const firstBatchLock = calls.findIndex(({ sql }) => sql === 'SELECT * FROM production_batches WHERE id = $1 FOR UPDATE');
  const lastDelete = calls.findLastIndex(({ sql }) => sql === 'DELETE FROM tasks WHERE id = $1');
  assert.ok(firstBatchLock > lastDelete, 'all task deletions complete before any batch closure is evaluated');
  assert.equal(calls.some(({ sql }) => sql.startsWith('INSERT INTO copy_sampling_freezes')), false,
    'an empty live population ends the batch without manufacturing a QA freeze');
  assert.equal(calls.at(-1).sql, 'COMMIT');
});
