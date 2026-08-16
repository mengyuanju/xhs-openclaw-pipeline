import { z, type ZodType } from 'zod';

import {
  ApiError,
  assertRequestSize,
  assertLocalRequest,
  errorToApiResponse,
} from '../../src/admin/http.mjs';

export async function apiHandler(
  request: Request,
  options: { mutation?: boolean },
  action: () => Promise<Response> | Response,
) {
  try {
    assertLocalRequest(request, { mutation: options.mutation });
    return await action();
  } catch (error) {
    return errorToApiResponse(error);
  }
}

export async function parseJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  assertRequestSize(request, 64 * 1024);
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '请求必须使用 application/json');
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new TypeError('请求 JSON 无法解析');
  }
  try {
    return schema.parse(body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ApiError(400, 'INVALID_INPUT', '请求参数无效', error.issues.map((issue) => ({
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
