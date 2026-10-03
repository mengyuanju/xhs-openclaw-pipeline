import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createExportProgressLease } from '../src/export-progress-lease.mjs';

test('CSV progress is time-based and forces its exact final row count', async () => {
  let clock = 0;
  const writes = [], progress = createExportProgressLease(async rows => writes.push(rows), { now: () => clock });
  try {
    for (let rows = 250; rows <= 100_000; rows += 250) { progress.setRows(rows); await progress.flush(); }
    assert.deepEqual(writes, []);
    clock = 1500; await progress.flush(); assert.deepEqual(writes, [100_000]);
    progress.setRows(100_001); clock = 1600; await progress.flush();
    assert.equal(writes.length, 1);
    await progress.flush(true); assert.deepEqual(writes, [100_000, 100_001]);
  } finally { await progress.dispose(); }
});

test('idle exports still renew and all progress writes run serially', async () => {
  let active = 0, maximum = 0, calls = 0;
  const progress = createExportProgressLease(async () => {
    active += 1; maximum = Math.max(maximum, active); calls += 1;
    await delay(5); active -= 1;
  }, { intervalMs: 10, heartbeatMs: 20 });
  try {
    await delay(45); assert.ok(calls >= 1, 'idle export must not lose its lease while a cursor or disk write waits');
    await Promise.all(Array.from({ length: 5 }, () => progress.flush(true)));
    assert.equal(maximum, 1);
  } finally { await progress.dispose(); }
  const stopped = calls; await delay(25); assert.equal(calls, stopped);
});

test('lost leases abort the producer and cannot be renewed again', async () => {
  const error = new Error('EXPORT_LEASE_LOST'); let calls = 0;
  const progress = createExportProgressLease(async () => { calls += 1; throw error; });
  await assert.rejects(progress.flush(true), /EXPORT_LEASE_LOST/);
  assert.equal(progress.signal.reason, error);
  assert.throws(() => progress.setRows(500), /EXPORT_LEASE_LOST/);
  await assert.rejects(progress.flush(true), /EXPORT_LEASE_LOST/);
  assert.equal(calls, 1); await progress.dispose();
});
