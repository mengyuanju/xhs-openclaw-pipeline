import assert from 'node:assert/strict';
import test from 'node:test';

import { sessionActorHeaders } from '../src/control-plane/session-actor-headers.mjs';

test('session actor headers carry the immutable id with the mutable account checks', () => {
  const session = {
    subject: 'user', userId: 42, username: 'reviewer', roles: ['REVIEWER'], credentialVersion: 7,
  };
  assert.deepEqual(sessionActorHeaders(session), {
    'X-Actor-User-Id': '42',
    'X-Actor-Username': 'reviewer',
    'X-Actor-Role': 'REVIEWER',
    'X-Actor-Credential-Version': '7',
  });
  assert.deepEqual(sessionActorHeaders(session, { username: 'canonical', role: 'ADMIN' }), {
    'X-Actor-User-Id': '42',
    'X-Actor-Username': 'canonical',
    'X-Actor-Role': 'ADMIN',
    'X-Actor-Credential-Version': '7',
  });
});

test('legacy sessions do not invent an immutable user id', () => {
  assert.equal(sessionActorHeaders({ subject: 'admin' })['X-Actor-User-Id'], '');
});
