import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { requestIdAt } from '../../tests/fixtures/claim-request-id.mjs';

export async function verifyExecutionRecovery({ repo, pool, enqueue, controlPlane }) {
  await repo.registerNode({ nodeId: 'recovery', copyConcurrency: 10, imageConcurrency: 2, imageWorkerEnabled: true });
  // These are fixtures in a disposable PostgreSQL cluster, never production tasks.
  for (let i = 0; i < 6; i++) await enqueue('recovery', 'COPY_QUEUED', { frozen: 'copy' });
  const receipt = await repo.claimCopyBatch({ nodeId: 'recovery', limit: 10, requestId: requestIdAt() });
  const [legacy, lost, stuck, healthy, fresh, completed] = receipt.claims;
  await enqueue('recovery', 'IMAGE_QUEUED', { frozen: 'image', visualPlanCheckpoint: { preserved: true } });
  const image = await repo.claimImage('recovery', 1, 2);
  await pool.query('UPDATE image_runs SET result = $1 WHERE id = $2', [{ savedPlan: true }, image.execution.id]);
  const ids = [legacy, lost, stuck, image].map(c => c.execution.id);
  const traceId = randomUUID();
  await repo.recordModelCall(legacy.execution.id, traceId, { sequence: 1, stage: 'ORIGINAL_GENERATION',
    provider: 'fake', operation: 'TEXT', model: 'fake', prompt: 'fixture', request: '{}',
    status: 'RUNNING', startedAt: new Date(Date.now() - 4 * 3600000).toISOString() });
  await pool.query(`UPDATE task_executions SET last_activity_at = now() - interval '4 hours'
    WHERE id = ANY($1::uuid[])`, [[legacy.execution.id, image.execution.id]]);
  await pool.query(`UPDATE task_executions SET heartbeat_at = now() - interval '3 minutes' WHERE id = $1`, [lost.execution.id]);
  await pool.query(`UPDATE task_executions SET heartbeat_at = now(), last_activity_at = now() - interval '31 minutes'
    WHERE id = $1`, [stuck.execution.id]);
  await pool.query(`UPDATE task_executions SET heartbeat_at = now(), last_activity_at = now() - interval '20 minutes'
    WHERE id = $1`, [healthy.execution.id]);
  await repo.completeCopy(completed.execution.id, { fake: true });
  const before = await repo.getTask(healthy.task.id);
  const heartbeat = await controlPlane.heartbeatExecutions({ nodeId: 'recovery', executionIds:
    [healthy, fresh, lost, stuck, completed].map(c => c.execution.id) });
  assert.deepEqual(new Set(heartbeat.activeExecutionIds), new Set([healthy, fresh].map(c => c.execution.id)));
  assert.deepEqual(new Set(heartbeat.staleExecutionIds), new Set([lost, stuck, completed].map(c => c.execution.id)));
  assert.deepEqual((await repo.getTask(healthy.task.id)).lastActivityAt, before.lastActivityAt, 'heartbeat is not progress');
  assert.deepEqual((await repo.heartbeatExecutions({ nodeId: 'a', executionIds: [healthy.execution.id] })).activeExecutionIds, []);
  const recovered = (await Promise.all([repo.recoverStaleExecutions(), repo.recoverStaleExecutions()])).flat();
  assert.deepEqual(new Set(recovered.map(e => e.id)), new Set(ids));
  assert.equal(recovered.length, ids.length, 'concurrent sweepers recover each execution once');
  assert.deepEqual(await repo.recoverStaleExecutions(), []);
  for (const claim of [legacy, lost, stuck, image]) {
    const task = await repo.getTask(claim.task.id);
    assert.equal(task.state, `${claim.execution.kind}_FAILED`);
    assert.equal(task.currentExecutionId, null);
    assert.match(task.error, /结果.*未确认/u);
    assert.equal(task.executions[0].status, 'FAILED');
    assert.deepEqual(task.executions[0].snapshot, claim.execution.snapshot, 'preserve frozen inputs');
    await assert.rejects(repo.updateProgress(claim.execution.id, { stage: 'LATE', progressPercent: 99, message: 'late' }), { code: 'STALE_EXECUTION' });
  }
  assert.equal((await repo.getTask(healthy.task.id)).state, 'COPY_RUNNING');
  assert.equal((await repo.getTask(fresh.task.id)).state, 'COPY_RUNNING');
  assert.equal((await repo.getTask(completed.task.id)).state, 'COPY_REVIEW_PENDING');
  const imageTask = await repo.getTask(image.task.id);
  assert.equal(imageTask.imageRuns[0].status, 'FAILED');
  assert.deepEqual(imageTask.imageRuns[0].result, { savedPlan: true });
  const trace = await repo.getModelCall(legacy.task.id, traceId);
  assert.equal(trace.status, 'FAILED');
  assert.match(trace.error, /结果.*未确认/u);
  await assert.rejects(repo.recordModelCall(legacy.execution.id, randomUUID(), { sequence: 2, stage: 'LATE',
    provider: 'fake', operation: 'TEXT', model: 'fake', prompt: 'fixture', request: '{}',
    status: 'RUNNING', startedAt: new Date().toISOString() }), /not found/);
  await assert.rejects(repo.completeCopy(legacy.execution.id, { late: true }), { code: 'STALE_EXECUTION' });
  const replay = await repo.claimCopyBatch({ nodeId: 'recovery', limit: 10, requestId: receipt.requestId });
  assert.equal(replay.claims.find(c => c.execution.id === legacy.execution.id).execution.status, 'FAILED');
  assert.equal((await repo.listNodes()).find(n => n.id === 'recovery').copyRunningCount, 2);
  await enqueue('recovery');
  assert.ok(await repo.claimCopy('recovery'), 'freed capacity can receive new work');

  // A failed task update rolls the execution and trace changes back together.
  await enqueue('recovery');
  const rollback = await repo.claimCopy('recovery');
  await pool.query(`UPDATE task_executions SET heartbeat_at = now() - interval '3 minutes' WHERE id = $1`, [rollback.execution.id]);
  await pool.query(`ALTER TABLE tasks ADD CONSTRAINT recovery_test_rollback
    CHECK (id <> ${Number(rollback.task.id)} OR state <> 'COPY_FAILED')`);
  await assert.rejects(repo.recoverStaleExecutions(), { code: '23514' });
  assert.equal((await repo.getTask(rollback.task.id)).executions[0].status, 'RUNNING');
  await pool.query('ALTER TABLE tasks DROP CONSTRAINT recovery_test_rollback');
  await repo.recoverStaleExecutions();
  assert.equal((await repo.getTask(rollback.task.id)).state, 'COPY_FAILED');

  // Pause an upload immediately after validating its execution, before INSERT.
  // Recovery must respect that validation's transaction lock.
  await enqueue('recovery', 'IMAGE_QUEUED');
  const uploading = await repo.claimImage('recovery', 1, 2);
  await pool.query(`UPDATE task_executions SET heartbeat_at = now() - interval '3 minutes' WHERE id = $1`, [uploading.execution.id]);
  let entered, release;
  const validated = new Promise(resolve => { entered = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  let paused = false;
  const intercept = queryable => new Proxy(queryable, {
    get(target, key) {
      if (key === 'query') return async (...args) => {
        const result = await target.query(...args);
        if (!paused && /FROM task_executions e/u.test(args[0]) && /WHERE e.id = \$1/u.test(args[0])) {
          paused = true;
          entered();
          await resume;
        }
        return result;
      };
      if (key === 'connect') return async () => intercept(await target.connect());
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    },
  });
  const uploadingRepo = new repo.constructor({ pool: intercept(pool) });
  const assetInput = { executionId: uploading.execution.id, mediaType: 'image/png', byteSize: 1,
    sha256: 'a'.repeat(64), storagePath: 'isolated-fixture.png' };
  const writing = uploadingRepo.recordAsset(assetInput);
  let duringUpload;
  try {
    await validated;
    duringUpload = await repo.recoverStaleExecutions();
  } finally { release(); }
  const asset = await writing;
  assert.deepEqual(duringUpload, [], 'recovery cannot invalidate an upload between validation and insertion');
  assert.equal((await repo.recoverStaleExecutions())[0].id, uploading.execution.id);
  assert.equal((await repo.getAsset(asset.id)).imageRunId, uploading.execution.id, 'preserve assets committed before recovery');
  await assert.rejects(repo.recordAsset(assetInput), { code: 'STALE_EXECUTION' });
  assert.equal(Number((await pool.query('SELECT count(*) FROM assets WHERE image_run_id = $1', [uploading.execution.id])).rows[0].count), 1,
    'uploads after recovery cannot create new assets');
}
