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

function validateModelCapacityCooldown(value) {
  if (!Number.isInteger(value) || value < 60_000 || value > 3_600_000) {
    throw new RangeError('Codex model capacity cooldown must be an integer from 60000 to 3600000');
  }
  return value;
}

function modelKey(value) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 200 || /\s/u.test(value)) {
    throw new TypeError('Codex runtime model must be a bounded model name');
  }
  return value;
}

function modelCandidates(values) {
  if (!Array.isArray(values) || values.length < 1) throw new TypeError('Codex runtime requires at least one model candidate');
  return [...new Set(values.filter(Boolean).map(modelKey))];
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
  maxConcurrent = 2, maxConcurrentImages = 1, modelCapacityCooldownMs = 300_000 } = {}) {
  validateCapacity(maxConcurrent, 'Codex total concurrency');
  validateCapacity(maxConcurrentImages, 'Codex image concurrency');
  validateModelCapacityCooldown(modelCapacityCooldownMs);
  if (maxConcurrentImages > maxConcurrent) throw new RangeError('Codex image concurrency cannot exceed total concurrency');
  function transaction(action) {
    mkdirSync(dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(`PRAGMA busy_timeout = 1000;
        CREATE TABLE IF NOT EXISTS permits (id TEXT PRIMARY KEY, owner_pid INTEGER NOT NULL, child_pid INTEGER, image INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS pause (id INTEGER PRIMARY KEY CHECK (id = 1), code TEXT NOT NULL, retry_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS model_capacity (
          model TEXT PRIMARY KEY,
          retry_at INTEGER NOT NULL,
          failure_count INTEGER NOT NULL,
          probe_owner TEXT,
          probe_pid INTEGER,
          probe_until INTEGER
        );
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
    const timestamp = Date.now();
    for (const permit of db.prepare('SELECT * FROM permits').all()) {
      // A surviving child retains its slot even if its Node worker has died.
      if (!alive(permit.owner_pid) && !alive(permit.child_pid)) {
        db.prepare('DELETE FROM permits WHERE id = ?').run(permit.id);
      }
    }
    db.prepare('DELETE FROM pause WHERE retry_at > 0 AND retry_at <= ?').run(timestamp);
    for (const probe of db.prepare('SELECT model, probe_pid, probe_until FROM model_capacity WHERE probe_owner IS NOT NULL').all()) {
      if (probe.probe_until <= timestamp || !alive(probe.probe_pid)) {
        db.prepare('UPDATE model_capacity SET probe_owner = NULL, probe_pid = NULL, probe_until = NULL WHERE model = ?').run(probe.model);
      }
    }
    const pause = db.prepare('SELECT code, retry_at FROM pause WHERE id = 1').get();
    const counts = db.prepare('SELECT COUNT(*) AS active, COALESCE(SUM(image), 0) AS images FROM permits').get();
    const modelCooldowns = db.prepare('SELECT model, retry_at, failure_count, probe_owner, probe_until FROM model_capacity ORDER BY model').all()
      .map((row) => ({
        model: row.model,
        retryAt: row.retry_at,
        failureCount: row.failure_count,
        state: row.retry_at > timestamp ? 'OPEN' : row.probe_owner ? 'HALF_OPEN' : 'READY_FOR_PROBE',
        ...(row.probe_owner ? { probeUntil: row.probe_until } : {}),
      }));
    return { ...counts, code: pause?.code ?? null, retryAt: pause?.retry_at ?? null, modelCooldowns };
  }
  function assertStatus(state) {
    if (state.code) throw Object.assign(codexFailure({}, state.code), { retryAt: state.retryAt });
  }

  function modelAvailability(db, candidates) {
    const timestamp = Date.now();
    const rows = new Map(db.prepare('SELECT model, retry_at, probe_owner, probe_until FROM model_capacity').all()
      .map((row) => [row.model, row]));
    let retryAt = null;
    for (const [index, model] of candidates.entries()) {
      const row = rows.get(model);
      if (!row || (row.retry_at <= timestamp && !row.probe_owner)) {
        return { model, fallbackUsed: index > 0, fallbackFrom: index > 0 ? candidates[0] : null };
      }
      const availableAt = row.retry_at > timestamp ? row.retry_at : row.probe_until;
      if (Number.isSafeInteger(availableAt)) retryAt = retryAt === null ? availableAt : Math.min(retryAt, availableAt);
    }
    const error = codexFailure({ message: 'all configured model candidates are temporarily at capacity' }, 'CODEX_MODEL_AT_CAPACITY');
    throw Object.assign(error, { retryAt });
  }

  function claimProbe(db, model, owner) {
    if (!model) return false;
    const timestamp = Date.now();
    const row = db.prepare('SELECT retry_at, probe_owner, probe_until FROM model_capacity WHERE model = ?').get(model);
    if (!row) return false;
    if (row.retry_at > timestamp || row.probe_owner) {
      const retryAt = row.retry_at > timestamp ? row.retry_at : row.probe_until;
      throw Object.assign(codexFailure({ message: `model ${model} is temporarily at capacity` }, 'CODEX_MODEL_AT_CAPACITY'), { retryAt });
    }
    db.prepare('UPDATE model_capacity SET probe_owner = ?, probe_pid = ?, probe_until = ? WHERE model = ?')
      .run(owner, process.pid, timestamp + 900_000, model);
    return true;
  }

  function recordModelCapacity(db, model, owner) {
    const timestamp = Date.now();
    const existing = db.prepare('SELECT retry_at, failure_count, probe_owner FROM model_capacity WHERE model = ?').get(model);
    if (existing?.retry_at > timestamp && existing.probe_owner !== owner) return existing.retry_at;
    const failureCount = Math.min(16, (existing?.failure_count ?? 0) + 1);
    const cooldownMs = Math.min(3_600_000, modelCapacityCooldownMs * (2 ** Math.min(failureCount - 1, 4)));
    const retryAt = timestamp + cooldownMs;
    db.prepare(`INSERT INTO model_capacity(model, retry_at, failure_count, probe_owner, probe_pid, probe_until)
      VALUES (?, ?, ?, NULL, NULL, NULL)
      ON CONFLICT(model) DO UPDATE SET retry_at = excluded.retry_at, failure_count = excluded.failure_count,
        probe_owner = NULL, probe_pid = NULL, probe_until = NULL`)
      .run(model, retryAt, failureCount);
    return retryAt;
  }

  function releaseProbe(db, model, owner, succeeded) {
    if (!model || !owner) return;
    if (succeeded) db.prepare('DELETE FROM model_capacity WHERE model = ? AND probe_owner = ?').run(model, owner);
    else db.prepare(`UPDATE model_capacity SET probe_owner = NULL, probe_pid = NULL, probe_until = NULL
      WHERE model = ? AND probe_owner = ?`).run(model, owner);
  }
  const api = {
    status: () => transaction(snapshot),
    assertAvailable() { assertStatus(api.status()); },
    selectModel(values) {
      const candidates = modelCandidates(values);
      return transaction((db) => {
        assertStatus(snapshot(db));
        return modelAvailability(db, candidates);
      });
    },
    assertAnyModelAvailable(values) {
      const candidates = modelCandidates(values);
      return transaction((db) => {
        assertStatus(snapshot(db));
        return modelAvailability(db, candidates);
      });
    },
    reset() { transaction((db) => { db.prepare('DELETE FROM pause WHERE id = 1').run(); db.prepare('DELETE FROM model_capacity').run(); }); },
    async run(operation, { image = false, signal, waitMs = 600_000, model } = {}) {
      const id = randomUUID();
      const selectedModel = model ? modelKey(model) : null;
      const deadline = Date.now() + waitMs;
      let probeClaimed = false;
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
          probeClaimed = claimProbe(db, selectedModel, id);
          db.prepare('INSERT INTO permits (id, owner_pid, image) VALUES (?, ?, ?)').run(id, process.pid, Number(image));
          return true;
        });
        if (acquired) break;
        if (Date.now() >= deadline) throw codexFailure({ message: 'local concurrency queue timed out' }, 'CODEX_QUEUE_TIMEOUT');
        await sleep(pollMs, undefined, { signal });
      }
      try {
        signal?.throwIfAborted();
        const result = await operation({
          onSpawn(pid) {
            if (!Number.isSafeInteger(pid) || pid < 1) throw new TypeError('Codex child PID is invalid');
            transaction((db) => db.prepare('UPDATE permits SET child_pid = ? WHERE id = ?').run(pid, id));
          },
        });
        if (probeClaimed) transaction((db) => releaseProbe(db, selectedModel, id, true));
        return result;
      } catch (error) {
        if (error?.code === 'CODEX_MODEL_AT_CAPACITY' && selectedModel) {
          const retryAt = transaction((db) => recordModelCapacity(db, selectedModel, id));
          if (!Number.isSafeInteger(error.retryAt)) error.retryAt = retryAt;
        } else if (['CODEX_AUTH_REQUIRED', 'CODEX_QUOTA_EXHAUSTED', 'CODEX_RATE_LIMITED', 'CODEX_MODEL_AT_CAPACITY'].includes(error?.code)) {
          transaction((db) => {
            const existing = db.prepare('SELECT retry_at FROM pause WHERE id = 1').get();
            const retryAt = ['CODEX_RATE_LIMITED', 'CODEX_MODEL_AT_CAPACITY'].includes(error.code)
              ? Date.now() + 60_000 + Math.floor(Math.random() * 5000) : 0;
            if (existing?.retry_at === 0 && retryAt > 0) return;
            db.prepare('INSERT INTO pause (id, code, retry_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET code = excluded.code, retry_at = excluded.retry_at')
              .run(error.code, retryAt);
          });
        } else if (probeClaimed) transaction((db) => releaseProbe(db, selectedModel, id, false));
        throw error;
      } finally {
        transaction((db) => {
          const permit = db.prepare('SELECT child_pid FROM permits WHERE id = ?').get(id);
          if (alive(permit?.child_pid)) {
            // The caller may have timed out before Windows confirmed termination.
            // Keep the slot, but let snapshot reclaim it once the child exits.
            db.prepare('UPDATE permits SET owner_pid = 0 WHERE id = ?').run(id);
          } else db.prepare('DELETE FROM permits WHERE id = ?').run(id);
        });
      }
    },
  };
  return api;
}
