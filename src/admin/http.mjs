const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function assertLocalRequest(request, { mutation = false } = {}) {
  const target = new URL(request.url);
  const host = request.headers.get('host') || target.host;
  let publicOrigin;
  try {
    publicOrigin = new URL(`${target.protocol}//${host}`);
  } catch {
    throw new ApiError(403, 'LOCAL_ONLY', '后台仅接受本机 local requests');
  }
  if (!LOCAL_HOSTS.has(publicOrigin.hostname)) {
    throw new ApiError(403, 'LOCAL_ONLY', '后台仅接受本机 local requests');
  }
  if (!mutation) return;
  const origin = request.headers.get('origin');
  if (!origin || new URL(origin).origin !== publicOrigin.origin) {
    throw new ApiError(403, 'SAME_ORIGIN_REQUIRED', '写操作必须来自 same-origin 页面');
  }
}

export function parsePositiveId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new TypeError('invalid id');
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new TypeError('invalid id');
  return id;
}

export function assertRequestSize(request, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new TypeError('request size limit is invalid');
  const declared = request.headers.get('content-length');
  if (declared === null) return;
  if (!/^\d+$/.test(declared)) throw new ApiError(400, 'INVALID_CONTENT_LENGTH', 'Content-Length 无效');
  if (Number(declared) > maxBytes) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'request body is too large');
  }
}

export function errorToApiResponse(error) {
  if (error instanceof ApiError) {
    const body = { error: { code: error.code, message: error.message } };
    if (error.details !== undefined) body.error.details = error.details;
    return Response.json(body, { status: error.status });
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return Response.json({
      error: { code: 'INVALID_INPUT', message: error.message.slice(0, 500) },
    }, { status: 400 });
  }
  return Response.json({
    error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' },
  }, { status: 500 });
}

export function notFound(message = '资源不存在') {
  throw new ApiError(404, 'NOT_FOUND', message);
}
