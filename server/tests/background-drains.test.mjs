import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoalescedWorker } from '../src/coalesced-worker.mjs';
import { createPreviewServiceClient, drainDeliveryPreviewRevocations } from '../src/delivery-preview.mjs';

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('slow timer bursts reserve one follow-up and shutdown cancels it while awaiting current writes', async () => {
  const first = Promise.withResolvers(), second = Promise.withResolvers();
  let calls = 0, signal;
  const worker = createCoalescedWorker(async currentSignal => {
    signal = currentSignal;
    calls++;
    await (calls === 1 ? first.promise : second.promise);
  });
  const running = worker.wake();
  await settle();
  for (let i = 0; i < 1000; i++) assert.equal(worker.wake(), running);
  assert.equal(calls, 1);
  first.resolve(); await settle();
  assert.equal(calls, 2);
  for (let i = 0; i < 1000; i++) worker.wake();
  let stopped = false;
  const stopping = worker.dispose().then(() => { stopped = true; });
  assert.equal(signal.aborted, true);
  await settle(); assert.equal(stopped, false);
  second.resolve(); await stopping;
  assert.equal(calls, 2);
  await worker.wake();
  assert.equal(calls, 2);
});

test('coalesced drain recovers after an error and does not create an unhandled rejection', async () => {
  const errors = [];
  let calls = 0;
  const worker = createCoalescedWorker(async () => { if (++calls === 1) throw new Error('temporary failure'); },
    { onError: error => errors.push(error.message) });
  await worker.wake();
  await worker.wake();
  assert.deepEqual(errors, ['temporary failure']);
  assert.equal(calls, 2);
  await worker.dispose();
});

test('preview revocation uses bounded parallel calls and waits for durable acknowledgements', async () => {
  const jobs = [1, 2, 3, 4, 5].map(id => ({ id, previewId: String(id) }));
  const calls = [], completed = [], failed = [];
  const gates = new Map(jobs.map(job => [job.previewId, Promise.withResolvers()]));
  const acknowledgements = new Map(jobs.map(job => [job.previewId, Promise.withResolvers()]));
  let active = 0, peak = 0, done = false;
  const running = drainDeliveryPreviewRevocations({
    claimDeliveryPreviewRevocationJobs: async () => jobs,
    markDeliveryPreviewRevoked: async id => { await acknowledgements.get(id).promise; completed.push(id); },
    failDeliveryPreviewRevocationJob: async id => { await acknowledgements.get(String(id)).promise; failed.push(id); },
  }, { revoke: async id => {
    calls.push(id); active++; peak = Math.max(peak, active);
    try { await gates.get(id).promise; if (id === '2') throw new Error('upstream offline'); return { revokedAt: Date.now() }; }
    finally { active--; }
  } }, { concurrency: 2 }).then(result => { done = true; return result; });
  await settle();
  assert.deepEqual(calls, ['1', '2']);
  gates.get('1').resolve(); gates.get('2').resolve(); await settle();
  assert.equal(calls.length, 2, 'slots include durable acknowledgement work');
  for (const gate of acknowledgements.values()) gate.resolve(); await settle();
  assert.deepEqual(calls, ['1', '2', '3', '4']);
  gates.get('3').resolve(); gates.get('4').resolve(); await settle();
  assert.equal(done, false);
  gates.get('5').resolve();
  assert.deepEqual(await running, { claimed: 5, revoked: 4, failed: 1 });
  assert.equal(peak, 2);
  assert.deepEqual(completed, ['1', '3', '4', '5']);
  assert.deepEqual(failed, [2]);
});

test('abort retains claimed revocations through durable failures and does not claim after stopping', async () => {
  const controller = new AbortController();
  const failureWrite = Promise.withResolvers();
  const failed = [];
  let claims = 0, done = false;
  const repository = {
    claimDeliveryPreviewRevocationJobs: async () => { claims++; controller.abort(); return [{ id: 1 }, { id: 2 }]; },
    failDeliveryPreviewRevocationJob: async id => { await failureWrite.promise; failed.push(id); },
  };
  const client = { revoke: async () => assert.fail('aborted jobs must not call the upstream') };
  const running = drainDeliveryPreviewRevocations(repository, client, { signal: controller.signal }).then(result => { done = true; return result; });
  await settle();
  assert.equal(done, false);
  failureWrite.resolve();
  assert.deepEqual(await running, { claimed: 2, revoked: 0, failed: 2 });
  assert.deepEqual(failed, [1, 2]);
  await drainDeliveryPreviewRevocations(repository, client, { signal: controller.signal });
  assert.equal(claims, 1);
});

test('revocation timeout is independent from the longer image upload timeout', async t => {
  const keepAlive = setTimeout(() => {}, 2000);
  t.after(() => clearTimeout(keepAlive));
  const client = createPreviewServiceClient({ baseUrl: 'https://preview.invalid', apiKey: 'fake-test-key',
    timeoutMs: 300_000, revokeTimeoutMs: 1000,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  });
  const started = Date.now();
  await assert.rejects(client.revoke('11111111-1111-4111-8111-111111111111'));
  assert.ok(Date.now() - started < 1900, 'revocation must not wait for the upload timeout');
});
