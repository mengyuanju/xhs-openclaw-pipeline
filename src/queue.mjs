import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const STATUSES = ['pending', 'processing', 'completed', 'failed'];
const MAX_QUERY_LENGTH = 500;
const MAX_INPUT_BYTES = 20_000;
const MAX_ERROR_LENGTH = 2_000;
const FAILURE_CLASSES = ['AUTH', 'TRANSIENT', 'QUALITY', 'STRUCTURE', 'CONFIGURATION', 'UNKNOWN'];

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

function normalizeFailureClass(value) {
  const failureClass = String(value ?? '').trim().toUpperCase();
  if (!FAILURE_CLASSES.includes(failureClass)) throw new TypeError('failureClass is invalid');
  return failureClass;
}

function normalizeCircuitName(value) {
  const name = String(value ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name)) throw new TypeError('circuit name is invalid');
  return name;
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
    recoveryAttempts: Number(row.recovery_attempts),
    recoveryTotalAttempts: Number(row.recovery_total_attempts),
    recoveryClass: row.recovery_class,
    nextAttemptAt: row.next_attempt_at,
    manualRequired: row.manual_required === 1,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    outputDir: row.output_dir,
    error: row.error,
    processingStartedAt: row.processing_started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function initializeQueueSchema(db) {
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
      recovery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (recovery_attempts >= 0),
      recovery_total_attempts INTEGER NOT NULL DEFAULT 0 CHECK (recovery_total_attempts >= 0),
      recovery_class TEXT,
      next_attempt_at TEXT,
      manual_required INTEGER NOT NULL DEFAULT 0 CHECK (manual_required IN (0, 1)),
      lease_owner TEXT,
      lease_until TEXT,
      output_dir TEXT,
      error TEXT,
      processing_started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS tasks_status_id_idx ON tasks(status, id);
    CREATE INDEX IF NOT EXISTS tasks_lease_idx ON tasks(status, lease_until);
    CREATE TABLE IF NOT EXISTS queue_circuit_breakers (
      name TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
      reason TEXT,
      opened_at TEXT,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
  const columns = new Set(
    db.prepare('PRAGMA table_info(tasks)').all().map((column) => column.name),
  );
  if (!columns.has('processing_started_at')) {
    db.exec('ALTER TABLE tasks ADD COLUMN processing_started_at TEXT');
  }
  if (!columns.has('finished_at')) {
    db.exec('ALTER TABLE tasks ADD COLUMN finished_at TEXT');
  }
  if (!columns.has('recovery_attempts')) {
    db.exec('ALTER TABLE tasks ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (recovery_attempts >= 0)');
  }
  if (!columns.has('recovery_total_attempts')) {
    db.exec('ALTER TABLE tasks ADD COLUMN recovery_total_attempts INTEGER NOT NULL DEFAULT 0 CHECK (recovery_total_attempts >= 0)');
  }
  if (!columns.has('recovery_class')) db.exec('ALTER TABLE tasks ADD COLUMN recovery_class TEXT');
  if (!columns.has('next_attempt_at')) db.exec('ALTER TABLE tasks ADD COLUMN next_attempt_at TEXT');
  if (!columns.has('manual_required')) {
    db.exec('ALTER TABLE tasks ADD COLUMN manual_required INTEGER NOT NULL DEFAULT 0 CHECK (manual_required IN (0, 1))');
  }
  db.exec('CREATE INDEX IF NOT EXISTS tasks_next_attempt_idx ON tasks(status, next_attempt_at, id)');
}

export function createQueue(databasePath) {
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true });
  }
  const db = new DatabaseSync(databasePath, { timeout: 5_000 });
  initializeQueueSchema(db);

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
          SET status = 'pending', lease_owner = NULL, lease_until = NULL,
              processing_started_at = NULL, finished_at = NULL, updated_at = ?
          WHERE status = 'processing' AND lease_until <= ?
        `).run(nowIso, nowIso);

        const candidate = db.prepare(`
          SELECT id FROM tasks
          WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY id LIMIT 1
        `).get(nowIso);
        if (!candidate) {
          db.exec('COMMIT');
          return null;
        }

        const updated = db.prepare(`
          UPDATE tasks
          SET status = 'processing', attempts = attempts + 1,
              lease_owner = ?, lease_until = ?, error = NULL,
              next_attempt_at = NULL, manual_required = 0,
              processing_started_at = ?, finished_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'pending'
        `).run(workerId, leaseUntil, nowIso, nowIso, candidate.id);
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

    renewLease(id, { workerId: rawWorkerId, leaseMs = 10 * 60_000, now: rawNow = new Date() }) {
      const workerId = normalizeWorkerId(rawWorkerId);
      if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 60 * 60_000) {
        throw new RangeError('leaseMs must be an integer between 1000 and 3600000');
      }
      const now = normalizeNow(rawNow);
      const nowIso = now.toISOString();
      const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
      const result = db.prepare(`
        UPDATE tasks
        SET lease_until = ?, updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_owner = ?
      `).run(leaseUntil, nowIso, id, workerId);
      if (Number(result.changes) !== 1) {
        throw new Error('task is not processing or lease owner does not match');
      }
      return rowToTask(getById.get(id));
    },

    complete(id, { workerId: rawWorkerId, outputDir, now: rawNow = new Date() }) {
      const workerId = normalizeWorkerId(rawWorkerId);
      if (typeof outputDir !== 'string' || outputDir.length === 0 || outputDir.length > 500) {
        throw new TypeError('outputDir must be a non-empty string of at most 500 characters');
      }
      const nowIso = normalizeNow(rawNow).toISOString();
      const result = db.prepare(`
        UPDATE tasks
        SET status = 'completed', output_dir = ?, error = NULL,
            lease_owner = NULL, lease_until = NULL, next_attempt_at = NULL,
            manual_required = 0, finished_at = ?, updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_owner = ?
      `).run(outputDir, nowIso, nowIso, id, workerId);
      if (Number(result.changes) !== 1) {
        throw new Error('task is not processing or lease owner does not match');
      }
      return rowToTask(getById.get(id));
    },

    fail(id, {
      workerId: rawWorkerId,
      error,
      failureClass: rawFailureClass = 'UNKNOWN',
      manualRequired = true,
      now: rawNow = new Date(),
    }) {
      const workerId = normalizeWorkerId(rawWorkerId);
      const failureClass = normalizeFailureClass(rawFailureClass);
      if (typeof manualRequired !== 'boolean') throw new TypeError('manualRequired must be a boolean');
      const nowIso = normalizeNow(rawNow).toISOString();
      const result = db.prepare(`
        UPDATE tasks
        SET status = 'failed', error = ?, recovery_class = ?, manual_required = ?,
            next_attempt_at = NULL, lease_owner = NULL, lease_until = NULL,
            finished_at = ?, updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_owner = ?
      `).run(redactError(error), failureClass, manualRequired ? 1 : 0, nowIso, nowIso, id, workerId);
      if (Number(result.changes) !== 1) {
        throw new Error('task is not processing or lease owner does not match');
      }
      return rowToTask(getById.get(id));
    },

    scheduleRetry(id, {
      workerId: rawWorkerId,
      error,
      failureClass: rawFailureClass,
      delayMs,
      now: rawNow = new Date(),
    }) {
      const workerId = normalizeWorkerId(rawWorkerId);
      const failureClass = normalizeFailureClass(rawFailureClass);
      if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 15 * 60_000) {
        throw new RangeError('delayMs must be an integer between 0 and 900000');
      }
      const now = normalizeNow(rawNow);
      const nowIso = now.toISOString();
      const nextAttemptAt = new Date(now.getTime() + delayMs).toISOString();
      const result = db.prepare(`
        UPDATE tasks
        SET status = 'pending', error = ?,
            recovery_attempts = CASE WHEN recovery_class = ? THEN recovery_attempts + 1 ELSE 1 END,
            recovery_total_attempts = recovery_total_attempts + 1,
            recovery_class = ?, next_attempt_at = ?, manual_required = 0,
            lease_owner = NULL, lease_until = NULL,
            processing_started_at = NULL, finished_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_owner = ?
      `).run(
        redactError(error),
        failureClass,
        failureClass,
        nextAttemptAt,
        nowIso,
        id,
        workerId,
      );
      if (Number(result.changes) !== 1) {
        throw new Error('task is not processing or lease owner does not match');
      }
      return rowToTask(getById.get(id));
    },

    nextClaimDelayMs({ now: rawNow = new Date() } = {}) {
      const next = db.prepare(`
        SELECT next_attempt_at FROM tasks
        WHERE status = 'pending'
        ORDER BY next_attempt_at IS NOT NULL, next_attempt_at, id
        LIMIT 1
      `).get();
      if (!next) return null;
      if (next.next_attempt_at === null) return 0;
      return Math.max(0, new Date(next.next_attempt_at).getTime() - normalizeNow(rawNow).getTime());
    },

    retry(id, { now: rawNow = new Date() } = {}) {
      const nowIso = normalizeNow(rawNow).toISOString();
      const result = db.prepare(`
        UPDATE tasks
        SET status = 'pending', error = NULL, output_dir = NULL,
            lease_owner = NULL, lease_until = NULL,
            recovery_attempts = 0, recovery_total_attempts = 0,
            recovery_class = NULL, next_attempt_at = NULL, manual_required = 0,
            processing_started_at = NULL, finished_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'failed'
      `).run(nowIso, id);
      if (Number(result.changes) !== 1) throw new Error('only failed tasks can be retried');
      return rowToTask(getById.get(id));
    },

    getCircuit(rawName) {
      const name = normalizeCircuitName(rawName);
      const row = db.prepare('SELECT * FROM queue_circuit_breakers WHERE name = ?').get(name);
      if (!row) return null;
      return {
        name: row.name,
        status: row.status,
        reason: row.reason,
        openedAt: row.opened_at,
        updatedAt: row.updated_at,
      };
    },

    openCircuit(rawName, { reason, now: rawNow = new Date() }) {
      const name = normalizeCircuitName(rawName);
      const nowIso = normalizeNow(rawNow).toISOString();
      db.prepare(`
        INSERT INTO queue_circuit_breakers (name, status, reason, opened_at, updated_at)
        VALUES (?, 'OPEN', ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          status = 'OPEN', reason = excluded.reason,
          opened_at = excluded.opened_at, updated_at = excluded.updated_at
      `).run(name, redactError(reason), nowIso, nowIso);
      return this.getCircuit(name);
    },

    closeCircuit(rawName, { now: rawNow = new Date() } = {}) {
      const name = normalizeCircuitName(rawName);
      const nowIso = normalizeNow(rawNow).toISOString();
      db.prepare(`
        INSERT INTO queue_circuit_breakers (name, status, reason, opened_at, updated_at)
        VALUES (?, 'CLOSED', NULL, NULL, ?)
        ON CONFLICT(name) DO UPDATE SET
          status = 'CLOSED', reason = NULL, updated_at = excluded.updated_at
      `).run(name, nowIso);
      return this.getCircuit(name);
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
