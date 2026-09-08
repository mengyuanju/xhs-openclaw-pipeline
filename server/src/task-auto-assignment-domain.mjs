export const TASK_AUTO_ASSIGNMENT_WORKER_STATUSES = Object.freeze(['ACTIVE', 'PAUSED']);

export function normalizeAutoAssignmentEnabled(value) {
  if (typeof value !== 'boolean') throw new TypeError('enabled must be a boolean');
  return value;
}

export function normalizeAutoAssignmentWorkerStatus(value) {
  const status = String(value ?? '').trim().toUpperCase();
  if (!TASK_AUTO_ASSIGNMENT_WORKER_STATUSES.includes(status)) {
    throw new TypeError('worker status must be ACTIVE or PAUSED');
  }
  return status;
}

export function normalizeAutoAssignmentLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new RangeError('assignmentLimit must be an integer from 1 to 500');
  }
  return value;
}

export function normalizeAutoAssignmentExpectedVersion(value, { required = true } = {}) {
  if (!required && (value === undefined || value === null)) return null;
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError('expectedVersion must be a positive integer');
  }
  return value;
}
