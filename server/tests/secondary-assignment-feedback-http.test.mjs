import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { secondaryAssignmentFeedbackFrom } from '../src/secondary-assignment-feedback.mjs';

async function withServer(repository, action) {
  const app = createControlPlaneApp({ repository, storageRoot: 'test-storage', enforceUserAuth: true });
  let server;
  await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  try {
    await action(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const users = {
  owner: { id: 2, username: 'owner', role: 'USER', status: 'ACTIVE', credentialVersion: 1 },
  previous: { id: 3, username: 'previous', role: 'USER', status: 'ACTIVE', credentialVersion: 1 },
  admin: { id: 1, username: 'admin', role: 'ADMIN', status: 'ACTIVE', credentialVersion: 1 },
  reviewer: { id: 4, username: 'reviewer', role: 'REVIEWER', status: 'ACTIVE', credentialVersion: 1 },
};

function headers(username) {
  const user = users[username];
  return { 'X-Actor-User-Id': String(user.id), 'X-Actor-Username': username,
    'X-Actor-Role': user.role, 'X-Actor-Credential-Version': '1' };
}

const feedback = secondaryAssignmentFeedbackFrom({ assigned_at: '2026-09-30T01:00:00Z', entries: [
  { stage: 'COPY', reasonCodes: ['FACT_ERROR'], note: 'PRIVATE-HISTORICAL-FEEDBACK',
    reviewedAt: '2026-09-29T01:00:00Z', reviewerUsername: 'SECRET-REVIEWER',
    operatorUsername: 'SECRET-PREVIOUS-OPERATOR', sourceItemId: 132, content: 'SECRET-OLD-DRAFT' },
] });

const access = { id: 108, taskKind: 'CONTENT', state: 'COPY_REVIEW_PENDING',
  assignedToUserId: 'owner', assignedToAccountId: 2,
  createdByUserId: 'admin', createdByAccountId: 1 };

test('authorized detail readers receive only historical verdict text; users without current read access and anonymous callers cannot read it', async () => {
  let detailReads = 0;
  const repository = {
    getUserByUsername: async username => users[username],
    getTaskAccess: async () => access,
    getTask: async () => { detailReads++; return { ...access, query: 'current task', secondaryAssignmentFeedback: feedback }; },
  };
  await withServer(repository, async root => {
    for (const username of ['owner', 'admin']) {
      const response = await fetch(`${root}/v1/tasks/108`, { headers: headers(username) });
      assert.equal(response.status, 200);
      const data = (await response.json()).data;
      assert.deepEqual(data.secondaryAssignmentFeedback, feedback);
      assert.deepEqual(Object.keys(data.secondaryAssignmentFeedback), ['assignedAt', 'entries']);
      assert.deepEqual(Object.keys(data.secondaryAssignmentFeedback.entries[0]), ['stage', 'reasonLabels', 'note', 'reviewedAt']);
      assert.equal(JSON.stringify(data).includes('SECRET'), false);
    }
    const formerOwner = await fetch(`${root}/v1/tasks/108`, { headers: headers('previous') });
    assert.equal(formerOwner.status, 403);
    assert.equal((await formerOwner.text()).includes('PRIVATE-HISTORICAL-FEEDBACK'), false);
    const anonymous = await fetch(`${root}/v1/tasks/108`);
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.text()).includes('PRIVATE-HISTORICAL-FEEDBACK'), false);
  });
  assert.equal(detailReads, 2, 'denied callers do not load feedback');
});

test('blind reviewers cannot obtain historical feedback by guessing a task ID', async () => {
  let detailReads = 0;
  const repository = {
    getUserByUsername: async username => users[username],
    getTaskAccess: async () => ({ ...access, activeBlindQa: true }),
    getTask: async () => { detailReads++; return { ...access, secondaryAssignmentFeedback: feedback }; },
  };
  await withServer(repository, async root => {
    const response = await fetch(`${root}/v1/tasks/108`, { headers: headers('reviewer') });
    assert.equal(response.status, 404);
    assert.equal((await response.text()).includes('PRIVATE-HISTORICAL-FEEDBACK'), false);
  });
  assert.equal(detailReads, 0);
});

test('a reassignment during a detail read withholds historical feedback from the former owner', async () => {
  let accessReads = 0;
  const repository = {
    getUserByUsername: async username => users[username],
    getTaskAccess: async () => ++accessReads === 1 ? access
      : { ...access, assignedToUserId: 'previous', assignedToAccountId: 3 },
    getTask: async () => ({ ...access, secondaryAssignmentFeedback: feedback }),
  };
  await withServer(repository, async root => {
    const response = await fetch(`${root}/v1/tasks/108`, { headers: headers('owner') });
    assert.equal(response.status, 403);
    assert.equal((await response.text()).includes('PRIVATE-HISTORICAL-FEEDBACK'), false);
  });
  assert.equal(accessReads, 2);
});
