// Task ownership and operation-specific permissions are checked by the center.
export function isKnowledgeControlPlaneRoute(path) {
  return /^\/v1\/knowledge(?:\/|$)/u.test(path)
    || /^\/v1\/knowledge-versions(?:\/|$)/u.test(path)
    || /^\/v1\/(?:copy-analysis-prompts|copy-knowledge|visual-knowledge)(?:\/|$)/u.test(path);
}

export function nonAdminCanAccessQueryPackageRoute(path, method) {
  return (['GET', 'HEAD'].includes(method) && /^\/v1\/query-packages(?:\/[1-9]\d*)?$/u.test(path))
    || (method === 'PUT' && /^\/v1\/query-packages\/[1-9]\d*\/screening$/u.test(path));
}

export function userCanAccessControlPlaneRoute(path, method) {
  return (path === '/health' && ['GET', 'HEAD'].includes(method))
    || (path === '/v1/human-quality-settings' && ['GET', 'HEAD'].includes(method))
    || nonAdminCanAccessQueryPackageRoute(path, method)
    || (/^\/v1\/(?:tasks|nodes|assets|profile)(?:\/|$)/u.test(path)
      && !(path === '/v1/tasks' && method === 'POST')
      && !/^\/v1\/tasks\/[^/]+\/archive(?:\/|$)/u.test(path));
}
