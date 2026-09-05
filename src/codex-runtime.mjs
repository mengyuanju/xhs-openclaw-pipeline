import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { codexFailure } from './codex-protocol.mjs';

export function codexRuntimePath(environment = process.env) {
  return environment.XHS_CODEX_RUNTIME_DB || join(environment.CODEX_HOME || join(homedir(), '.codex'), 'xhs-runtime', 'limits.sqlite');
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function validateCapacity(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 32) throw new RangeError(`${name} must be an integer from 1 to 32`);
  return value;
}

export function codexConcurrencyConfig(environment = process.env) {
  const read = (name, fallback) => {
    const value = environment[name];
    if (value === undefined) return fallback;
    if (!/^[0-9]+$/u.test(String(value))) throw new RangeError(`${name} must be an integer from 1 to 32`);
    return validateCapacity(Number(value), name);
  };
  const maxConcurrent = read('XHS_CODEX_CONCURRENCY', 2);
  const maxConcurrentImages = read('XHS_CODEX_IMAGE_CONCURRENCY', 1);
  if (maxConcurrentImages > maxConcurrent) throw new RangeError('Codex image concurrency cannot exceed total concurrency');
  return { maxConcurrent, maxConcurrentImages };
}

export function createCodexRuntime({ databasePath = codexRuntimePath(), pollMs = 100,
  maxConcurrent = 2, maxConcurrentImages = 1 } = {}) {
  validateCapacity(maxConcurrent, 'Codex total concurrency');
  validateCapacity(maxConcurrentImages, 'Codex image concurrency');
  if (maxConcurrentImages > maxConcurrent) throw new RangeError('Codex image concurrency cannot exceed total concurrency');
  function transaction(action) {
    mkdirSync(dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(`PRAGMA busy_timeout = 1000;
        CREATE TABLE IF NOT EXISTS permits (id TEXT PRIMARY KEY, owner_pid INTEGER NOT NULL, child_pid INTEGER, image INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS pause (id INTEGER PRIMARY KEY CHECK (id = 1), code TEXT NOT NULL, retry_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS concurrency_config (id INTEGER PRIMARY KEY CHECK (id = 1), total INTEGER NOT NULL, images INTEGER NOT NULL);`);
      db.exec('BEGIN IMMEDIATE');
      const result = action(db);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    } finally { db.close(); }
  }

  function snapshot(db) {
    for (const permit of db.prepare('SELECT * FROM permits').all()) {
      // A surviving child retains its slot even if its Node worker has died.
      if (!alive(permit.owner_pid) && !alive(permit.child_pid)) {
        db.prepare('DELETE FROM permits WHERE id = ?').run(permit.id);
      }
    }
    db.prepare('DELETE FROM pause WHERE retry_at > 0 AND retry_at <= ?').run(Date.now());
    const pause = db.prepare('SELECT code, retry_at FROM pause WHERE id = 1').get();
    const counts = db.prepare('SELECT COUNT(*) AS active, COALESCE(SUM(image), 0) AS images FROM permits').get();
    return { ...counts, code: pause?.code ?? null, retryAt: pause?.retry_at ?? null };
  }
  function assertStatus(state) {
    if (state.code) throw Object.assign(codexFailure({}, state.code), { retryAt: state.retryAt });
  }
  const api = {
    status: () => transaction(snapshot),
    assertAvailable() { assertStatus(api.status()); },
    reset() { transaction((db) => db.prepare('DELETE FROM pause WHERE id = 1').run()); },
    async run(operation, { image = false, signal, waitMs = 600_000 } = {}) {
      const id = randomUUID();
      const deadline = Date.now() + waitMs;
      while (true) {
        signal?.throwIfAborted();
        const acquired = transaction((db) => {
          const state = snapshot(db);
          assertStatus(state);
          const policy = db.prepare('SELECT total, images FROM concurrency_config WHERE id = 1').get();
          // Existing permits without a policy were issued by the legacy 2/1 runtime.
          const current = policy ?? { total: 2, images: 1 };
          if (state.active > 0 && (current.total !== maxConcurrent || current.images !== maxConcurrentImages)) {
            throw codexFailure({ message: 'Shared runtime concurrency differs; stop active callers and restart them with consistent environment settings.' }, 'CODEX_CONCURRENCY_MISMATCH');
          }
          if (!policy || current.total !== maxConcurrent || current.images !== maxConcurrentImages) {
            db.prepare('INSERT INTO concurrency_config(id, total, images) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET total = excluded.total, images = excluded.images')
              .run(maxConcurrent, maxConcurrentImages);
          }
          if (state.active >= maxConcurrent || (image && state.images >= maxConcurrentImages)) return false;
          db.prepare('INSERT INTO permits (id, owner_pid, image) VALUES (?, ?, ?)').run(id, process.pid, Number(image));
          return true;
        });
        if (acquired) break;
        if (Date.now() >= deadline) throw codexFailure({ message: 'local concurrency queue timed out' }, 'CODEX_QUEUE_TIMEOUT');
        await sleep(pollMs, undefined, { signal });
      }
      try {
        signal?.throwIfAborted();
        return await operation({
          onSpawn(pid) {
            if (!Number.isSafeInteger(pid) || pid < 1) throw new TypeError('Codex child PID is invalid');
            transaction((db) => db.prepare('UPDATE permits SET child_pid = ? WHERE id = ?').run(pid, id));
          },
        });
      } catch (error) {
        if (['CODEX_AUTH_REQUIRED', 'CODEX_QUOTA_EXHAUSTED', 'CODEX_RATE_LIMITED'].includes(error?.code)) {
          transaction((db) => {
            const existing = db.prepare('SELECT retry_at FROM pause WHERE id = 1').get();
            const retryAt = error.code === 'CODEX_RATE_LIMITED' ? Date.now() + 60_000 + Math.floor(Math.random() * 5000) : 0;
            if (existing?.retry_at === 0 && retryAt > 0) return;
            db.prepare('INSERT INTO pause (id, code, retry_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET code = excluded.code, retry_at = excluded.retry_at')
              .run(error.code, retryAt);
          });
        }
        throw error;
      } finally {
        transaction((db) => db.prepare('DELETE FROM permits WHERE id = ?').run(id));
      }
    },
  };
  return api;
}
