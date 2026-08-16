function rowToGenerationRun(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    taskId: Number(row.task_id),
    attempt: Number(row.attempt),
    mode: row.mode,
    status: row.status,
    outputDir: row.output_dir,
    qcScore: row.qc_score === null ? null : Number(row.qc_score),
    qcDisposition: row.qc_disposition,
    error: row.error,
    createdAt: row.created_at,
  };
}

function boundedError(value) {
  if (value === null || value === undefined) return null;
  return String(value instanceof Error ? value.message : value)
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]{12,}\b/gi, 'Bearer [REDACTED_TOKEN]')
    .slice(0, 2_000);
}

export function initializeGenerationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS generation_runs (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      mode TEXT NOT NULL CHECK (mode IN ('mock', 'live')),
      status TEXT NOT NULL CHECK (status IN ('COMPLETED', 'FAILED')),
      output_dir TEXT,
      qc_score REAL,
      qc_disposition TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(task_id, attempt, status)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS generation_runs_task_idx
      ON generation_runs(task_id, id DESC);
  `);
}

export function createGenerationStore(db) {
  return {
    listGenerationRuns(taskId) {
      return db.prepare(`
        SELECT * FROM generation_runs WHERE task_id = ? ORDER BY id
      `).all(taskId).map(rowToGenerationRun);
    },

    addGenerationRun({ taskId, attempt, mode, status, outputDir = null, qc = null, error = null }) {
      if (!Number.isInteger(attempt) || attempt < 1) throw new TypeError('generation attempt is invalid');
      if (!['mock', 'live'].includes(mode)) throw new TypeError('generation mode is invalid');
      if (!['COMPLETED', 'FAILED'].includes(status)) throw new TypeError('generation status is invalid');
      const createdAt = new Date().toISOString();
      const result = db.prepare(`
        INSERT INTO generation_runs
          (task_id, attempt, mode, status, output_dir, qc_score, qc_disposition, error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id, attempt, status) DO UPDATE SET
          output_dir = excluded.output_dir,
          qc_score = excluded.qc_score,
          qc_disposition = excluded.qc_disposition,
          error = excluded.error,
          created_at = excluded.created_at
        RETURNING id
      `).get(
        taskId,
        attempt,
        mode,
        status,
        outputDir,
        qc?.overallScore ?? null,
        qc?.disposition ?? null,
        boundedError(error),
        createdAt,
      );
      return rowToGenerationRun(db.prepare('SELECT * FROM generation_runs WHERE id = ?').get(result.id));
    },
  };
}
