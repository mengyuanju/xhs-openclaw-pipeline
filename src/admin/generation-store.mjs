import { normalizeResearchSnapshot } from '../research.mjs';

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
    qcDetail: parseStoredObject(row.qc_detail_json),
    promptTrace: parseUserPromptTrace(row.prompt_trace_json),
    visualPlan: parseStoredObject(row.visual_plan_json),
    researchSnapshot: parseStoredResearchSnapshot(row.research_snapshot_json),
    error: row.error,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    durationMs: row.duration_ms === null || row.duration_ms === undefined
      ? null
      : Number(row.duration_ms),
    createdAt: row.created_at,
  };
}

function parseStoredObject(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseUserPromptTrace(value) {
  const promptTrace = parseStoredObject(value);
  return promptTrace?.contentKind === 'USER_PROMPT' ? promptTrace : null;
}

function parseStoredResearchSnapshot(value) {
  const snapshot = parseStoredObject(value);
  if (!snapshot) return null;
  try {
    return normalizeResearchSnapshot(snapshot);
  } catch {
    return null;
  }
}

function boundedError(value) {
  if (value === null || value === undefined) return null;
  return String(value instanceof Error ? value.message : value)
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]{12,}\b/gi, 'Bearer [REDACTED_TOKEN]')
    .slice(0, 2_000);
}

function boundedStoredObject(value, label, maxBytes) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const raw = JSON.stringify(value);
  if (typeof raw !== 'string') throw new TypeError(`${label} must be serializable`);
  const serialized = raw
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]{12,}\b/gi, 'Bearer [REDACTED_TOKEN]');
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new RangeError(`${label} cannot exceed ${maxBytes} bytes`);
  }
  return serialized;
}

function boundedQcDetail(value) {
  return boundedStoredObject(value, 'QC detail', 250_000);
}

function boundedPromptTrace(value) {
  return boundedStoredObject(value, 'prompt trace', 100_000);
}

function boundedVisualPlan(value) {
  return boundedStoredObject(value, 'visual plan', 250_000);
}

function boundedResearchSnapshot(value) {
  if (value === null || value === undefined) return null;
  return boundedStoredObject(normalizeResearchSnapshot(value), 'research snapshot', 100_000);
}

function runTiming(startedAt, finishedAt) {
  if (startedAt === null || startedAt === undefined || finishedAt === null || finishedAt === undefined) {
    return { startedAt: null, finishedAt: null, durationMs: null };
  }
  const start = new Date(startedAt);
  const finish = new Date(finishedAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(finish.getTime()) || finish < start) {
    throw new TypeError('generation run timing is invalid');
  }
  return {
    startedAt: start.toISOString(),
    finishedAt: finish.toISOString(),
    durationMs: finish.getTime() - start.getTime(),
  };
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
      qc_detail_json TEXT,
      prompt_trace_json TEXT,
      visual_plan_json TEXT,
      research_snapshot_json TEXT,
      error TEXT,
      started_at TEXT,
      finished_at TEXT,
      duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
      created_at TEXT NOT NULL,
      UNIQUE(task_id, attempt, status)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS generation_runs_task_idx
      ON generation_runs(task_id, id DESC);
  `);
  const columns = new Set(
    db.prepare('PRAGMA table_info(generation_runs)').all().map(({ name }) => name),
  );
  if (!columns.has('qc_detail_json')) {
    db.exec('ALTER TABLE generation_runs ADD COLUMN qc_detail_json TEXT');
  }
  if (!columns.has('prompt_trace_json')) {
    db.exec('ALTER TABLE generation_runs ADD COLUMN prompt_trace_json TEXT');
  }
  if (!columns.has('visual_plan_json')) {
    db.exec('ALTER TABLE generation_runs ADD COLUMN visual_plan_json TEXT');
  }
  if (!columns.has('research_snapshot_json')) {
    db.exec('ALTER TABLE generation_runs ADD COLUMN research_snapshot_json TEXT');
  }
  if (!columns.has('started_at')) db.exec('ALTER TABLE generation_runs ADD COLUMN started_at TEXT');
  if (!columns.has('finished_at')) db.exec('ALTER TABLE generation_runs ADD COLUMN finished_at TEXT');
  if (!columns.has('duration_ms')) {
    db.exec('ALTER TABLE generation_runs ADD COLUMN duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0)');
  }
}

export function createGenerationStore(db) {
  return {
    listGenerationRuns(taskId) {
      return db.prepare(`
        SELECT * FROM generation_runs WHERE task_id = ? ORDER BY id
      `).all(taskId).map(rowToGenerationRun);
    },

    addGenerationRun({
      taskId,
      attempt,
      mode,
      status,
      outputDir = null,
      qc = null,
      promptTrace = null,
      visualPlan = null,
      researchSnapshot = null,
      error = null,
      startedAt = null,
      finishedAt = null,
    }) {
      if (!Number.isInteger(attempt) || attempt < 1) throw new TypeError('generation attempt is invalid');
      if (!['mock', 'live'].includes(mode)) throw new TypeError('generation mode is invalid');
      if (!['COMPLETED', 'FAILED'].includes(status)) throw new TypeError('generation status is invalid');
      const createdAt = new Date().toISOString();
      const qcDetailJson = boundedQcDetail(qc);
      const promptTraceJson = boundedPromptTrace(promptTrace);
      const visualPlanJson = boundedVisualPlan(visualPlan);
      const researchSnapshotJson = boundedResearchSnapshot(researchSnapshot);
      const timing = runTiming(startedAt, finishedAt);
      const result = db.prepare(`
        INSERT INTO generation_runs
          (task_id, attempt, mode, status, output_dir, qc_score, qc_disposition,
           qc_detail_json, prompt_trace_json, visual_plan_json, research_snapshot_json,
           error, started_at, finished_at, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id, attempt, status) DO UPDATE SET
          output_dir = excluded.output_dir,
          qc_score = excluded.qc_score,
          qc_disposition = excluded.qc_disposition,
          qc_detail_json = excluded.qc_detail_json,
          prompt_trace_json = excluded.prompt_trace_json,
          visual_plan_json = excluded.visual_plan_json,
          research_snapshot_json = excluded.research_snapshot_json,
          error = excluded.error,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at,
          duration_ms = excluded.duration_ms,
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
        qcDetailJson,
        promptTraceJson,
        visualPlanJson,
        researchSnapshotJson,
        boundedError(error),
        timing.startedAt,
        timing.finishedAt,
        timing.durationMs,
        createdAt,
      );
      return rowToGenerationRun(db.prepare('SELECT * FROM generation_runs WHERE id = ?').get(result.id));
    },
  };
}
