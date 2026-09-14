// Scheduling policy shared by machine claims, personal queues and assignment.
export const SYSTEM_PRIORITY = Object.freeze({ FIRST: 100, AUTO_RECOVERY: 150,
  MANUAL_RETRY: 200, REWORK: 300, MANDATORY_RECHECK: 400 });
export const MANUAL_PRIORITY = Object.freeze({ SYSTEM: null, HIGHEST: 500,
  HIGH: 350, NORMAL: 100, DEFER: 10, PAUSE: null });
export const PRIORITY_MINUTES_PER_POINT = 10;

export function systemPriority({ mandatoryCopyQc = false, reworkCount = 0, requeueReason = 'FIRST' } = {}) {
  if (mandatoryCopyQc || reworkCount >= 2) return SYSTEM_PRIORITY.MANDATORY_RECHECK;
  if (reworkCount > 0 || requeueReason === 'IMAGE_REVIEW_RETURN') return SYSTEM_PRIORITY.REWORK;
  return Object.hasOwn(SYSTEM_PRIORITY, requeueReason) ? SYSTEM_PRIORITY[requeueReason] : SYSTEM_PRIORITY.FIRST;
}

export function normalizePriorityMode(value) {
  if (!Object.hasOwn(MANUAL_PRIORITY, value)) throw new TypeError('priority mode is invalid');
  return value;
}

export function priorityFrom(row, now = Date.now()) {
  const system = Number(row.system_priority ?? 100);
  const manual = row.manual_priority == null ? null : Number(row.manual_priority);
  const entered = row.queue_entered_at ?? row.created_at;
  const effective = manual ?? system;
  return { systemPriority: system, manualPriority: manual, effectivePriority: effective,
    priorityMode: row.priority_mode ?? 'SYSTEM', prioritySource: !row.priority_mode || row.priority_mode === 'SYSTEM' ? 'SYSTEM' : 'ADMIN',
    priorityPaused: row.priority_paused === true, queueEnteredAt: entered,
    reworkCount: Number(row.rework_count ?? 0), requeueReason: row.requeue_reason ?? 'FIRST',
    priorityVersion: Number(row.priority_version ?? 1), priorityUpdatedBy: row.priority_updated_by ?? null,
    priorityUpdatedAt: row.priority_updated_at ?? null, priorityReason: row.priority_reason ?? null,
    waitingCompensation: Math.max(0, (now - new Date(entered).getTime()) / (PRIORITY_MINUTES_PER_POINT * 60_000)) || 0 };
}

// Virtual enqueue time is equivalent to unbounded aging (+6 points/hour).
// It is stable across pages and never needs a background job to update scores.
export function priorityOrderSql(alias = '') {
  if (!/^(?:[a-z_]+\.)?$/u.test(alias)) throw new TypeError('invalid priority SQL alias');
  return `${alias}priority_paused ASC, ${alias}priority_sort_at ASC, ${alias}id ASC`;
}

export function taskLoad({ effectivePriority = 100, reworkCount = 0, currentExecutionId = null } = {}) {
  return 1 + Math.max(0, effectivePriority - 100) / 100
    + Math.min(3, reworkCount) + (currentExecutionId ? 2 : 0);
}
