import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const STATUSES = ['pending', 'processing', 'completed', 'failed'];
const MAX_QUERY_LENGTH = 500;
const MAX_INPUT_BYTES = 20_000;
const MAX_ERROR_LENGTH = 2_000;

function normalizeQuery(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('query cannot be empty');
  }
  const query = value.trim();
  if ([...query].length > MAX_QUERY_LENGTH) {
    throw new RangeError(`query cannot exceed ${MAX_QUERY_LENGTH} characters`);
  }
  return query;
}

function serializeInput(value = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('input must be an object');
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > MAX_INPUT_BYTES) {
    throw new RangeError(`input cannot exceed ${MAX_INPUT_BYTES} bytes`);
  }
  return json;
}

function normalizeWorkerId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,100}$/.test(value)) {
    throw new TypeError('workerId must contain only letters, numbers, dot, underscore, colon or dash');
  }
  return value;
}

function normalizeNow(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('now must be a valid date');
  }
  return date;
}

function redactError(value) {
  const text = value instanceof Error ? value.message : String(value ?? 'Unknown error');
  return text
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]{12,}\b/gi, 'Bearer [REDACTED_TOKEN]')
    .slice(0, MAX_ERROR_LENGTH);
}

function rowToTask(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    query: row.query,
    input: JSON.parse(row.input_json),
    status: row.status,
    attempts: Number(row.attempts),
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    outputDir: row.output_dir,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function initSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY,
      query TEXT NOT NULL,
      input_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      lease_owner TEXT,
      lease_until TEXT,
      output_dir TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS tasks_status_id_idx ON tasks(status, id);
    CREATE INDEX IF NOT EXISTS tasks_lease_idx ON tasks(status, lease_until);
  `);
}

export function createQueue(databasePath) {
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true });
  }
  const db = new DatabaseSync(databasePath, { timeout: 5_000 });
  initSchema(db);

  const getById = db.prepare('SELECT * FROM tasks WHERE id = ?');

  return {
    close() {
      db.close();
    },

    enqueue({ query: rawQuery, input = {} }) {
      const query = normalizeQuery(rawQuery);
      const inputJson = serializeInput(input);
      const now = new Date().toISOString();
      const result = db.prepare(`
        INSERT INTO tasks (query, input_json, status, created_at, updated_at)
        VALUES (?, ?, 'pending', ?, ?)
      `).run(query, inputJson, now, now);
      return rowToTask(getById.get(result.lastInsertRowid));
    },

    get(id) {
      return rowToTask(getById.get(id));
    },

    list({ limit = 50 } = {}) {
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
      return db.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT ?').all(safeLimit).map(rowToTask);
    },

    claimNext({ workerId: rawWorkerId, leaseMs = 10 * 60_000, now: rawNow = new Date() }) {
      const workerId = normalizeWorkerId(rawWorkerId);
      if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 60 * 60_000) {
        throw new RangeError('leaseMs must be an integer between 1000 and 3600000');
      }
      const now = normalizeNow(rawNow);
      const nowIso = now.toISOString();
      const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();

      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`
          UPDATE tasks
          SET status = 'pending', lease_owner = NULL, lease_until = NULL, updated_at = ?
          WHERE status = 'processing' AND lease_until <= ?
        `).run(nowIso, nowIso);

        const candidate = db.prepare(`
          SELECT id FROM tasks WHERE status = 'pending' ORDER BY id LIMIT 1
        `).get();
        if (!candidate) {
          db.exec('COMMIT');
          return null;
        }

        const updated = db.prepare(`
          UPDATE tasks
          SET status = 'processing', attempts = attempts + 1,
              lease_owner = ?, lease_until = ?, error = NULL, updated_at = ?
          WHERE id = ? AND status = 'pending'
        `).run(workerId, leaseUntil, nowIso, candidate.id);
        if (Number(updated.changes) !== 1) {
          throw new Error('task claim conflict');
        }
        const task = rowToTask(getById.get(candidate.id));
        db.exec('COMMIT');
        return task;
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },

    complete(id, { workerId: rawWorkerId, outputDir }) {
      const workerId = normalizeWorkerId(rawWorkerId);
      if (typeof outputDir !== 'string' || outputDir.length === 0 || outputDir.length > 500) {
        throw new TypeError('outputDir must be a non-empty string of at most 500 characters');
      }
      const result = db.prepare(`
        UPDATE tasks
        SET status = 'completed', output_dir = ?, error = NULL,
            lease_owner = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_owner = ?
      `).run(outputDir, new Date().toISOString(), id, workerId);
      if (Number(result.changes) !== 1) {
        throw new Error('task is not processing or lease owner does not match');
      }
      return rowToTask(getById.get(id));
    },

    fail(id, { workerId: rawWorkerId, error }) {
      const workerId = normalizeWorkerId(rawWorkerId);
      const result = db.prepare(`
        UPDATE tasks
        SET status = 'failed', error = ?, lease_owner = NULL,
            lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_owner = ?
      `).run(redactError(error), new Date().toISOString(), id, workerId);
      if (Number(result.changes) !== 1) {
        throw new Error('task is not processing or lease owner does not match');
      }
      return rowToTask(getById.get(id));
    },

    countByStatus() {
      const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
      for (const row of db.prepare('SELECT status, COUNT(*) AS count FROM tasks GROUP BY status').all()) {
        counts[row.status] = Number(row.count);
      }
      return counts;
    },
  };
}
