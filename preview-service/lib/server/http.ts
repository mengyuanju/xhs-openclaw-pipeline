import { ApiError } from '@/lib/preview-contract';

export function jsonResponse(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('X-Content-Type-Options', 'nosniff');

  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(error: unknown) {
  if (error instanceof ApiError) {
    return jsonResponse(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }

  console.error('preview_service_error', error);
  return jsonResponse(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: '服务暂时无法完成请求，请稍后重试。',
      },
    },
    { status: 500 },
  );
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    throw new ApiError('请求来源不受信任。', 403, 'UNTRUSTED_ORIGIN');
  }
}
