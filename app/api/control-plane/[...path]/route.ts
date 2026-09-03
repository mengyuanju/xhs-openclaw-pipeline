import { ApiError } from '../../../../src/admin/http.mjs';
import { controlPlaneUrl } from '../../../../src/control-plane/next-runtime.mjs';
import { apiHandler } from '../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_PROXY_BODY_BYTES = 20 * 1024 * 1024;

async function proxyRequest(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
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
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers: {
        ...(request.headers.get('content-type')
          ? { 'Content-Type': request.headers.get('content-type') as string }
          : {}),
        ...(request.headers.get('x-file-name')
          ? { 'X-File-Name': request.headers.get('x-file-name') as string }
          : {}),
      },
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(130_000),
    });
  } catch {
    throw new ApiError(503, 'CONTROL_PLANE_UNAVAILABLE', '无法连接远端中心服务');
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    },
  });
}

function handler(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return apiHandler(
    request,
    { mutation: !['GET', 'HEAD'].includes(request.method) },
    () => proxyRequest(request, context),
  );
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
