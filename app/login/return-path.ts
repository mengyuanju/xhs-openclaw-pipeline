const ROLE_RETURN_PATHS: Record<string, string[]> = {
  REVIEWER: ['/profile', '/workbench', '/knowledge', '/copy-qa'],
  USER: ['/profile', '/workbench', '/query-packages', '/delivery-pool'],
};

function isLocalPath(path: string) {
  return path.startsWith('/')
    && !path.startsWith('//')
    && !path.includes('\\')
    && !/[\u0000-\u001F\u007F]/u.test(path);
}

function matchesRoute(path: string, route: string) {
  return path === route
    || path.startsWith(`${route}/`)
    || path.startsWith(`${route}?`)
    || path.startsWith(`${route}#`);
}

export function resolveLoginReturnPath({
  requestedPath,
  homePath,
  role,
  mustChangePassword,
}: {
  requestedPath: string;
  homePath: string;
  role: string;
  mustChangePassword: boolean;
}) {
  if (mustChangePassword) return '/profile';
  if (!isLocalPath(requestedPath)) return homePath;
  if (role === 'ADMIN') return requestedPath;
  return (ROLE_RETURN_PATHS[role] ?? []).some((route) => matchesRoute(requestedPath, route))
    ? requestedPath
    : homePath;
}
