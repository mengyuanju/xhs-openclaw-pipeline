import assert from 'node:assert/strict';
import test from 'node:test';
import { loadJobCreators } from '../src/control-plane/job-creators.mjs';

test('creator directory retains same-name accounts and disabled users without truncation', async () => {
  const users = Array.from({ length: 251 }, (_, index) => ({
    id: index + 1, username: `operator.${index}`, displayName: '同名作业员', role: 'USER', status: index % 2 ? 'DISABLED' : 'ACTIVE',
  }));
  const result = await loadJobCreators(async (path) => {
    assert.equal(path, '/api/control-plane/v1/users');
    return users;
  });
  assert.deepEqual(result, users);
});

test('malformed creator directory responses reject before rendering instead of crashing the page', async () => {
  const valid = { id: 1, username: 'operator.01', displayName: '作业员', role: 'USER', status: 'ACTIVE' };
  for (const response of [null, {}, { items: [] }, [null], [{ ...valid, username: '' }],
    [{ ...valid, id: null }], [{ ...valid, id: -1 }], [{ ...valid, displayName: null }],
    [{ ...valid, role: undefined }], [{ ...valid, status: false }]]) {
    await assert.rejects(loadJobCreators(async () => response), /作业员.*无效/u);
  }
  assert.deepEqual(await loadJobCreators(async () => []), []);
  await assert.rejects(loadJobCreators(async () => { throw new Error('service unavailable'); }), /service unavailable/u);
});
