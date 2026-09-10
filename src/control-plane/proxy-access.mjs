// Task ownership and operation-specific permissions are checked by the center.
export function userCanAccessControlPlaneRoute(path, method) {
  return (path === '/health' && ['GET', 'HEAD'].includes(method))
    || (path === '/v1/human-quality-settings' && ['GET', 'HEAD'].includes(method))
    || (path === '/v1/workflow-quality-settings' && ['GET', 'HEAD'].includes(method))
    || (path === '/v1/delivery-pool' && ['GET', 'HEAD'].includes(method))
    || (/^\/v1\/query-packages(?:\/|$)/u.test(path)
      && ['GET', 'HEAD', 'POST', 'PUT'].includes(method)
      && !/\/(?:assignee|abandon|permanent|permanent-delete-preview)$/u.test(path))
    || (/^\/v1\/(?:tasks|nodes|assets|profile)(?:\/|$)/u.test(path)
      && !(path === '/v1/tasks' && method === 'POST'));
}
