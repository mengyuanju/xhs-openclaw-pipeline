// Keep this expression in one place: duplicate cleanup must use exactly the
// same identity as the task-list DISTINCT ON query.
export function taskQueryIdentitySql(column = 'query') {
  if (!/^(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*$/iu.test(column)) {
    throw new TypeError('task query identity column is invalid');
  }
  return `lower(regexp_replace(btrim(${column}), '\\s+', ' ', 'g'))`;
}

export function normalizeTaskQueryIdentity(value) {
  return String(value ?? '').trim().replace(/\s+/gu, ' ').toLowerCase();
}
