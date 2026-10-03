import assert from 'node:assert/strict';
import test from 'node:test';
import { createImageQualityTailDrain } from '../src/image-quality-tail-flush.mjs';

const actor = { role: 'ADMIN', userId: 1 };
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(count, freezeHook = async () => {}) {
  const pending = Array.from({ length: count }, (_, index) => ({ production_batch_id: index + 1, submitted_by_account_id: 2 }));
  const frozen = [], queries = [];
  const drain = createImageQualityTailDrain({
    pool: { query: async (sql, values) => {
      queries.push({ sql, values });
      if (sql.includes('SELECT task.priority_sort_at')) return { rows: [] };
      return { rows: pending.slice(0, values[3]) };
    } },
    readSettings: async () => ({ imageSampling: { enabled: true, rateBps: 2000 } }),
    freeze: async row => {
      await freezeHook(row);
      const index = pending.findIndex(item => item.production_batch_id === row.production_batch_id);
      if (index < 0) return null;
      pending.splice(index, 1);
      frozen.push(row.production_batch_id);
      return row;
    },
  });
  return { drain, pending, frozen, queries };
}

test('background tails share in-flight work and process at most twenty batches per sweep', async () => {
  const gate = Promise.withResolvers();
  const f = fixture(27, () => gate.promise);
  const first = f.drain.flush();
  assert.equal(f.drain.flush(), first);
  await settle();
  assert.equal(f.queries.length, 1);
  assert.equal(f.queries[0].values[3], 20);
  gate.resolve();
  assert.equal((await first).length, 20);
  assert.equal(f.pending.length, 7);
  assert.equal((await f.drain.flush()).length, 7);
  await f.drain.dispose();
});

test('foreground and background requests share the same batch freeze without omitting further page candidates', async () => {
  const gate = Promise.withResolvers();
  const f = fixture(27, () => gate.promise);
  const background = f.drain.flush();
  const page = f.drain.flushForPage({ actor, limit: 50, offset: 0, status: 'PENDING', personName: null });
  await settle(); gate.resolve();
  const results = await Promise.all([background, page]);
  assert.equal(results[0].length, 20);
  assert.equal(results[1].length, 27);
  assert.equal(f.frozen.length, 27);
  assert.equal(new Set(f.frozen).size, 27);
  await f.drain.dispose();
});

test('existing item details and terminal filters avoid unrelated tail reads', async () => {
  const f = fixture(27);
  for (const status of ['PASSED', 'RETURNED', 'BATCH_RETURNED', 'DISCARDED', 'ADMIN_ESCALATED']) {
    assert.deepEqual(await f.drain.flushForPage({ actor, status }), []);
  }
  assert.deepEqual(await f.drain.flushForPage({ actor, status: 'PENDING', itemPublicId: 'already-frozen' }), []);
  assert.equal(f.queries.length, 0);
  assert.equal(f.frozen.length, 0);
});

test('shutdown awaits the active freeze and stops the remaining bounded sweep', async () => {
  const gate = Promise.withResolvers();
  const f = fixture(27, () => gate.promise);
  const running = f.drain.flush();
  await settle();
  let done = false;
  const stopping = f.drain.dispose().then(() => { done = true; });
  await settle(); assert.equal(done, false);
  gate.resolve(); await Promise.all([stopping, running]);
  assert.deepEqual(f.frozen, [1]);
  await f.drain.flush();
  assert.deepEqual(f.frozen, [1]);
});

test('independent page scopes share at most two active batch transactions', async () => {
  const pending = new Set([1, 2, 3, 4]);
  const gates = new Map([...pending].map(id => [id, Promise.withResolvers()]));
  let active = 0, peak = 0;
  const started = [];
  const drain = createImageQualityTailDrain({
    pool: { query: async (sql, values) => {
      if (sql.includes('SELECT task.priority_sort_at')) return { rows: [] };
      const id = Number(values[2]);
      return { rows: pending.has(id) ? [{ production_batch_id: id, submitted_by_account_id: id }] : [] };
    } },
    readSettings: async () => ({ imageSampling: { enabled: true, rateBps: 2000 } }),
    freeze: async row => {
      const id = row.production_batch_id;
      active++; peak = Math.max(peak, active); started.push(id);
      await gates.get(id).promise;
      pending.delete(id); active--;
      return row;
    },
  });
  const pages = [1, 2, 3, 4].map(id => drain.flushForPage({ actor, status: 'PENDING', personName: String(id), limit: 50, offset: 0 }));
  await settle(); assert.deepEqual(started, [1, 2]);
  gates.get(1).resolve(); await settle(); assert.deepEqual(started, [1, 2, 3]);
  gates.get(2).resolve(); await settle(); assert.deepEqual(started, [1, 2, 3, 4]);
  gates.get(3).resolve(); gates.get(4).resolve();
  await Promise.all(pages);
  assert.equal(peak, 2);
  await drain.dispose();
});
