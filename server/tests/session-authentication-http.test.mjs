import assert from 'node:assert/strict';
import test from 'node:test';

import { ControlPlaneAuthorizationError } from '../src/domain.mjs';
import { createControlPlaneApp } from '../src/http-server.mjs';

const USER = {
  id: 2, username: 'alice', displayName: 'Alice', role: 'USER',
  status: 'ACTIVE', credentialVersion: 1, mustChangePassword: false,
};
const HEADERS = {
  'X-Actor-User-Id': '2', 'X-Actor-Username': 'alice',
  'X-Actor-Role': 'USER', 'X-Actor-Credential-Version': '1',
};

async function withServer(repository, action) {
  const app = createControlPlaneApp({
    repository, storageRoot: 'test-storage', logger: { info() {}, error() {} },
  });
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  try {
    await action(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await app.context.disposeControlPlaneResources();
  }
}

async function assertError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const payload = await response.json();
  assert.equal(payload.error.code, code);
  assert.equal(payload.data, undefined);
  return payload;
}

test('profile returns the verified current account', async () => {
  let identityReads = 0;
  const repository = {
    getUserByUsername: async () => USER,
    getUserByIdentity: async (actor) => {
      identityReads += 1;
      assert.deepEqual(actor, {
        userId: 2, username: 'alice', role: 'USER', credentialVersion: 1,
      });
      return USER;
    },
  };
  await withServer(repository, async (root) => {
    const response = await fetch(`${root}/v1/profile`, { headers: HEADERS });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, USER);
  });
  assert.equal(identityReads, 2);
});

test('account lookup failures before profile access remain retryable service failures', async () => {
  await withServer({
    getUserByUsername: async () => { throw new Error('database credentials must stay private'); },
    getUserByIdentity: async () => assert.fail('profile must not be reached'),
  }, async (root) => {
    const response = await fetch(`${root}/v1/profile`, { headers: HEADERS });
    const payload = await assertError(response, 503, 'CONTROL_PLANE_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(payload), /database credentials/u);
  });
});

for (const failureAt of [1, 2]) {
  test(`profile identity lookup failure at read ${failureAt} returns 503 instead of invalidating the session`, async () => {
    let identityReads = 0;
    await withServer({
      getUserByUsername: async () => USER,
      getUserByIdentity: async () => {
        identityReads += 1;
        if (identityReads === failureAt) throw new Error('connection terminated');
        return USER;
      },
    }, async (root) => {
      const response = await fetch(`${root}/v1/profile`, { headers: HEADERS });
      await assertError(response, 503, 'CONTROL_PLANE_UNAVAILABLE');
    });
    assert.equal(identityReads, failureAt);
  });
}

for (const [reason, user] of [
  ['deleted', null],
  ['recreated under the same username', { ...USER, id: 3 }],
  ['disabled', { ...USER, status: 'DISABLED' }],
  ['role changed', { ...USER, role: 'REVIEWER' }],
  ['password changed', { ...USER, credentialVersion: 2 }],
]) {
  test(`profile still rejects an account that was ${reason}`, async () => {
    await withServer({
      getUserByUsername: async () => user,
      getUserByIdentity: async () => assert.fail('stale sessions must not reach profile'),
    }, async (root) => {
      const response = await fetch(`${root}/v1/profile`, { headers: HEADERS });
      await assertError(response, 401, 'SESSION_STALE');
    });
  });
}

test('account deletion during the profile lookup still returns SESSION_STALE', async () => {
  await withServer({
    getUserByUsername: async () => USER,
    getUserByIdentity: async () => null,
  }, async (root) => {
    const response = await fetch(`${root}/v1/profile`, { headers: HEADERS });
    await assertError(response, 401, 'SESSION_STALE');
  });
});

test('identity changes before sending the profile response still return SESSION_STALE', async () => {
  let identityReads = 0;
  await withServer({
    getUserByUsername: async () => USER,
    getUserByIdentity: async () => {
      identityReads += 1;
      return identityReads === 1 ? USER : { ...USER, credentialVersion: 2 };
    },
  }, async (root) => {
    const response = await fetch(`${root}/v1/profile`, { headers: HEADERS });
    await assertError(response, 401, 'SESSION_STALE');
  });
});

test('profile lookup authorization errors retain their existing 403 classification', async () => {
  await withServer({
    getUserByUsername: async () => USER,
    getUserByIdentity: async () => { throw new ControlPlaneAuthorizationError(); },
  }, async (root) => {
    const response = await fetch(`${root}/v1/profile`, { headers: HEADERS });
    await assertError(response, 403, 'FORBIDDEN');
  });
});

test('role restrictions still return 403 without accessing the restricted repository route', async () => {
  await withServer({
    getUserByUsername: async () => USER,
    listUsers: async () => assert.fail('ordinary users cannot list accounts'),
  }, async (root) => {
    const response = await fetch(`${root}/v1/users`, { headers: HEADERS });
    await assertError(response, 403, 'FORBIDDEN');
  });
});
