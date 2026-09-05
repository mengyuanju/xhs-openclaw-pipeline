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

export function createCodexRuntime({ databasePath = codexRuntimePath(), pollMs = 100, maxConcurrent = 2 } = {}) {
  if (![1, 2].includes(maxConcurrent)) throw new RangeError('Codex concurrency must be 1 or 2');
  function transaction(action) {
    mkdirSync(dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(`PRAGMA busy_timeout = 1000;
        CREATE TABLE IF NOT EXISTS permits (id TEXT PRIMARY KEY, owner_pid INTEGER NOT NULL, child_pid INTEGER, image INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS pause (id INTEGER PRIMARY KEY CHECK (id = 1), code TEXT NOT NULL, retry_at INTEGER NOT NULL);`);
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
          if (state.active >= maxConcurrent || (image && state.images >= 1)) return false;
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
