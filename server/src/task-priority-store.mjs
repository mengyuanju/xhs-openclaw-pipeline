import { createHash } from 'node:crypto';
import { ControlPlaneAuthorizationError, ControlPlaneConflictError, ControlPlaneNotFoundError, normalizeTaskId } from './domain.mjs';
import { normalizePriorityMode, priorityFrom } from './task-priority.mjs';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])]),
  );
  return value;
}

export function priorityEvidenceHash(evidence) {
  return createHash('sha256').update(JSON.stringify(canonical(evidence))).digest('hex');
}

export function normalizePriorityScope(input) {
  if (input.productionBatchId != null) {
    if (input.taskIds != null) throw new TypeError('choose tasks or production batch');
    return { productionBatchId: normalizeTaskId(input.productionBatchId) };
  }
  if (!Array.isArray(input.taskIds) || !input.taskIds.length || input.taskIds.length > 100) {
    throw new TypeError('select 1 to 100 tasks');
  }
  const taskIds = [...new Set(input.taskIds.map(normalizeTaskId))].sort((a, b) => a - b);
  return { taskIds };
}

export async function readPriorityScope(queryable, input) {
  const scope = normalizePriorityScope(input);
  const result = await queryable.query(`SELECT * FROM tasks WHERE ${scope.taskIds
    ? 'id = ANY($1::bigint[])' : 'production_batch_id = $1'} ORDER BY id`,
  [scope.taskIds ?? scope.productionBatchId]);
  return { scope, items: result.rows.map(row => ({ id: Number(row.id), state: row.state,
    productionBatchId: row.production_batch_id == null ? null : Number(row.production_batch_id), ...priorityFrom(row) })) };
}

// Caller owns the transaction and revalidates the account under a row lock.
export async function adjustTaskPriority(client, input, actor) {
  if (actor.role !== 'ADMIN') throw new ControlPlaneAuthorizationError('only administrators can adjust priority');
  const scope = normalizePriorityScope(input);
  const mode = normalizePriorityMode(input.mode);
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason || reason.length > 2000) throw new TypeError('priority reason must contain 1 to 2000 characters');
  if (!input.expectedVersions || typeof input.expectedVersions !== 'object') throw new TypeError('expectedVersions is required');
  // Lock the batch against membership changes, then its tasks in ID order.
  if (scope.productionBatchId) {
    const batch = await client.query('SELECT id FROM production_batches WHERE id = $1 FOR UPDATE', [scope.productionBatchId]);
    if (!batch.rows.length) throw new ControlPlaneNotFoundError('production batch not found');
  }
  const result = await client.query(`SELECT * FROM tasks WHERE ${scope.taskIds
    ? 'id = ANY($1::bigint[])' : 'production_batch_id = $1'} ORDER BY id FOR UPDATE`,
  [scope.taskIds ?? scope.productionBatchId]);
  if (!result.rows.length || (scope.taskIds && result.rows.length !== scope.taskIds.length)) {
    throw new ControlPlaneNotFoundError('priority scope contains missing tasks');
  }
  if (Object.keys(input.expectedVersions).length !== result.rows.length) {
    throw new ControlPlaneConflictError('PRIORITY_SCOPE_CHANGED', '批次成员已变化，请刷新后重试');
  }
  for (const row of result.rows) {
    if (input.expectedVersions[row.id] !== Number(row.priority_version)) {
      throw new ControlPlaneConflictError('PRIORITY_VERSION_CONFLICT', '优先级已被其他管理员调整，请刷新后重试');
    }
  }
  const items = [];
  for (const row of result.rows) {
    const updated = await client.query(`UPDATE tasks SET priority_mode = $2,
      priority_version = priority_version + 1, priority_updated_by = $3,
      priority_updated_at = now(), priority_reason = $4 WHERE id = $1 RETURNING *`,
    [row.id, mode, actor.username, reason]);
    const previous = await client.query('SELECT event_hash FROM task_priority_events WHERE task_id = $1 ORDER BY version DESC LIMIT 1', [row.id]);
    const previousHash = previous.rows[0]?.event_hash ?? '';
    const evidence = { taskId: Number(row.id), actorAccountId: actor.userId, actorUsername: actor.username,
      previousMode: row.priority_mode, mode, reason, version: Number(row.priority_version) + 1, scope, previousHash,
      state: row.state, productionBatchId: row.production_batch_id ?? null,
      systemPriority: row.system_priority, effectiveBefore: row.effective_priority,
      effectiveAfter: updated.rows[0].effective_priority,
      adjustedAt: new Date(updated.rows[0].priority_updated_at).toISOString() };
    const hash = priorityEvidenceHash(evidence);
    await client.query(`INSERT INTO task_priority_events(task_id, actor_account_id, actor_username,
      previous_mode, mode, reason, version, scope, previous_hash, event_hash, evidence)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [row.id, actor.userId, actor.username, row.priority_mode, mode, reason, evidence.version, scope, previousHash, hash, evidence]);
    items.push({ id: Number(row.id), ...priorityFrom(updated.rows[0]) });
  }
  return { scope, items };
}
