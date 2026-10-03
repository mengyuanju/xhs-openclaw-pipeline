const cursors = new WeakMap();

function bounded(value, fallback, maximum) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

/** Expiry maintenance is independent of delivery: an unexpired receipt remains replayable. */
export async function drainExpiredClaimReceipts(pool, { limit = 20, batchSize = 100, maxDurationMs = 2000 } = {}) {
  const nodeLimit = bounded(limit, 20, 100);
  const receiptLimit = bounded(batchSize, 100, 1000);
  const deadline = Date.now() + bounded(maxDurationMs, 2000, 5000);
  const expiredBefore = new Date();
  const visited = [];
  let cursor = cursors.get(pool) ?? '', wrapped = false, deleted = 0;
  while (visited.length < nodeLimit && Date.now() < deadline) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='2s'");
      await client.query("SET LOCAL lock_timeout='250ms'");
      // Claims lock this same node before reading or writing a receipt. Include
      // retired nodes, and skip occupied nodes rather than delaying live claims.
      const node = (await client.query(`SELECT node.id FROM executor_nodes node
        WHERE node.id>$1 AND NOT(node.id=ANY($2::varchar[])) AND EXISTS(
          SELECT 1 FROM execution_claim_requests receipt WHERE receipt.node_id=node.id
            AND receipt.expires_at<=$3)
        ORDER BY node.id LIMIT 1 FOR UPDATE OF node SKIP LOCKED`, [cursor, visited, expiredBefore])).rows[0];
      if (!node) {
        await client.query('COMMIT');
        if (!cursor || wrapped) break;
        cursor = ''; wrapped = true;
        continue;
      }
      // Terminal executions never return to RUNNING. Recheck under the node lock;
      // NULL expiry deliberately preserves legacy UUIDv4 idempotency receipts.
      const removed = await client.query(`DELETE FROM execution_claim_requests receipt USING (
          SELECT old.kind,old.request_id FROM execution_claim_requests old
          WHERE old.node_id=$1 AND old.expires_at<=$3
            AND NOT EXISTS(SELECT 1 FROM task_executions execution
              WHERE execution.id=ANY(old.execution_ids) AND execution.status='RUNNING')
          ORDER BY old.expires_at,old.kind,old.request_id LIMIT $2
        ) expired WHERE receipt.node_id=$1 AND receipt.kind=expired.kind
          AND receipt.request_id=expired.request_id RETURNING receipt.request_id`, [node.id, receiptLimit, expiredBefore]);
      await client.query('COMMIT');
      cursor = node.id; cursors.set(pool, cursor); visited.push(node.id);
      deleted += removed.rowCount;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  return { processed: visited.length, deleted };
}
