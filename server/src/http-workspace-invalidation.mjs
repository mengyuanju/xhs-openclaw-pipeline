function permissionMutation(ctx) {
  return !['GET', 'HEAD'].includes(ctx.method) && (/^\/v1\/users(?:\/|$)/u.test(ctx.path) || /^\/v1\/profile(?:\/|$)/u.test(ctx.path));
}
export function captureWorkspaceMutation(repository) {
  return typeof repository.getWorkspaceMutationVersion === 'function' ? repository.getWorkspaceMutationVersion() : null;
}
export function workspaceCountsNeedInvalidation(repository, ctx) {
  return repository.supportsScopedWorkspaceCounts !== true || permissionMutation(ctx);
}
export function workspaceMutationCommitted(repository, ctx, previousVersion) {
  if (ctx.status >= 400) return false;
  // A long wait can span another request's commit. It is still read-only and
  // must not fan out cache invalidations or background database maintenance.
  if (ctx.path === '/v1/executions/work-notifications/wait') return false;
  if (permissionMutation(ctx)) return true;
  if (previousVersion !== null) {
    return repository.getWorkspaceMutationVersion() !== previousVersion;
  }
  // Older repositories have no commit signal. Preserve their conservative
  // behavior until upgraded, while excluding known read-only POST endpoints.
  const backgroundProgress = ctx.path === '/v1/executions/heartbeat' || /^\/v1\/executions\/[^/]+\/(?:progress|visual-plan|assets|model-calls\/[^/]+|image-edit\/heartbeat)$/u.test(ctx.path) || ctx.path === '/v1/auth/login' || ctx.path === '/v1/nodes' || /^\/v1\/admin\/task-data-report\/(?:query|export|exports)(?:\/|$)/u.test(ctx.path) || ctx.path === '/v1/tasks/batch-archive' || ctx.path === '/v1/tasks/duplicate-query-discard-preview' || /^\/v1\/image-editor\/uploads(?:\/|$)/u.test(ctx.path);
  return !['GET', 'HEAD'].includes(ctx.method) && !backgroundProgress;
}
