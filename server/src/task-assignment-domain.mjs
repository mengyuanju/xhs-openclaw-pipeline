export const TASK_ASSIGNMENT_SOURCES = Object.freeze(['SELF', 'MANUAL', 'AUTO']);

export function normalizeAssigneeUserId(value, { allowNull = true } = {}) {
  if (value === null || value === undefined || value === '') {
    if (allowNull) return null;
    throw new TypeError('assignedToUserId is required');
  }
  if (typeof value !== 'string') throw new TypeError('assignedToUserId must be an account identifier');
  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,49}$/u.test(username)) {
    throw new TypeError('assignedToUserId must contain 3 to 50 lowercase letters, numbers, dots, underscores or hyphens');
  }
  return username;
}

export function normalizeAssignmentSource(value) {
  const source = String(value ?? '').trim().toUpperCase();
  if (!TASK_ASSIGNMENT_SOURCES.includes(source)) throw new TypeError('assignment source is invalid');
  return source;
}
