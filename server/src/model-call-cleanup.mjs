import { normalizeTaskId } from './domain.mjs';

function bounded(value, fallback, maximum) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

/** Called in the transaction that creates the delivery, while its task is locked. */
export async function scheduleDeliveryModelCallCleanup(client, deliveryEntryId, taskId) {
  await client.query(`INSERT INTO delivery_model_call_cleanup(delivery_entry_id,task_id,execution_ids)
    SELECT delivery.id,delivery.task_id,ARRAY(
      SELECT execution.id FROM task_executions execution
      WHERE execution.task_id=delivery.task_id ORDER BY execution.id
    ) FROM delivery_entries delivery WHERE delivery.id=$1 AND delivery.task_id=$2
    ON CONFLICT (delivery_entry_id) DO NOTHING`,
  [normalizeTaskId(deliveryEntryId), normalizeTaskId(taskId)]);
}

/** Legacy entries only capture executions already finished at their delivery boundary. */
export async function backfillDeliveryModelCallCleanup(pool, { limit = 20 } = {}) {
  const result = await pool.query(`WITH cursor AS MATERIALIZED (
      SELECT * FROM delivery_model_call_cleanup_cursor WHERE singleton FOR UPDATE SKIP LOCKED
    ), page AS MATERIALIZED (
      SELECT delivery.* FROM delivery_entries delivery,cursor
      WHERE delivery.id>cursor.last_delivery_entry_id ORDER BY delivery.id LIMIT $1
    ), inserted AS (
    INSERT INTO delivery_model_call_cleanup(delivery_entry_id,task_id,execution_ids)
    SELECT delivery.id,delivery.task_id,ARRAY(
      SELECT execution.id FROM task_executions execution WHERE execution.task_id=delivery.task_id
        AND execution.status<>'RUNNING' AND execution.started_at<=delivery.created_at
        AND (execution.finished_at IS NULL OR execution.finished_at<=delivery.created_at)
      ORDER BY execution.id
    ) FROM page delivery
    WHERE delivery.status='READY' AND NOT EXISTS (
      SELECT 1 FROM delivery_model_call_cleanup job WHERE job.delivery_entry_id=delivery.id)
    ORDER BY delivery.id ON CONFLICT (delivery_entry_id) DO NOTHING
    RETURNING delivery_entry_id
    ), advanced AS (
      UPDATE delivery_model_call_cleanup_cursor SET last_delivery_entry_id=(SELECT max(id) FROM page)
      WHERE singleton AND EXISTS(SELECT 1 FROM page) RETURNING last_delivery_entry_id
    ) SELECT (SELECT count(*)::integer FROM inserted) AS inserted,
      (SELECT last_delivery_entry_id FROM advanced) AS last_id`, [bounded(limit, 20, 100)]);
  return result.rows[0].inserted;
}

/** Task -> job -> execution is the lock order; RUNNING executions are never deleted. */
export async function drainDeliveryModelCallCleanup(pool, { limit = 20, batchSize = 200 } = {}) {
  let deleted = 0, processed = 0;
  for (let index = 0; index < bounded(limit, 20, 100); index += 1) {
    const client = await pool.connect();
    let job;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query("SET LOCAL lock_timeout='500ms'");
      const candidate = (await client.query(`SELECT task.id AS task_id,job.delivery_entry_id
        FROM delivery_model_call_cleanup job JOIN tasks task ON task.id=job.task_id
        WHERE job.status<>'COMPLETE' AND job.next_attempt_at<=clock_timestamp()
        ORDER BY job.next_attempt_at,job.task_id,job.delivery_entry_id
        LIMIT 1 FOR UPDATE OF task SKIP LOCKED`)).rows[0];
      if (!candidate) { await client.query('COMMIT'); break; }
      job = (await client.query(`SELECT * FROM delivery_model_call_cleanup
        WHERE delivery_entry_id=$1 AND status<>'COMPLETE'
        AND next_attempt_at<=clock_timestamp() FOR UPDATE SKIP LOCKED`, [candidate.delivery_entry_id])).rows[0];
      if (!job) { await client.query('COMMIT'); continue; }
      const executions = (await client.query(`SELECT id FROM task_executions
        WHERE task_id=$1 AND id=ANY($2::uuid[]) AND status<>'RUNNING'
        ORDER BY id FOR UPDATE SKIP LOCKED`, [job.task_id, job.execution_ids])).rows.map(row => row.id);
      const removed = executions.length ? (await client.query(`DELETE FROM model_call_traces
        WHERE id IN (SELECT id FROM model_call_traces WHERE task_id=$1 AND execution_id=ANY($2::uuid[])
          ORDER BY execution_id,sequence,id LIMIT $3 FOR UPDATE SKIP LOCKED)
        RETURNING id`, [job.task_id, executions, bounded(batchSize, 200, 1000)])).rows.length : 0;
      const remaining = (await client.query(`SELECT
        EXISTS(SELECT 1 FROM task_executions WHERE task_id=$1 AND id=ANY($2::uuid[]) AND status='RUNNING') AS active,
        EXISTS(SELECT 1 FROM model_call_traces WHERE task_id=$1 AND execution_id=ANY($2::uuid[])) AS records`,
      [job.task_id, job.execution_ids])).rows[0];
      const complete = !remaining.active && !remaining.records;
      await client.query(`UPDATE delivery_model_call_cleanup SET
        deleted_count=deleted_count+$2,attempts=attempts+1,last_error=NULL,
        status=$3::varchar,completed_at=CASE WHEN $3::varchar='COMPLETE' THEN clock_timestamp() ELSE NULL END,
        next_attempt_at=clock_timestamp()+CASE WHEN $3='COMPLETE' THEN interval '0 seconds'
          WHEN $4 THEN interval '15 seconds' ELSE interval '1 second' END
        WHERE delivery_entry_id=$1`, [job.delivery_entry_id, removed,
        complete ? 'COMPLETE' : remaining.active ? 'DEFERRED' : 'PENDING', remaining.active]);
      await client.query('COMMIT');
      deleted += removed; processed += 1;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (job) {
        // ROLLBACK reset both SET LOCAL timeouts. Error recording gets its own
        // short transaction so another cleanup's row lock cannot hold this
        // connection (or server shutdown) indefinitely.
        try {
          await client.query('BEGIN');
          await client.query("SET LOCAL statement_timeout='5s'");
          await client.query("SET LOCAL lock_timeout='500ms'");
          await client.query(`UPDATE delivery_model_call_cleanup SET attempts=attempts+1,
            next_attempt_at=clock_timestamp()+interval '30 seconds',last_error=$2
            WHERE delivery_entry_id=$1 AND status<>'COMPLETE'`,
          [job.delivery_entry_id, `清理暂未完成（${String(error.code ?? 'UNKNOWN').slice(0, 40)}）`]);
          await client.query('COMMIT');
        } catch { await client.query('ROLLBACK').catch(() => {}); }
      }
      throw error;
    } finally { client.release(); }
  }
  return { processed, deleted };
}

export async function readModelCallCleanup(pool, taskId) {
  const result = await pool.query(`SELECT delivery_entry_id AS "deliveryEntryId",status,
    deleted_count::float8 AS "deletedCount",captured_at AS "capturedAt",completed_at AS "completedAt"
    FROM delivery_model_call_cleanup WHERE task_id=$1
    ORDER BY delivery_entry_id DESC LIMIT 1`, [normalizeTaskId(taskId)]);
  return result.rows[0] ?? null;
}
