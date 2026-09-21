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

export function userCanAccessDeliveryRoute(path, method) {
  return (path === '/v1/delivery-items' && ['GET','HEAD'].includes(method))
    || (path === '/v1/delivery-items/confirm' && method === 'POST')
    || (path === '/v1/delivery-archives/preview' && method === 'POST')
    || (path === '/v1/delivery-archives' && ['GET','POST'].includes(method))
    || (/^\/v1\/delivery-archives\/[1-9]\d*$/u.test(path) && method === 'GET')
    || (/^\/v1\/delivery-archives\/[1-9]\d*\/retry$/u.test(path) && method === 'POST')
    || (/^\/v1\/delivery-archives\/[1-9]\d*\/download\/[1-9]\d*$/u.test(path) && ['GET','HEAD'].includes(method))
    || (path === '/v1/delivery-pool' && ['GET', 'HEAD'].includes(method))
    || (path === '/v1/delivery-pool/archive' && method === 'POST')
    || (/^\/v1\/delivery-pool\/archive\/[^/]+$/u.test(path)
      && ['GET', 'HEAD'].includes(method))
    || (/^\/v1\/delivery-pool\/xlsx\/[^/]+$/u.test(path)
      && ['GET', 'HEAD'].includes(method))
    || (path === '/v1/delivery-batches' && method === 'GET')
    || (/^\/v1\/delivery-batches\/[^/]+$/u.test(path) && method === 'GET')
    || (/^\/v1\/delivery-batches\/[^/]+\/archive$/u.test(path)
      && ['GET', 'HEAD'].includes(method))
    || (/^\/v1\/delivery-batches\/[^/]+\/xlsx$/u.test(path) && method === 'POST')
    || (/^\/v1\/delivery-batches\/[^/]+\/confirm$/u.test(path) && method === 'POST');
}

export function userCanAccessTaskArchiveRoute(path, method) {
  return /^\/v1\/tasks\/[1-9]\d*\/archive$/u.test(path)
    && ['GET', 'HEAD'].includes(method);
}

export function userCanAccessImageEditRoute(path, method) {
  return (/^\/v1\/image-edits\/[^/]+$/u.test(path) && ['GET', 'HEAD'].includes(method))
    || (/^\/v1\/image-edits\/[^/]+\/(?:queue|retry|apply-suggestion|cancel|accept|reject)$/u.test(path)
      && method === 'POST');
}

export function userCanAccessControlPlaneRoute(path, method) {
  return (path === '/health' && ['GET', 'HEAD'].includes(method))
    || (/^\/v1\/personal-workspace\/(?:statistics|tasks|qa-activities)$/u.test(path) && ['GET','HEAD'].includes(method))
    || (path === '/v1/work-mode/items' && ['GET', 'HEAD'].includes(method))
    || (path === '/v1/human-quality-settings' && ['GET', 'HEAD'].includes(method))
    || (path === '/v1/copy-quality/queues' && ['GET', 'HEAD'].includes(method))
    || (/^\/v1\/copy-qa\/(?:items(?:\/[^/]+(?:\/(?:pass|return))?)?|freezes\/[^/]+\/batch-return-preview|batch-return)$/u.test(path)
      && ['GET', 'HEAD', 'POST'].includes(method))
    || (path === '/v1/copy-qa/reason-tags' && ['GET', 'HEAD', 'POST'].includes(method))
    || (/^\/v1\/copy-qa\/reason-tags\/[^/]+$/u.test(path) && method === 'PATCH')
    || nonAdminCanAccessQueryPackageRoute(path, method)
    || userCanAccessDeliveryRoute(path, method)
    || userCanAccessImageEditRoute(path, method)
    || userCanAccessTaskArchiveRoute(path, method)
    || (/^\/v1\/(?:tasks|nodes|assets|profile)(?:\/|$)/u.test(path)
      && !(path === '/v1/tasks' && method === 'POST')
      && !/^\/v1\/tasks\/[^/]+\/archive(?:\/|$)/u.test(path));
}
