// Task ownership and operation-specific permissions are checked by the center.
export function userCanAccessControlPlaneRoute(path, method) {
  return (path === '/health' && ['GET', 'HEAD'].includes(method))
    || (path === '/v1/human-quality-settings' && ['GET', 'HEAD'].includes(method))
    || /^\/v1\/(?:tasks|nodes|assets|profile)(?:\/|$)/u.test(path);
}
