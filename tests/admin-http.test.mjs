import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertLocalRequest,
  assertRequestSize,
  errorToApiResponse,
  parsePositiveId,
} from '../src/admin/http.mjs';

function request(url, headers = {}) {
  return new Request(url, { headers });
}

describe('admin HTTP boundary', () => {
  it('accepts localhost reads and same-origin mutations', () => {
    assert.doesNotThrow(() => assertLocalRequest(request('http://127.0.0.1:3000/api/tasks')));
    assert.doesNotThrow(() => assertLocalRequest(request('http://localhost:3000/api/tasks', {
      origin: 'http://localhost:3000',
    }), { mutation: true }));
    assert.doesNotThrow(() => assertLocalRequest(request('http://localhost:3000/api/tasks', {
      host: '127.0.0.1:3000',
      origin: 'http://127.0.0.1:3000',
    }), { mutation: true }));
  });

  it('rejects non-local hosts and cross-origin mutations', () => {
    assert.throws(
      () => assertLocalRequest(request('http://192.168.1.8:3000/api/tasks')),
      /local requests/i,
    );
    assert.throws(
      () => assertLocalRequest(request('http://localhost:3000/api/tasks', {
        origin: 'https://attacker.example',
      }), { mutation: true }),
      /same-origin/i,
    );
  });

  it('returns bounded public errors without exposing internal details', async () => {
    const badInput = errorToApiResponse(new TypeError('imageCount is invalid'));
    assert.equal(badInput.status, 400);
    assert.deepEqual(await badInput.json(), {
      error: { code: 'INVALID_INPUT', message: 'imageCount is invalid' },
    });

    const internal = errorToApiResponse(new Error('Bearer secret-internal-token'));
    assert.equal(internal.status, 500);
    assert.deepEqual(await internal.json(), {
      error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' },
    });
  });

  it('parses positive numeric route identifiers only', () => {
    assert.equal(parsePositiveId('42'), 42);
    assert.throws(() => parsePositiveId('../1'), /invalid id/i);
    assert.throws(() => parsePositiveId('0'), /invalid id/i);
  });

  it('rejects declared request bodies above the route limit', () => {
    assert.doesNotThrow(() => assertRequestSize(request('http://localhost/api', {
      'content-length': '1024',
    }), 2048));
    assert.throws(() => assertRequestSize(request('http://localhost/api', {
      'content-length': '4096',
    }), 2048), /request body is too large/i);
  });
});
