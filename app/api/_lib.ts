import { z, type ZodType } from 'zod';

import {
  ApiError,
  assertAuthenticatedRequest,
  assertAuthorizedSession,
  assertRequestSize,
  assertLocalRequest,
  errorToApiResponse,
} from '../../src/admin/http.mjs';

export async function apiHandler(
  request: Request,
  options: { mutation?: boolean; auth?: boolean; roles?: string[] },
  action: (session: any) => Promise<Response> | Response,
) {
  try {
    assertLocalRequest(request, { mutation: options.mutation });
    const session = options.auth === false ? null : assertAuthenticatedRequest(request);
    if (session) assertAuthorizedSession(session, options.roles || ['ADMIN']);
    return await action(session);
  } catch (error) {
    return errorToApiResponse(error);
  }
}

export async function parseJson<T>(
  request: Request,
  schema: ZodType<T>,
  {
    maxBytes = 64 * 1024,
    validationCode = 'INVALID_INPUT',
  }: { maxBytes?: number; validationCode?: string } = {},
): Promise<T> {
  assertRequestSize(request, maxBytes);
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '请求必须使用 application/json');
  }
  let body: unknown;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > maxBytes) {
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'request body is too large');
    }
    body = JSON.parse(rawBody);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new TypeError('请求 JSON 无法解析');
  }
  try {
    return schema.parse(body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ApiError(400, validationCode, '请求参数无效', error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })));
    }
    throw error;
  }
}

export function ok(data: unknown, init?: ResponseInit) {
  return Response.json({ data }, init);
}
