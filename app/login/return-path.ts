import { canAccessWorkflowPage } from '../../src/admin/workflow-access.mjs';

const ROLE_RETURN_PATHS: Record<string, string[]> = {
  REVIEWER: ['/profile', '/workbench', '/query-packages', '/copy-flow', '/copy-qa', '/image-qa'],
  USER: ['/profile', '/workbench/personal', '/query-packages', '/copy-flow', '/copy-qa'],
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
  copyReviewEnabled,
  copyQcEnabled,
  imageQcEnabled,
}: {
  requestedPath: string;
  homePath: string;
  role: string;
  mustChangePassword: boolean;
  copyReviewEnabled?: boolean;
  copyQcEnabled?: boolean;
  imageQcEnabled?: boolean;
}) {
  if (mustChangePassword) return '/profile';
  if (!isLocalPath(requestedPath)) return homePath;
  if (role === 'ADMIN') return requestedPath;
  return (ROLE_RETURN_PATHS[role] ?? []).some((route) => matchesRoute(requestedPath, route))
    && canAccessWorkflowPage({
      subject: 'user', roles: [role], copyReviewEnabled, copyQcEnabled, imageQcEnabled,
    }, requestedPath)
    ? requestedPath
    : homePath;
}
