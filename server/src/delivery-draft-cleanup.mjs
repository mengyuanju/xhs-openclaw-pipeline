import { normalizeTaskId } from './domain.mjs';

const cursors = new WeakMap();

function bounded(value, fallback, maximum) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

// A READY entry alone is insufficient: a later rework may have saved new drafts.
const CURRENT_DELIVERY_SQL = `task.state='REVIEWED' AND task.task_kind='CONTENT'
  AND NOT (task.input @> '{"testRun":true}'::jsonb)
  AND EXISTS(SELECT 1 FROM delivery_entries delivery WHERE delivery.task_id=task.id
    AND delivery.status='READY' AND delivery.copy_revision_id=task.current_copy_revision_id
    AND delivery.image_run_id=task.current_image_run_id)
  AND (task.image_qc_legacy_accepted OR EXISTS(SELECT 1 FROM image_approval_events approval
    WHERE approval.id=task.image_qc_released_approval_event_id AND approval.task_id=task.id
      AND approval.copy_revision_id=task.current_copy_revision_id
      AND approval.image_run_id=task.current_image_run_id))`;

/** Called only after successful delivery creation, in its transaction with the task locked. */
export async function deleteDeliveredCopyReviewDrafts(client, taskId) {
  const result = await client.query('DELETE FROM copy_review_drafts WHERE task_id=$1', [normalizeTaskId(taskId)]);
  return result.rowCount;
}

/** Bounded legacy cleanup; the task lock serializes saves, delivery and rework. */
export async function drainDeliveredCopyReviewDrafts(pool, { limit = 20, batchSize = 200, maxDurationMs = 2000 } = {}) {
  const taskLimit = bounded(limit, 20, 100);
  const draftLimit = bounded(batchSize, 200, 1000);
  const deadline = Date.now() + bounded(maxDurationMs, 2000, 5000);
  const visited = [];
  const scanLimit = taskLimit * 100;
  let cursor = cursors.get(pool) ?? '0', wrapped = false, deleted = 0, processed = 0;
  while (processed < taskLimit && visited.length < scanLimit && Date.now() < deadline) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='2s'");
      await client.query("SET LOCAL lock_timeout='250ms'");
      // Read a bounded draft-ID page first. Stale draft statistics must not make
      // the planner scan every delivered task to find a few remaining drafts.
      const page = (await client.query(`SELECT DISTINCT task_id FROM copy_review_drafts
        WHERE task_id>$1 AND NOT(task_id=ANY($2::bigint[]))
        ORDER BY task_id LIMIT $3`, [cursor, visited, Math.min(100, scanLimit - visited.length)])).rows.map(row => row.task_id);
      if (!page.length) {
        await client.query('COMMIT');
        if (cursor === '0' || wrapped) break;
        cursor = '0'; wrapped = true;
        continue;
      }
      const candidate = (await client.query(`SELECT task.id FROM tasks task
        WHERE task.id=ANY($1::bigint[]) AND ${CURRENT_DELIVERY_SQL}
        ORDER BY task.id LIMIT 1 FOR UPDATE OF task SKIP LOCKED`, [page])).rows[0];
      if (!candidate) {
        await client.query('COMMIT');
        cursor = String(page.at(-1)); cursors.set(pool, cursor); visited.push(...page);
        continue;
      }
      // Recheck in a fresh READ COMMITTED statement after acquiring the task lock.
      const result = await client.query(`DELETE FROM copy_review_drafts draft USING tasks task
        WHERE task.id=$1 AND draft.task_id=task.id AND ${CURRENT_DELIVERY_SQL}
          AND draft.id IN (SELECT id FROM copy_review_drafts WHERE task_id=$1
            ORDER BY id LIMIT $2)`, [candidate.id, draftLimit]);
      await client.query('COMMIT');
      cursor = String(candidate.id); cursors.set(pool, cursor);
      visited.push(...page.filter(id => BigInt(id) <= BigInt(candidate.id)));
      deleted += result.rowCount; processed += 1;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  return { processed, deleted };
}
