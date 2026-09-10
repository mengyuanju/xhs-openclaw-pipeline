import { ApiError } from '../admin/http.mjs';

const REQUIRED_MUTATION_CAPABILITIES = Object.freeze([
  Object.freeze({
    capability: 'taskAssignmentVersion',
    minimumVersion: 3,
    matches: (routePath, method) => (routePath === '/v1/tasks' && method === 'POST')
      || (routePath === '/v1/tasks/batch-assignee' && method === 'POST')
      || (/^\/v1\/tasks\/[^/]+\/assignee$/u.test(routePath) && method === 'PATCH'),
  }),
  Object.freeze({
    capability: 'autoAssignmentPoolVersion',
    minimumVersion: 3,
    matches: (routePath, method) => /^\/v1\/auto-assignment(?:\/|$)/u.test(routePath)
      && !['GET', 'HEAD'].includes(method),
  }),
  Object.freeze({
    capability: 'executorManagementVersion',
    minimumVersion: 1,
    matches: (routePath, method) => routePath === '/v1/executor-statuses'
      && method === 'DELETE',
  }),
  Object.freeze({
    capability: 'finalDeliveryVersion',
    minimumVersion: 2,
    matches: (routePath, method) => (/^\/v1\/delivery-pool(?:\/|$)/u.test(routePath)
      && ['GET', 'HEAD', 'POST'].includes(method))
      || (routePath === '/v1/tasks/batch-archive' && method === 'POST')
      || (/^\/v1\/tasks\/[^/]+\/archive$/u.test(routePath)
        && ['GET', 'HEAD'].includes(method)),
  }),
]);

export function requiredMutationCapability(routePath, rawMethod) {
  const method = String(rawMethod ?? '').toUpperCase();
  const requirement = REQUIRED_MUTATION_CAPABILITIES.find((candidate) => candidate.matches(routePath, method));
  return requirement
    ? { capability: requirement.capability, minimumVersion: requirement.minimumVersion }
    : null;
}

function upgradeRequired() {
  return new ApiError(
    503,
    'CONTROL_PLANE_UPGRADE_REQUIRED',
    '中心服务版本过旧，已停止本次操作；请先完成中心服务升级',
  );
}

export async function assertMutationCapability({
  root,
  routePath,
  method,
  fetchImpl = fetch,
}) {
  const requirement = requiredMutationCapability(routePath, method);
  if (!requirement) return;

  let response;
  try {
    response = await fetchImpl(`${root}/health`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new ApiError(503, 'CONTROL_PLANE_UNAVAILABLE', '无法确认中心服务版本，本次操作未执行');
  }

  if (!response.ok) {
    if ([404, 405].includes(response.status)) throw upgradeRequired();
    throw new ApiError(503, 'CONTROL_PLANE_UNAVAILABLE', '中心服务暂时不可用，本次操作未执行');
  }
  const health = await response.json().catch(() => null);
  const availableVersion = Number(health?.data?.capabilities?.[requirement.capability]);
  if (!Number.isInteger(availableVersion) || availableVersion < requirement.minimumVersion) {
    throw upgradeRequired();
  }
}
