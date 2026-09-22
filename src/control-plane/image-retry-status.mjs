export const IMAGE_RETRY_EXHAUSTED_LABEL = '生图3次失败';

/** @param {{ state: string, currentStage: string | null }} task */
export function isImageRetryExhausted(task) {
  return task.state === 'COPY_REVIEW_PENDING' && task.currentStage === 'IMAGE_RETRY_EXHAUSTED';
}

function imageAttemptNumber(execution) {
  const priorFailures = execution?.snapshot?.imageRetry?.failedAttempts;
  return Number.isSafeInteger(priorFailures) && priorFailures >= 0 ? priorFailures + 1 : 1;
}

function executionTime(execution) {
  const value = execution?.startedAt instanceof Date
    ? execution.startedAt.getTime()
    : Date.parse(execution?.startedAt ?? '');
  return Number.isFinite(value) ? value : 0;
}

function executionStartedAt(execution) {
  if (execution?.startedAt instanceof Date && Number.isFinite(execution.startedAt.getTime())) {
    return execution.startedAt.toISOString();
  }
  return typeof execution?.startedAt === 'string' ? execution.startedAt : null;
}

/**
 * Returns only the latest automatic retry cycle. Execution snapshots stay
 * server-side; the returned fields are safe to expose in task review details.
 * @param {{ state: string, currentStage: string | null, imageProductionChainId?: string | null, executions?: unknown[] }} task
 */
export function latestImageRetryFailures(task) {
  if (!isImageRetryExhausted(task) || !Array.isArray(task.executions)) return [];
  const chainId = task.imageProductionChainId ?? null;
  const failed = task.executions
    .filter((execution) => execution && execution.kind === 'IMAGE' && execution.status === 'FAILED'
      && (!chainId || execution.imageProductionChainId === chainId))
    .sort((left, right) => executionTime(right) - executionTime(left));
  if (failed.length === 0) return [];

  const selected = [];
  let expectedAttempt = imageAttemptNumber(failed[0]);
  for (const execution of failed) {
    if (imageAttemptNumber(execution) !== expectedAttempt) continue;
    selected.push(execution);
    expectedAttempt -= 1;
    if (expectedAttempt < 1 || selected.length === 3) break;
  }

  return selected.reverse().map((execution) => ({
    attempt: imageAttemptNumber(execution),
    stage: typeof execution.stage === 'string' ? execution.stage : null,
    error: String(execution.error || execution.progressMessage || '未记录具体错误').trim().slice(0, 2_000),
    startedAt: executionStartedAt(execution),
  }));
}

export function imageFailureDisplayReason(value) {
  const reason = String(value ?? '').trim();
  if (reason === 'title cannot contain exclamation marks or full-width tildes') {
    return '标题包含感叹号（!、！）或全角波浪号（～），不符合标题规则。';
  }
  return reason || '未记录具体错误';
}
