import { ApiError } from '../admin/http.mjs';
import { ControlPlaneApiError } from './client.mjs';

export async function forwardControlPlaneRequest(request) {
  try {
    return await request();
  } catch (error) {
    if (error instanceof ControlPlaneApiError) {
      throw new ApiError(error.status, error.code, error.message);
    }
    throw error;
  }
}

export async function controlPlaneResponseError(response, {
  fallbackCode = 'CONTROL_PLANE_REQUEST_FAILED',
  fallbackMessage = '中心服务请求失败',
} = {}) {
  let payload = null;
  if (response?.headers?.get('content-type')?.includes('application/json')) {
    payload = await response.json().catch(() => null);
  }
  const upstreamCode = payload?.error?.code;
  const upstreamMessage = payload?.error?.message;
  const code = typeof upstreamCode === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/u.test(upstreamCode)
    ? upstreamCode
    : fallbackCode;
  const message = typeof upstreamMessage === 'string' && upstreamMessage.trim()
    ? [...upstreamMessage.trim()].slice(0, 500).join('')
    : fallbackMessage;
  return new ApiError(response.status, code, message);
}
