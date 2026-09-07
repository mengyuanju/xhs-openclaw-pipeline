import { normalizeNodeId, normalizeUuid } from './domain.mjs';

// Heartbeats prove ownership/liveness, never business progress. A running process
// cannot keep a stuck stage alive indefinitely by continuing to send heartbeats.
const liveExecution = `e.last_activity_at > now() - interval '30 minutes'
  AND (e.heartbeat_at IS NULL OR e.heartbeat_at > now() - interval '2 minutes')`;

export async function heartbeatExecutions(pool, { nodeId: rawNodeId, executionIds }) {
  const nodeId = normalizeNodeId(rawNodeId);
  if (!Array.isArray(executionIds) || executionIds.length > 64) throw new TypeError('executionIds must contain at most 64 IDs');
  const ids = executionIds.map(id => normalizeUuid(id, 'executionId'));
  if (new Set(ids).size !== ids.length) throw new TypeError('executionIds must be unique');
  const result = await pool.query(`UPDATE task_executions e SET heartbeat_at = now()
    WHERE e.node_id = $1 AND e.id = ANY($2::uuid[]) AND e.status = 'RUNNING'
      AND ${liveExecution}
      AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = e.task_id AND t.current_execution_id = e.id
        AND t.state IN ('COPY_RUNNING', 'IMAGE_RUNNING'))
    RETURNING e.id`, [nodeId, ids]);
  const activeExecutionIds = result.rows.map(row => row.id);
  const active = new Set(activeExecutionIds);
  return { activeExecutionIds, staleExecutionIds: ids.filter(id => !active.has(id)) };
}

export async function recoverStaleExecutions(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Match the same task/execution locks used by completion. Multiple centers may
    // sweep concurrently; locked or already completed work is left alone.
    const { rows } = await client.query(`SELECT e.id, e.task_id, e.kind,
        e.last_activity_at <= now() - interval '30 minutes' AS progress_expired
      FROM task_executions e JOIN tasks t ON t.id = e.task_id AND t.current_execution_id = e.id
      WHERE e.status = 'RUNNING' AND t.state IN ('COPY_RUNNING', 'IMAGE_RUNNING')
        AND NOT (${liveExecution})
      ORDER BY e.id LIMIT 100 FOR UPDATE OF e, t SKIP LOCKED`);
    for (const execution of rows) {
      const message = execution.progress_expired
        ? 'EXECUTION_PROGRESS_TIMEOUT：超过30分钟没有阶段进度，执行结果未确认，已停止等待；请检查执行机后重试或续跑'
        : 'EXECUTION_HEARTBEAT_EXPIRED：超过2分钟未收到任务心跳，执行结果未确认，已停止等待；请检查执行机后重试或续跑';
      await client.query(`UPDATE task_executions SET status = 'FAILED', stage = 'FAILED',
        progress_message = $2::text, error = $2::text, finished_at = now() WHERE id = $1`, [execution.id, message]);
      await client.query(`UPDATE tasks SET state = $3, current_execution_id = NULL, current_stage = 'FAILED',
        progress_message = $2::text, error = $2::text, finished_at = now(), updated_at = now()
        WHERE id = $1 AND current_execution_id = $4`,
      [execution.task_id, message, `${execution.kind}_FAILED`, execution.id]);
      if (execution.kind === 'IMAGE') {
        await client.query(`UPDATE image_runs SET status = 'FAILED', finished_at = now()
          WHERE execution_id = $1 AND status = 'RUNNING'`, [execution.id]);
      }
      // Preserve payloads/checkpoints. Closing an unfinished trace records an
      // unknown outcome, not an invented provider response or generation duration.
      await client.query(`UPDATE model_call_traces SET status = 'FAILED', error = $2,
        finished_at = now(), duration_ms = NULL
        WHERE execution_id = $1 AND status = 'RUNNING'`, [execution.id, message]);
    }
    await client.query('COMMIT');
    return rows.map(({ id, task_id, kind }) => ({ id, taskId: Number(task_id), kind }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export function startExecutionRecovery(repository, { intervalMs = 15_000, log = console } = {}) {
  let running = null;
  const timer = setInterval(() => {
    if (running) return;
    running = repository.recoverStaleExecutions().then(recovered => {
      if (recovered.length) log.log(`Recovered ${recovered.length} interrupted execution(s).`);
    }).catch(error => log.error(`Execution recovery failed: ${error.message}`)).finally(() => { running = null; });
  }, intervalMs);
  timer.unref();
  return async () => { clearInterval(timer); await running; };
}
