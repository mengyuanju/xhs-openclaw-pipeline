import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError } from '../src/admin/http.mjs';
import { ControlPlaneApiError } from '../src/control-plane/client.mjs';
import { controlPlaneResponseError, forwardControlPlaneRequest } from '../src/control-plane/next-api-error.mjs';

test('Next control-plane adapters preserve central authentication and authorization failures', async () => {
  for (const [status, code] of [[401, 'SESSION_STALE'], [403, 'FORBIDDEN']]) {
    await assert.rejects(
      forwardControlPlaneRequest(async () => {
        throw new ControlPlaneApiError(status, code, '中心拒绝请求');
      }),
      (error) => error instanceof ApiError
        && error.status === status
        && error.code === code
        && error.message === '中心拒绝请求',
    );
  }
});

test('Next control-plane adapters do not relabel unrelated failures', async () => {
  const failure = new TypeError('fetch failed');
  await assert.rejects(forwardControlPlaneRequest(async () => { throw failure; }), (error) => error === failure);
});

test('raw control-plane responses retain bounded structured errors for streamed asset adapters', async () => {
  const stale = await controlPlaneResponseError(Response.json({
    error: { code: 'SESSION_STALE', message: '账号状态已变化，请重新登录' },
  }, { status: 401 }));
  assert.equal(stale.status, 401);
  assert.equal(stale.code, 'SESSION_STALE');
  assert.match(stale.message, /重新登录/u);

  const unsafe = await controlPlaneResponseError(Response.json({
    error: { code: '<script>', message: 'x'.repeat(800) },
  }, { status: 502 }), { fallbackCode: 'ASSET_ERROR', fallbackMessage: '读取失败' });
  assert.equal(unsafe.code, 'ASSET_ERROR');
  assert.equal([...unsafe.message].length, 500);
});
