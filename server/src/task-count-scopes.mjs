// Cache dependencies are derived from our parameterized count SQL. Unknown
// writes remain broad; this module never infers ownership from a task ID alone.
function sqlCode(sql) {
  return sql.replace(/'(?:''|[^'])*'|--[^\r\n]*|\/\*[\s\S]*?\*\//gu,' ')
    .replace(/"([a-z_][a-z_0-9]*)"/giu,'$1');
}

export function taskCountScope(sql, values, { usernames } = {}) {
  const fields = new Set(sql.toLowerCase().match(/[a-z_][a-z_0-9]*/gu));
  sql = sqlCode(sql);
  const simple = !/\b(?:OR|NOT|UNION)\b/iu.test(sql) && [...sql.matchAll(/\bSELECT\b/giu)].length === 1;
  const related = usernames ?? (simple ? [...sql.matchAll(/\b(?:assigned_to_user_id|created_by_user_id)\s*=\s*\$(\d+)\b/gu)]
    .map(match => values[Number(match[1]) - 1]).filter(value => typeof value === 'string') : []);
  const ids = (simple ? [...sql.matchAll(/(?<![.\w])id\s*=\s*\$(\d+)\b/gu)] : [])
    .map(match => Number(values[Number(match[1]) - 1])).filter(value => Number.isSafeInteger(value) && value > 0);
  return { fields, usernames: related.length ? new Set(related) : null, ids: ids.length ? new Set(ids) : null };
}

export function taskCountScopeKey(scope) {
  return JSON.stringify([[...scope.fields].sort(), scope.usernames ? [...scope.usernames].sort() : null,
    scope.ids ? [...scope.ids].sort((a,b) => a-b) : null]);
}

export function taskChangeAffectsCount(change, scope) {
  if (!change) return true;
  if (change.table === 'tasks' && change.fields && !change.fields.some(field => scope.fields.has(field))) return false;
  if (scope.ids && change.ids && !change.ids.some(id => scope.ids.has(id))) return false;
  if (scope.usernames && change.usernames && !change.usernames.some(username => scope.usernames.has(username))) return false;
  return true;
}

function rowOwners(row) {
  return row && Object.hasOwn(row,'assigned_to_user_id') && Object.hasOwn(row,'created_by_user_id')
    ? [row.assigned_to_user_id,row.created_by_user_id].filter(value => typeof value === 'string') : null;
}

export function observeLockedTaskRows(sql, result, locked) {
  if (/\bFROM\s+tasks\b/iu.test(sql) && /\bFOR\s+UPDATE\b/iu.test(sql)) {
    for (const row of result?.rows ?? []) if (rowOwners(row) && Number.isSafeInteger(Number(row.id))) {
      locked.set(Number(row.id),{id:Number(row.id),assigned_to_user_id:row.assigned_to_user_id,created_by_user_id:row.created_by_user_id});
    }
  }
}

export function taskCountChange(sql, values, result, locked) {
  if (Array.isArray(result)) return null;
  if (/\$(?:[a-z_][a-z_0-9]*)?\$|\bE'/iu.test(sql)) return null;
  sql = sqlCode(sql);
  if (sql.includes('"')) return null;
  // A writable CTE's final row count and rows need not describe its writes.
  const match = /^\s*(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(?:public\.)?(\w+)\b/iu.exec(sql);
  if (!match) return null;
  const table = match[2].toLowerCase(), update = match[1].toUpperCase() === 'UPDATE';
  // Subqueries can contain WHERE/SET names unrelated to the target assignment;
  // broad fallback is preferable to mistaking them for the changed columns.
  if (/\b(?:SELECT|FROM|USING|WITH)\b/iu.test(sql.slice(match[0].length)) && (update || match[1].toUpperCase() === 'DELETE FROM')) return null;
  const assignments = update ? sql.match(/\bSET\s+([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|$)/iu)?.[1] : null;
  const fields = table === 'tasks' && assignments
    ? [...assignments.matchAll(/(?:^|,)\s*(\w+)\s*=/gu)].map(entry => entry[1].toLowerCase()) : null;
  if (table === 'tasks' && update && !fields?.length) return null;
  const rows = result?.rows ?? [];
  const ids = new Set(rows.map(row => Number(table === 'tasks' ? row.id : row.task_id)).filter(value => Number.isSafeInteger(value) && value > 0));
  const whereAt = sql.search(/\bWHERE\b/iu), where = whereAt >= 0 ? sql.slice(whereAt) : '';
  const idPattern = table === 'tasks' ? /\b(?:\w+\.)?id\s*=\s*\$(\d+)\b/gu : /\b(?:\w+\.)?task_id\s*=\s*\$(\d+)\b/gu;
  const fullTargetRows = /\bRETURNING\s+(?:\w+\.)?\*\s*;?\s*$/iu.test(sql);
  const returnedIdsComplete = fullTargetRows && rows.length > 0 && Number(result?.rowCount ?? rows.length) === rows.length
    && rows.every(row => Number.isSafeInteger(Number(table === 'tasks' ? row.id : row.task_id)) && Number(table === 'tasks' ? row.id : row.task_id) > 0);
  const simpleTarget = !/\b(?:OR|SELECT|FROM|USING|WITH)\b/iu.test(sql.slice(match[0].length));
  for (const found of (simpleTarget && !returnedIdsComplete ? where.matchAll(idPattern) : [])) {
    const id = Number(values[Number(found[1]) - 1]); if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  }
  // UPDATE/DELETE ownership needs the old locked row when an owner changes.
  const changesOwner = fields?.some(field => ['assigned_to_user_id','created_by_user_id'].includes(field));
  const usernames = new Set();
  const completeIds = ids.size > 0 && (returnedIdsComplete || simpleTarget && Number(result?.rowCount ?? rows.length) <= ids.size);
  let known = completeIds;
  for (const id of ids) {
    const before = locked.get(id), after = table === 'tasks' ? rows.find(row => Number(row.id) === id) : null;
    const previous = rowOwners(before), next = rowOwners(after);
    if (changesOwner ? !previous || !next : !previous && !next) known = false;
    for (const username of [...previous ?? [],...next ?? []]) usernames.add(username);
  }
  return { table, fields, ids: completeIds ? [...ids] : null, usernames: known ? [...usernames] : null };
}
