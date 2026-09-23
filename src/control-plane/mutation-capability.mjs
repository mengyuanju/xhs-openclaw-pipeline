import { ApiError } from '../admin/http.mjs';

const REQUIRED_MUTATION_CAPABILITIES = Object.freeze([
 Object.freeze({capability: 'secondaryAssignmentVersion', minimumVersion: 1,
 matches: (path, method) => method === 'POST' && (/^\/v1\/copy-qa\/items\/[^/]+\/escalate$/u.test(path)
 || /^\/v1\/admin\/reassignment-cases\//u.test(path))}),
  Object.freeze({
    capability: 'copyQaReasonTagsVersion', minimumVersion: 1,
    matches: (routePath, method) => /^\/v1\/copy-qa\/reason-tags(?:\/[^/]+)?$/u.test(routePath)
      && ['POST', 'PATCH'].includes(method),
  }),
  Object.freeze({
    capability: 'taskRestoreVersion', minimumVersion: 1,
    matches: (routePath, method) => method === 'POST' && /^\/v1\/tasks\/[^/]+\/restore$/u.test(routePath),
  }),
  Object.freeze({
    capability: 'pendingImageEditResolutionVersion', minimumVersion: 1,
    matches: (routePath, method) => method === 'POST'
      && /^\/v1\/tasks\/[^/]+\/image-edits\/resolve-pending$/u.test(routePath),
  }),
  Object.freeze({
    capability: 'imageDiscardVersion', minimumVersion: 1,
    matches: (routePath, method) => method === 'POST' && (
      /^\/v1\/tasks\/[^/]+\/discard-images$/u.test(routePath)
      || /^\/v1\/image-qa\/items\/[^/]+\/discard$/u.test(routePath)),
  }),
  Object.freeze({
    capability: 'sharedDeliveryVersion', minimumVersion: 1,
    matches: (routePath, method) => /^\/v1\/(?:delivery-items|delivery-archives)(?:\/|$)/u.test(routePath)
      && !['GET','HEAD'].includes(method),
  }),
  Object.freeze({
    capability: 'copyImagePlanRegenerationVersion',
    minimumVersion: 2,
    matches: (routePath, method) => /^\/v1\/tasks\/[^/]+\/regenerate-image-plan$/u.test(routePath)
      && method === 'POST',
  }),
  Object.freeze({
    capability: 'copyReviewDraftVersion',
    minimumVersion: 1,
    matches: (routePath, method) => /^\/v1\/tasks\/[^/]+\/copy-review-drafts$/u.test(routePath)
      && method === 'POST',
  }),
  Object.freeze({
    capability: 'adminDirectCopyQaVersion',
    minimumVersion: 1,
    matches: (routePath, method) => /^\/v1\/tasks\/[^/]+\/admin-direct-copy-qa$/u.test(routePath)
      && method === 'POST',
  }),
  Object.freeze({
    capability: 'queryPackageVersion',
    minimumVersion: 7,
    matches: (routePath, method) => routePath === '/v1/query-packages/import-preview'
      && method === 'PUT',
  }),
  Object.freeze({
    capability: 'queryPackageVersion',
    minimumVersion: 7,
    matches: (routePath, method) => routePath === '/v1/query-packages'
      && method === 'POST',
  }),
  Object.freeze({
    capability: 'xiaohongshuQuerySearchVersion',
    minimumVersion: 5,
    matches: (routePath, method) => routePath === '/v1/settings/xhs_query_search'
      && method === 'PUT',
  }),
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
    capability: 'xiaohongshuAccountStatusVersion',
    minimumVersion: 2,
    matches: (routePath, method) => routePath === '/v1/xhs-search-statuses'
      && method === 'DELETE',
  }),
  Object.freeze({
    capability: 'duplicateQueryDiscardVersion',
    minimumVersion: 1,
    matches: (routePath, method) => [
      '/v1/tasks/duplicate-query-discard-preview',
      '/v1/tasks/duplicate-query-discard',
    ].includes(routePath) && method === 'POST',
  }),
  Object.freeze({
    capability: 'queryPackageVersion',
    minimumVersion: 4,
    matches: (routePath, method) => (
      /^\/v1\/query-packages\/[^/]+\/item-assignments$/u.test(routePath)
        || /^\/v1\/query-packages\/[^/]+\/screening$/u.test(routePath)
    ) && method === 'PUT',
  }),
  Object.freeze({
    capability: 'queryPackageVersion',
    minimumVersion: 3,
    matches: (routePath, method) => /^\/v1\/query-packages\/[^/]+\/assignee$/u.test(routePath)
      && method === 'PATCH',
  }),
  Object.freeze({
    capability: 'queryPackageVersion',
    minimumVersion: 2,
    matches: (routePath, method) => /^\/v1\/query-packages(?:\/|$)/u.test(routePath)
      && !['GET', 'HEAD'].includes(method),
  }),
  Object.freeze({
    capability: 'deliverySpreadsheetVersion',
    minimumVersion: 3,
    matches: (routePath, method) => /^\/v1\/delivery-batches\/[^/]+\/xlsx$/u.test(routePath)
      && method === 'POST',
  }),
  Object.freeze({
    capability: 'deliverySpreadsheetVersion',
    minimumVersion: 2,
    matches: (routePath, method) => /^\/v1\/delivery-pool\/xlsx(?:\/|$)/u.test(routePath)
      && ['GET', 'HEAD', 'POST'].includes(method),
  }),
  Object.freeze({
    capability: 'deliveryPreviewVersion',
    minimumVersion: 5,
    matches: (routePath, method) => routePath === '/v1/delivery-pool/previews'
      && method === 'POST',
  }),
  Object.freeze({
    capability: 'finalDeliveryVersion',
    minimumVersion: 5,
    matches: (routePath, method) => ((/^\/v1\/delivery-pool(?:\/|$)/u.test(routePath)
      || /^\/v1\/delivery-batches(?:\/|$)/u.test(routePath))
      && ['GET', 'HEAD', 'POST'].includes(method)),
  }),
  Object.freeze({
    capability: 'finalDeliveryVersion',
    minimumVersion: 2,
    matches: (routePath, method) => (routePath === '/v1/tasks/batch-archive' && method === 'POST')
      || (/^\/v1\/tasks\/[^/]+\/archive$/u.test(routePath)
        && ['GET', 'HEAD'].includes(method)),
  }),
]);

export function requiredMutationCapability(routePath, rawMethod, body = null) {
  const method = String(rawMethod ?? '').toUpperCase();
  if (((routePath === '/v1/users' && method === 'POST')
      || (/^\/v1\/users\/[^/]+$/u.test(routePath) && method === 'PATCH'))
      && body && Object.hasOwn(body, 'copySamplingRateBpsOverride')) {
    return { capability: 'copySamplingVersion', minimumVersion: 2 };
  }
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
  body = null,
  fetchImpl = fetch,
}) {
  const requirement = requiredMutationCapability(routePath, method, body);
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
