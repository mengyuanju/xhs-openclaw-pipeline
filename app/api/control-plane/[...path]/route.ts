import { ApiError } from '../../../../src/admin/http.mjs';
import { controlPlaneUrl } from '../../../../src/control-plane/next-runtime.mjs';
import { assetConditionalHeaders, assetResponseHeaders } from '../../../../src/control-plane/asset-proxy.mjs';
import { assertMutationCapability } from '../../../../src/control-plane/mutation-capability.mjs';
import {
  isKnowledgeControlPlaneRoute,
  nonAdminCanAccessQueryPackageRoute,
  userCanAccessControlPlaneRoute,
} from '../../../../src/control-plane/proxy-access.mjs';
import { sessionActorHeaders } from '../../../../src/control-plane/session-actor-headers.mjs';
import { apiHandler } from '../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 3600;

const MAX_PROXY_BODY_BYTES = 20 * 1024 * 1024;

async function proxyRequest(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
  session: { subject: string; userId?: number; username?: string; roles: string[]; credentialVersion?: number },
) {
  const root = controlPlaneUrl();
  if (!root) throw new ApiError(503, 'CONTROL_PLANE_NOT_CONFIGURED', '远端中心服务尚未配置');
  const { path } = await context.params;
  if (!Array.isArray(path) || path.some((part) => !part || part === '.' || part === '..')) {
    throw new ApiError(400, 'INVALID_CONTROL_PLANE_PATH', '中心服务路径无效');
  }
  const incomingUrl = new URL(request.url);
  const upstreamUrl = new URL(`${root}/${path.map(encodeURIComponent).join('/')}`);
  upstreamUrl.search = incomingUrl.search;
  const username = session.username || (session.subject === 'admin' ? 'admin' : '');
  const role = session.roles[0];
  if (!username || !['ADMIN', 'REVIEWER', 'USER'].includes(role)) {
    throw new ApiError(403, 'FORBIDDEN', '当前账号尚未迁移到用户管理中心');
  }
  const routePath = `/${path.join('/')}`;
  if (/^\/v1\/tasks\/[^/]+\/model-calls(?:\/|$)/u.test(routePath) && role !== 'ADMIN') {
    throw new ApiError(403, 'FORBIDDEN', '仅管理员可查看模型执行链路');
  }
  if (role !== 'ADMIN' && ((/^\/v1\/query-packages(?:\/|$)/u.test(routePath)
      && !nonAdminCanAccessQueryPackageRoute(routePath, request.method))
    || /^\/v1\/delivery-pool(?:\/|$)/u.test(routePath)
    || /^\/v1\/tasks\/[^/]+\/archive(?:\/|$)/u.test(routePath))) {
    throw new ApiError(403, 'FORBIDDEN', '仅管理员可管理词包与交付信息');
  }
  if (routePath === '/v1/tasks' && upstreamUrl.searchParams.has('createdByRole') && role !== 'ADMIN') {
    throw new ApiError(403, 'FORBIDDEN', '仅管理员可按创建者角色筛选任务');
  }
  if (routePath === '/v1/tasks' && upstreamUrl.searchParams.has('queryPackageName') && role === 'USER') {
    throw new ApiError(403, 'FORBIDDEN', '普通用户不能按词包名称筛选任务');
  }
  if (role !== 'ADMIN' && (routePath === '/v1/task-views'
    || /^\/v1\/task-views\//u.test(routePath)
    || /^\/v1\/auto-assignment(?:\/|$)/u.test(routePath)
    || ['/v1/tasks/batch-actions', '/v1/tasks/batch-assignee', '/v1/tasks/batch-archive', '/v1/tasks/batch-permanent-delete',
      '/v1/tasks/duplicate-query-discard-preview', '/v1/tasks/duplicate-query-discard'].includes(routePath)
    || /^\/v1\/delivery-pool\/(?:archive|xlsx)(?:\/|$)/u.test(routePath)
    || /^\/v1\/tasks\/[^/]+\/assignee$/u.test(routePath)
    || (routePath === '/v1/tasks' && upstreamUrl.searchParams.has('attention')))) {
    throw new ApiError(403, 'FORBIDDEN', '仅管理员可使用任务集中处理功能');
  }
  if (routePath === '/v1/workflow-quality-settings' && role !== 'ADMIN') {
    throw new ApiError(403, 'FORBIDDEN', '仅管理员可访问流程质检配置');
  }
  if (routePath === '/v1/copy-qa/statistics' && role !== 'ADMIN') {
    throw new ApiError(403, 'FORBIDDEN', '仅管理员可查看人员抽检正确率');
  }
  if (role === 'REVIEWER' && /^\/v1\/production-batches(?:\/|$)/u.test(routePath)) {
    throw new ApiError(403, 'FORBIDDEN', '质检员没有生产批次管理权限');
  }
  if (role === 'REVIEWER' && (/^\/v1\/delivery-pool(?:\/|$)/u.test(routePath)
    || /^\/v1\/tasks\/[^/]+\/archive$/u.test(routePath))) {
    throw new ApiError(403, 'FORBIDDEN', '质检员没有交付池与交付包下载权限');
  }
  if (role === 'REVIEWER' && (/^\/v1\/(?:settings|prompts|prompt-versions|users|executor-statuses)(?:\/|$)/u.test(routePath))) {
    throw new ApiError(403, 'FORBIDDEN', '审核员没有该管理权限');
  }
  if (role === 'REVIEWER' && isKnowledgeControlPlaneRoute(routePath)) {
    throw new ApiError(403, 'FORBIDDEN', '审核员没有知识库管理权限');
  }
  if (role === 'USER' && !userCanAccessControlPlaneRoute(routePath, request.method)) {
    throw new ApiError(403, 'FORBIDDEN', '普通用户没有该操作权限');
  }
  if (path.join('/') === 'v1/tasks' && upstreamUrl.searchParams.get('mine') === 'true') {
    upstreamUrl.searchParams.set('personal', 'true');
    upstreamUrl.searchParams.delete('assignedToUserId');
    upstreamUrl.searchParams.delete('createdByUserId');
    upstreamUrl.searchParams.delete('createdByAccountId');
    upstreamUrl.searchParams.delete('nodeId');
    upstreamUrl.searchParams.delete('unassigned');
    upstreamUrl.searchParams.delete('mine');
  } else if (path.join('/') === 'v1/tasks' && role === 'USER') {
    upstreamUrl.searchParams.set('assignedToUserId', username);
    upstreamUrl.searchParams.delete('createdByUserId');
    upstreamUrl.searchParams.delete('createdByAccountId');
    upstreamUrl.searchParams.delete('nodeId');
    upstreamUrl.searchParams.delete('mine');
  }
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROXY_BODY_BYTES) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求内容过大');
  }
  const body = ['GET', 'HEAD'].includes(request.method)
    ? undefined
    : await request.arrayBuffer();
  if (body && body.byteLength > MAX_PROXY_BODY_BYTES) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求内容过大');
  }
  await assertMutationCapability({ root, routePath, method: request.method });
  let upstream: Response;
  try {
    const deliveryTokenDownload = request.method === 'GET'
      && /^\/v1\/delivery-pool\/(?:archive|xlsx)\/[^/]+$/u.test(routePath);
    const timeoutSignal = AbortSignal.timeout(
      /^\/v1\/delivery-pool\/(?:archive|xlsx)(?:\/|$)/u.test(routePath)
      ? 60 * 60_000
      : 130_000,
    );
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers: {
        ...assetConditionalHeaders(routePath, request),
        ...sessionActorHeaders(session, { username, role }),
        ...(request.headers.get('content-type')
          ? { 'Content-Type': request.headers.get('content-type') as string }
          : {}),
        ...(request.headers.get('x-file-name')
          ? { 'X-File-Name': request.headers.get('x-file-name') as string }
          : {}),
      },
      body,
      cache: 'no-store',
      signal: deliveryTokenDownload
        ? request.signal
        : AbortSignal.any([request.signal, timeoutSignal]),
    });
  } catch {
    throw new ApiError(503, 'CONTROL_PLANE_UNAVAILABLE', '无法连接远端中心服务');
  }
  const contentDisposition = upstream.headers.get('content-disposition');
  const contentLength = upstream.headers.get('content-length');
  const deliveryTaskCount = upstream.headers.get('x-delivery-task-count');
  return new Response(upstream.status === 304 || request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers: {
      ...assetResponseHeaders(routePath, upstream),
      ...(upstream.status === 304 ? {} : { 'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8' }),
      ...(contentDisposition ? { 'Content-Disposition': contentDisposition } : {}),
      ...(contentLength && /^\d+$/u.test(contentLength) ? { 'Content-Length': contentLength } : {}),
      ...(deliveryTaskCount && /^\d+$/u.test(deliveryTaskCount)
        ? { 'X-Delivery-Task-Count': deliveryTaskCount }
        : {}),
    },
  });
}

function handler(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return apiHandler(
    request,
    { mutation: !['GET', 'HEAD'].includes(request.method), roles: ['ADMIN', 'REVIEWER', 'USER'] },
    (session) => proxyRequest(request, context, session),
  );
}

export const GET = handler;
export const HEAD = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
