const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const ids = values => [...new Set(values.filter(positiveId).map(Number))].slice(0, 1000);

export function normalizeWorkspaceUpdate(value) {
  if (!value || !Array.isArray(value.scopes) || !value.scopes.length
    || value.scopes.some(scope => typeof scope !== 'string' || scope.length > 64)) return { scopes: ['all'], taskIds: [] };
  return { scopes: [...new Set(value.scopes)], taskIds: ids(Array.isArray(value.taskIds) ? value.taskIds : []) };
}

export function workspaceUpdateMatches(update, { scopes, taskIds } = {}) {
  const normalized = normalizeWorkspaceUpdate(update);
  if (normalized.scopes.includes('all')) return true;
  if (scopes?.length && !scopes.some(scope => normalized.scopes.includes(scope))) return false;
  return !taskIds?.length || !normalized.taskIds.length || taskIds.some(id => normalized.taskIds.includes(id));
}

/** Signals contain only business scopes and integer IDs, never response contents. */
export function mutationWorkspaceUpdate(url, method, body, result) {
  if (['GET', 'HEAD'].includes((method ?? 'GET').toUpperCase()) || !url.startsWith('/api/control-plane/')) return null;
  const path = url.split('?')[0].slice('/api/control-plane'.length);
  if (/^\/v1\/(?:auth|profile|nodes)(?:\/|$)/u.test(path)
    || path.startsWith('/v1/image-editor/uploads/')
    || /\/heartbeat$/u.test(path) || /\/(?:progress|model-calls)(?:\/|$)/u.test(path)
    || path === '/v1/admin/task-data-report/query' || /\/(?:preview|import-preview|duplicate-query-discard-preview)$/u.test(path)
    || path === '/v1/delivery-pool/previews') return null;
  let input = body;
  if (typeof body === 'string') { try { input = JSON.parse(body); } catch { input = null; } }
  const taskIds = ids([
    /^\/v1\/(?:tasks|image-editor\/workspaces)\/(\d+)(?:\/|$)/u.exec(path)?.[1],
    result?.taskId, result?.task_id, result?.task?.id, result?.item?.taskId,
    ...(Array.isArray(result?.results) ? result.results.map(item=>item?.item?.taskId) : []),
    ...(Array.isArray(input?.taskIds) ? input.taskIds : []), ...(Array.isArray(input?.workspaceIds) ? input.workspaceIds : []),
  ]);
  if (path.startsWith('/v1/image-editor/')) return { scopes: ['image-editor', 'background'], taskIds };
  if (path.startsWith('/v1/image-edits/') || /\/image-edits(?:\/|$)/u.test(path)) {
    return { scopes: ['tasks', 'image-edits', 'quality', 'delivery', 'statistics', 'background'], taskIds };
  }
  if (/\/regenerate-image-plan(?:\/|$)/u.test(path)) return { scopes: ['task-details', 'background'], taskIds };
  if (path.startsWith('/v1/tasks')) return { scopes: ['tasks', 'quality', 'delivery', 'statistics'], taskIds };
  if (/^\/v[12]\/(?:copy-qa|image-qa|production-batches)(?:\/|$)/u.test(path)
    || path.startsWith('/v1/admin/reassignment-cases/')) {
    return { scopes: ['tasks', 'quality', 'delivery', 'statistics'], taskIds };
  }
  if (/^\/v1\/delivery-/u.test(path)) return { scopes: ['delivery', 'tasks', 'statistics'], taskIds };
  if (path.startsWith('/v1/query-packages')) return { scopes: ['query-packages', 'tasks', 'statistics'], taskIds };
  if (/^\/v1\/(?:users|auto-assignment|settings|workflow-quality-settings)(?:\/|$)/u.test(path)) return { scopes: ['all'], taskIds: [] };
  if (path.startsWith('/v1/admin/')) return { scopes: ['reports'], taskIds };
  // Unknown/older mutations retain a broad invalidation for compatibility.
  return { scopes: ['all'], taskIds: [] };
}
