import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';

const previousId = '44444444-4444-4444-8444-444444444444';

for (const useLatestConfig of [false, true]) {
  test(`image retry ${useLatestConfig ? 'starts fresh with latest configuration' : 'retains checkpoint lineage and owner'}`, async () => {
    let queuedSnapshot;
    const originalSnapshot = { task: { id: 13 }, copyRevision: { id: 2 }, prompts: {} };
    const client = {
      release() {},
      async query(sql, values) {
        if (sql.includes('SELECT * FROM tasks WHERE id')) {
          return { rows: [{ id: 13, state: 'IMAGE_FAILED', current_execution_id: null }] };
        }
        if (sql.includes('FROM task_executions')) {
          return { rows: [{ id: previousId, node_id: 'image-node', snapshot: originalSnapshot }] };
        }
        if (sql.includes('UPDATE tasks SET')) {
          queuedSnapshot = values[2];
          return { rows: [{ id: 13, state: 'IMAGE_QUEUED', progress_percent: 0 }] };
        }
        return { rows: [] };
      },
    };
    const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
    await repository.retryTask(13, { useLatestConfig });
    if (useLatestConfig) assert.equal(queuedSnapshot, null);
    else {
      assert.deepEqual(queuedSnapshot.imageRecovery, { nodeId: 'image-node', runIds: [previousId] });
      assert.deepEqual(queuedSnapshot.copyRevision, originalSnapshot.copyRevision);
      assert.equal(originalSnapshot.imageRecovery, undefined);
    }
  });
}

test('image claim restricts checkpoint recovery to the node holding the files', async () => {
  let selection;
  const client = {
    release() {},
    async query(sql, values) {
      if (sql.includes('SELECT * FROM executor_nodes')) return { rows: [{ id: 'other-node', image_worker_enabled: true }] };
      if (sql.includes('FOR UPDATE SKIP LOCKED')) selection = { sql, values };
      return { rows: [] };
    },
  };
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
  assert.equal(await repository.claimImage('other-node'), null);
  assert.deepEqual(selection.values, ['IMAGE_QUEUED', 'other-node', 1]);
  assert.match(selection.sql, /imageRecovery[\s\S]*nodeId[\s\S]*\$2/u);
});

test('image resume refuses to enqueue a fresh generation when its execution snapshot is missing', async () => {
  let enqueued = false;
  const client = {
    release() {},
    async query(sql) {
      if (sql.includes('SELECT * FROM tasks WHERE id')) {
        return { rows: [{ id: 13, state: 'IMAGE_FAILED', current_execution_id: null }] };
      }
      if (sql.includes('UPDATE tasks SET')) enqueued = true;
      return { rows: [] };
    },
  };
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
  await assert.rejects(repository.retryTask(13, { useLatestConfig: false }), {
    code: 'IMAGE_RECOVERY_UNAVAILABLE',
  });
  assert.equal(enqueued, false);
});
