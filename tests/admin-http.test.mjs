import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertAuthenticatedRequest,
  assertLocalRequest,
  assertRequestSize,
  errorToApiResponse,
  parsePositiveId,
} from '../src/admin/http.mjs';
import { ADMIN_SESSION_COOKIE, createSessionToken } from '../src/admin/auth.mjs';

const AUTH_ENV = {
  XHS_ADMIN_PASSWORD_HASH: 'scrypt-v1.MDEyMzQ1Njc4OWFiY2RlZg.MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZg',
  XHS_SESSION_SECRET: 'test-session-secret-with-at-least-32-characters',
};

function request(url, headers = {}) {
  return new Request(url, { headers });
}

describe('admin HTTP boundary', () => {
  it('accepts loopback and private LAN hosts with same-origin mutations', () => {
    assert.doesNotThrow(() => assertLocalRequest(request('http://127.0.0.1:3000/api/tasks')));
    assert.doesNotThrow(() => assertLocalRequest(request('http://192.168.1.8:3000/api/tasks')));
    assert.doesNotThrow(() => assertLocalRequest(request('http://10.20.30.40:3000/api/tasks')));
    assert.doesNotThrow(() => assertLocalRequest(request('http://172.31.5.8:3000/api/tasks')));
    assert.doesNotThrow(() => assertLocalRequest(request('http://[fd00::8]:3000/api/tasks')));
    assert.doesNotThrow(() => assertLocalRequest(request('http://localhost:3000/api/tasks', {
      origin: 'http://localhost:3000',
    }), { mutation: true }));
    assert.doesNotThrow(() => assertLocalRequest(request('http://localhost:3000/api/tasks', {
      host: '127.0.0.1:3000',
      origin: 'http://127.0.0.1:3000',
    }), { mutation: true }));
  });

  it('rejects public or unknown hosts and cross-origin mutations', () => {
    assert.throws(
      () => assertLocalRequest(request('http://8.8.8.8:3000/api/tasks')),
      /private network/i,
    );
    assert.throws(
      () => assertLocalRequest(request('http://attacker.example:3000/api/tasks')),
      /private network/i,
    );
    assert.throws(
      () => assertLocalRequest(request('http://localhost:3000/api/tasks', {
        origin: 'https://attacker.example',
      }), { mutation: true }),
      /same-origin/i,
    );
  });

  it('accepts explicitly configured LAN hostnames only', () => {
    assert.doesNotThrow(() => assertLocalRequest(
      request('http://studio-pc:3000/api/tasks'),
      { allowedHosts: 'studio-pc,console.lan' },
    ));
    assert.throws(() => assertLocalRequest(
      request('http://other-pc:3000/api/tasks'),
      { allowedHosts: 'studio-pc,console.lan' },
    ), /private network/i);
  });

  it('requires a valid signed admin session for protected requests', () => {
    const token = createSessionToken(AUTH_ENV.XHS_SESSION_SECRET);
    assert.doesNotThrow(() => assertAuthenticatedRequest(request('http://192.168.1.8:3000/api/tasks', {
      cookie: `${ADMIN_SESSION_COOKIE}=${token}`,
    }), AUTH_ENV));
    assert.throws(
      () => assertAuthenticatedRequest(request('http://192.168.1.8:3000/api/tasks'), AUTH_ENV),
      /sign in/i,
    );
    assert.throws(
      () => assertAuthenticatedRequest(request('http://192.168.1.8:3000/api/tasks', {
        cookie: `${ADMIN_SESSION_COOKIE}=${token}tampered`,
      }), AUTH_ENV),
      /sign in/i,
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
