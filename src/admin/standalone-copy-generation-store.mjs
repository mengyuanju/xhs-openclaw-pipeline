const MAX_INPUT_BYTES = 100_000;
const MAX_POST_BYTES = 250_000;
const MAX_REVIEW_BYTES = 100_000;
const MAX_RESEARCH_BYTES = 100_000;
const MAX_HISTORY_PAGE = 1_000_000;
const MAX_JOB_ERROR_LENGTH = 1_000;
const MAX_JOB_LIST_SIZE = 50;
const MAX_BATCH_LIST_SIZE = 50;
const MAX_BATCH_NAME_LENGTH = 100;
const MAX_TIMING_DURATION_MS = 24 * 60 * 60_000;
const MAX_TIMING_SAMPLES = 1_000;
const THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const COPY_GENERATION_JOB_STAGES = new Set([
  'QUERY_REVIEW',
  'RESEARCH',
  'ORIGINAL_GENERATION',
  'ORIGINAL_REVIEW',
  'REVIEWED_GENERATION',
  'REVIEWED_REVIEW',
]);
const TIMING_COLUMNS = [
  ['queryReviewMs', 'query_review_ms'],
  ['researchMs', 'research_ms'],
  ['originalGenerationMs', 'original_generation_ms'],
  ['originalReviewMs', 'original_review_ms'],
  ['reviewedGenerationMs', 'reviewed_generation_ms'],
  ['reviewedReviewMs', 'reviewed_review_ms'],
  ['totalMs', 'total_ms'],
];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value, field, maxLength) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  const text = value.trim();
  if ([...text].length > maxLength) throw new RangeError(`${field} cannot exceed ${maxLength} characters`);
  return text;
}

function redactedSecrets(value) {
  return value
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]{12,}\b/gi, 'Bearer [REDACTED_TOKEN]');
}

function redactedText(value, field, maxLength) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  const redacted = [...redactedSecrets(value.trim())];
  if (redacted.length <= maxLength) return redacted.join('');
  return `${redacted.slice(0, maxLength - 1).join('')}…`;
}

function redactedJson(value, field, maxBytes) {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  const raw = JSON.stringify(value);
  if (typeof raw !== 'string') throw new TypeError(`${field} must be serializable`);
  const serialized = redactedSecrets(raw);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new RangeError(`${field} cannot exceed ${maxBytes} bytes`);
  }
  return serialized;
}

function parsedObject(value, field) {
  try {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed)) throw new TypeError(`${field} is invalid`);
    return parsed;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(`${field} is invalid`);
  }
}

function normalizedRequestedImageCount(value) {
  if (value === 'auto') return 'auto';
  if (Number.isInteger(value) && value >= 3 && value <= 5) return String(value);
  throw new RangeError('requested image count must be auto or an integer between 3 and 5');
}

function normalizedThinking(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const thinking = boundedText(value, field, 20).toLowerCase();
  if (!THINKING_LEVELS.has(thinking)) {
    throw new TypeError(`${field} is not a supported thinking level`);
  }
  return thinking;
}

function normalizedPaginationInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(1, Math.min(maximum, parsed));
}

function normalizedBatchId(value, { optional = false } = {}) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  const id = boundedText(value, 'batch id', 36).toLowerCase();
  if (!UUID_PATTERN.test(id)) throw new TypeError('batch id must be a UUID');
  return id;
}

function normalizedBatch(value) {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new TypeError('batch must be an object');
  return {
    id: normalizedBatchId(value.id),
    name: boundedText(value.name, 'batch name', MAX_BATCH_NAME_LENGTH),
  };
}

function assertCompatibleBatchName(db, batch) {
  if (batch === null) return;
  const existing = db.prepare(`
    SELECT batch_name FROM standalone_copy_generation_jobs WHERE batch_id = ?
    UNION ALL
    SELECT batch_name FROM standalone_copy_generations WHERE batch_id = ?
    LIMIT 1
  `).get(batch.id, batch.id);
  if (existing && existing.batch_name !== batch.name) {
    throw new TypeError('batch name does not match the existing batch id');
  }
}

function normalizedTiming(value) {
  if (!isRecord(value)) throw new TypeError('copy generation timing must be an object');
  return Object.fromEntries(TIMING_COLUMNS.map(([field]) => {
    const duration = value[field];
    if (!Number.isSafeInteger(duration) || duration < 0 || duration > MAX_TIMING_DURATION_MS) {
      throw new RangeError(`${field} must be an integer between 0 and ${MAX_TIMING_DURATION_MS}`);
    }
    return [field, duration];
  }));
}

function timingFromRow(row) {
  if (row.total_ms === null || row.total_ms === undefined) return null;
  return normalizedTiming(Object.fromEntries(
    TIMING_COLUMNS.map(([field, column]) => [field, Number(row[column])]),
  ));
}

function timingStatistics(db) {
  const averages = db.prepare(`
    WITH recent AS (
      SELECT * FROM standalone_copy_generations
      WHERE total_ms IS NOT NULL ORDER BY id DESC LIMIT ?
    )
    SELECT COUNT(total_ms) AS sample_size,
           AVG(total_ms) AS average_ms,
           AVG(query_review_ms) AS query_review_ms,
           AVG(research_ms) AS research_ms,
           AVG(original_generation_ms) AS original_generation_ms,
           AVG(original_review_ms) AS original_review_ms,
           AVG(reviewed_generation_ms) AS reviewed_generation_ms,
           AVG(reviewed_review_ms) AS reviewed_review_ms
    FROM recent
  `).get(MAX_TIMING_SAMPLES);
  const percentiles = db.prepare(`
    WITH recent AS (
      SELECT total_ms FROM standalone_copy_generations
      WHERE total_ms IS NOT NULL ORDER BY id DESC LIMIT ?
    ), ranked AS (
      SELECT total_ms,
             ROW_NUMBER() OVER (ORDER BY total_ms ASC) AS rank,
             COUNT(*) OVER () AS sample_size
      FROM recent
    )
    SELECT MAX(CASE WHEN rank = CAST((sample_size + 1) / 2 AS INTEGER)
                    THEN total_ms END) AS p50_ms,
           MAX(CASE WHEN rank = CAST((95 * sample_size + 99) / 100 AS INTEGER)
                    THEN total_ms END) AS p95_ms
    FROM ranked
  `).get(MAX_TIMING_SAMPLES);
  const rounded = (value) => value === null ? null : Math.round(Number(value));
  return {
    sampleSize: Number(averages.sample_size),
    averageMs: rounded(averages.average_ms),
    p50Ms: rounded(percentiles.p50_ms),
    p95Ms: rounded(percentiles.p95_ms),
    stageAverages: Object.fromEntries(TIMING_COLUMNS.slice(0, -1).map(([field, column]) => (
      [field, rounded(averages[column])]
    ))),
  };
}

function rowToStandaloneCopyGeneration(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    batchId: row.batch_id ?? null,
    batchName: row.batch_name ?? null,
    query: row.query,
    input: parsedObject(row.input_json, 'stored copy generation input'),
    requestedImageCount: row.requested_image_count === 'auto'
      ? 'auto'
      : Number(row.requested_image_count),
    originalPost: parsedObject(row.original_post_json, 'stored original post'),
    reviewedPost: parsedObject(row.reviewed_post_json, 'stored reviewed post'),
    originalModel: row.original_model,
    reviewedModel: row.reviewed_model,
    originalThinking: normalizedThinking(row.original_thinking, 'stored original thinking'),
    reviewedThinking: normalizedThinking(row.reviewed_thinking, 'stored reviewed thinking'),
    researchSnapshot: row.research_snapshot_json === null
      ? null
      : parsedObject(row.research_snapshot_json, 'stored research snapshot'),
    stageReviews: {
      query: parsedObject(row.query_review_json, 'stored query review'),
      originalText: parsedObject(row.original_text_review_json, 'stored original text review'),
      reviewedText: parsedObject(row.reviewed_text_review_json, 'stored reviewed text review'),
    },
    manualReview: row.manual_reviewed_at === null || row.manual_reviewed_at === undefined
      ? null
      : {
          decision: 'APPROVED',
          reviewedAt: row.manual_reviewed_at,
          reviewedBy: row.manual_reviewed_by,
        },
    timing: timingFromRow(row),
    createdAt: row.created_at,
  };
}

function rowToStandaloneCopyGenerationJob(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    batchId: row.batch_id ?? null,
    batchName: row.batch_name ?? null,
    query: row.query,
    status: row.status,
    generationId: row.generation_id === null ? null : Number(row.generation_id),
    currentStage: normalizedJobStage(row.current_stage ?? 'QUERY_REVIEW'),
    stageUpdatedAt: row.stage_updated_at ?? row.created_at,
    error: row.error,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function normalizedJobId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new RangeError('copy generation job id must be a positive integer');
  }
  return id;
}

function normalizedGenerationId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new RangeError('copy generation id must be a positive integer');
  }
  return id;
}

function normalizedJobStage(value) {
  const stage = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!COPY_GENERATION_JOB_STAGES.has(stage)) {
    throw new TypeError('copy generation job stage is invalid');
  }
  return stage;
}

export function initializeStandaloneCopyGenerationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS standalone_copy_generations (
      id INTEGER PRIMARY KEY,
      batch_id TEXT,
      batch_name TEXT,
      query TEXT NOT NULL,
      input_json TEXT NOT NULL,
      requested_image_count TEXT NOT NULL
        CHECK (requested_image_count IN ('auto', '3', '4', '5')),
      original_post_json TEXT NOT NULL,
      reviewed_post_json TEXT NOT NULL,
      original_model TEXT NOT NULL,
      reviewed_model TEXT NOT NULL,
      original_thinking TEXT CHECK (original_thinking IS NULL OR original_thinking IN ('minimal', 'low', 'medium', 'high', 'xhigh', 'max')),
      reviewed_thinking TEXT CHECK (reviewed_thinking IS NULL OR reviewed_thinking IN ('minimal', 'low', 'medium', 'high', 'xhigh', 'max')),
      query_review_json TEXT NOT NULL,
      original_text_review_json TEXT NOT NULL,
      reviewed_text_review_json TEXT NOT NULL,
      research_snapshot_json TEXT,
      query_review_ms INTEGER CHECK (query_review_ms IS NULL OR query_review_ms BETWEEN 0 AND 86400000),
      research_ms INTEGER CHECK (research_ms IS NULL OR research_ms BETWEEN 0 AND 86400000),
      original_generation_ms INTEGER CHECK (original_generation_ms IS NULL OR original_generation_ms BETWEEN 0 AND 86400000),
      original_review_ms INTEGER CHECK (original_review_ms IS NULL OR original_review_ms BETWEEN 0 AND 86400000),
      reviewed_generation_ms INTEGER CHECK (reviewed_generation_ms IS NULL OR reviewed_generation_ms BETWEEN 0 AND 86400000),
      reviewed_review_ms INTEGER CHECK (reviewed_review_ms IS NULL OR reviewed_review_ms BETWEEN 0 AND 86400000),
      total_ms INTEGER CHECK (total_ms IS NULL OR total_ms BETWEEN 0 AND 86400000),
      manual_reviewed_at TEXT,
      manual_reviewed_by TEXT,
      created_at TEXT NOT NULL,
      CHECK (
        (manual_reviewed_at IS NULL AND manual_reviewed_by IS NULL)
        OR (manual_reviewed_at IS NOT NULL AND manual_reviewed_by IS NOT NULL)
      ),
      CHECK (
        (batch_id IS NULL AND batch_name IS NULL)
        OR (batch_id IS NOT NULL AND batch_name IS NOT NULL)
      )
    ) STRICT;
    CREATE INDEX IF NOT EXISTS standalone_copy_generations_created_idx
      ON standalone_copy_generations(id DESC);
    CREATE TABLE IF NOT EXISTS standalone_copy_generation_jobs (
      id INTEGER PRIMARY KEY,
      batch_id TEXT,
      batch_name TEXT,
      query TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
      generation_id INTEGER REFERENCES standalone_copy_generations(id) ON DELETE RESTRICT,
      current_stage TEXT NOT NULL DEFAULT 'QUERY_REVIEW'
        CHECK (current_stage IN ('QUERY_REVIEW', 'RESEARCH', 'ORIGINAL_GENERATION', 'ORIGINAL_REVIEW', 'REVIEWED_GENERATION', 'REVIEWED_REVIEW')),
      stage_updated_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      CHECK (
        (status = 'RUNNING' AND generation_id IS NULL AND error IS NULL AND finished_at IS NULL)
        OR (status = 'COMPLETED' AND generation_id IS NOT NULL AND error IS NULL AND finished_at IS NOT NULL)
        OR (status = 'FAILED' AND generation_id IS NULL AND error IS NOT NULL AND finished_at IS NOT NULL)
      ),
      CHECK (
        (batch_id IS NULL AND batch_name IS NULL)
        OR (batch_id IS NOT NULL AND batch_name IS NOT NULL)
      )
    ) STRICT;
    CREATE INDEX IF NOT EXISTS standalone_copy_generation_jobs_status_idx
      ON standalone_copy_generation_jobs(status, id DESC);
  `);
  const columns = new Set(
    db.prepare('PRAGMA table_info(standalone_copy_generations)').all()
      .map((column) => column.name),
  );
  for (const [, column] of TIMING_COLUMNS) {
    if (!columns.has(column)) {
      db.exec(`ALTER TABLE standalone_copy_generations ADD COLUMN ${column} INTEGER
        CHECK (${column} IS NULL OR ${column} BETWEEN 0 AND ${MAX_TIMING_DURATION_MS})`);
    }
  }
  for (const column of ['original_thinking', 'reviewed_thinking']) {
    if (!columns.has(column)) {
      db.exec(`ALTER TABLE standalone_copy_generations ADD COLUMN ${column} TEXT
        CHECK (${column} IS NULL OR ${column} IN ('minimal', 'low', 'medium', 'high', 'xhigh', 'max'))`);
    }
  }
  for (const column of ['manual_reviewed_at', 'manual_reviewed_by']) {
    if (!columns.has(column)) {
      db.exec(`ALTER TABLE standalone_copy_generations ADD COLUMN ${column} TEXT`);
    }
  }
  for (const column of ['batch_id', 'batch_name']) {
    if (!columns.has(column)) {
      db.exec(`ALTER TABLE standalone_copy_generations ADD COLUMN ${column} TEXT`);
    }
  }
  const jobColumns = new Set(
    db.prepare('PRAGMA table_info(standalone_copy_generation_jobs)').all()
      .map((column) => column.name),
  );
  if (!jobColumns.has('current_stage')) {
    db.exec(`ALTER TABLE standalone_copy_generation_jobs
      ADD COLUMN current_stage TEXT NOT NULL DEFAULT 'QUERY_REVIEW'
      CHECK (current_stage IN ('QUERY_REVIEW', 'RESEARCH', 'ORIGINAL_GENERATION', 'ORIGINAL_REVIEW', 'REVIEWED_GENERATION', 'REVIEWED_REVIEW'))`);
  }
  if (!jobColumns.has('stage_updated_at')) {
    db.exec('ALTER TABLE standalone_copy_generation_jobs ADD COLUMN stage_updated_at TEXT');
  }
  for (const column of ['batch_id', 'batch_name']) {
    if (!jobColumns.has(column)) {
      db.exec(`ALTER TABLE standalone_copy_generation_jobs ADD COLUMN ${column} TEXT`);
    }
  }
  db.exec(`UPDATE standalone_copy_generation_jobs
    SET stage_updated_at = COALESCE(stage_updated_at, created_at)`);
  db.exec(`
    CREATE INDEX IF NOT EXISTS standalone_copy_generations_batch_idx
      ON standalone_copy_generations(batch_id, id DESC);
    CREATE INDEX IF NOT EXISTS standalone_copy_generation_jobs_batch_idx
      ON standalone_copy_generation_jobs(batch_id, id DESC);
  `);
}

export function createStandaloneCopyGenerationStore(db) {
  return {
    createStandaloneCopyGenerationJob({ query: rawQuery, batch: rawBatch = null }) {
      const query = boundedText(rawQuery, 'copy generation job query', 500);
      const batch = normalizedBatch(rawBatch);
      assertCompatibleBatchName(db, batch);
      const createdAt = new Date().toISOString();
      const result = db.prepare(`
        INSERT INTO standalone_copy_generation_jobs
          (batch_id, batch_name, query, status, current_stage, stage_updated_at, created_at)
        VALUES (?, ?, ?, 'RUNNING', 'QUERY_REVIEW', ?, ?)
      `).run(batch?.id ?? null, batch?.name ?? null, query, createdAt, createdAt);
      return rowToStandaloneCopyGenerationJob(
        db.prepare('SELECT * FROM standalone_copy_generation_jobs WHERE id = ?')
          .get(Number(result.lastInsertRowid)),
      );
    },

    updateStandaloneCopyGenerationJobStage(rawJobId, rawStage) {
      const jobId = normalizedJobId(rawJobId);
      const stage = normalizedJobStage(rawStage);
      const stageUpdatedAt = new Date().toISOString();
      const result = db.prepare(`
        UPDATE standalone_copy_generation_jobs
        SET current_stage = ?, stage_updated_at = ?
        WHERE id = ? AND status = 'RUNNING'
      `).run(stage, stageUpdatedAt, jobId);
      if (Number(result.changes) !== 1) {
        throw new Error('running copy generation job not found');
      }
      return rowToStandaloneCopyGenerationJob(
        db.prepare('SELECT * FROM standalone_copy_generation_jobs WHERE id = ?').get(jobId),
      );
    },

    failStandaloneCopyGenerationJob(rawJobId, rawError) {
      const jobId = normalizedJobId(rawJobId);
      const error = redactedText(rawError, 'copy generation job error', MAX_JOB_ERROR_LENGTH);
      const finishedAt = new Date().toISOString();
      const result = db.prepare(`
        UPDATE standalone_copy_generation_jobs
        SET status = 'FAILED', error = ?, finished_at = ?
        WHERE id = ? AND status = 'RUNNING'
      `).run(error, finishedAt, jobId);
      if (Number(result.changes) !== 1) {
        throw new Error('running copy generation job not found');
      }
      return rowToStandaloneCopyGenerationJob(
        db.prepare('SELECT * FROM standalone_copy_generation_jobs WHERE id = ?').get(jobId),
      );
    },

    listStandaloneCopyGenerationJobs({ limit: rawLimit = 20, batchId: rawBatchId = null } = {}) {
      const limit = normalizedPaginationInteger(rawLimit, 20, MAX_JOB_LIST_SIZE);
      const batchId = normalizedBatchId(rawBatchId, { optional: true });
      return db.prepare(`
        SELECT * FROM standalone_copy_generation_jobs
        WHERE status != 'COMPLETED' AND (? IS NULL OR batch_id = ?)
        ORDER BY id DESC LIMIT ?
      `).all(batchId, batchId, limit).map(rowToStandaloneCopyGenerationJob);
    },

    saveStandaloneCopyGeneration({
      jobId: rawJobId = null,
      query: rawQuery,
      input = {},
      requestedImageCount = 'auto',
      originalPost,
      reviewedPost,
      originalModel: rawOriginalModel,
      reviewedModel: rawReviewedModel,
      originalThinking: rawOriginalThinking = null,
      reviewedThinking: rawReviewedThinking = null,
      researchSnapshot = null,
      stageReviews,
      timing: rawTiming,
      batch: rawBatch = null,
    }) {
      const query = boundedText(rawQuery, 'copy generation query', 500);
      const originalModel = boundedText(rawOriginalModel, 'original model', 200);
      const reviewedModel = boundedText(rawReviewedModel, 'reviewed model', 200);
      const originalThinking = normalizedThinking(rawOriginalThinking, 'original thinking');
      const reviewedThinking = normalizedThinking(rawReviewedThinking, 'reviewed thinking');
      if (!isRecord(stageReviews) || !isRecord(stageReviews.query)
        || !isRecord(stageReviews.originalText) || !isRecord(stageReviews.reviewedText)) {
        throw new TypeError('copy generation stage reviews are incomplete');
      }
      const timing = normalizedTiming(rawTiming);
      const requested = normalizedRequestedImageCount(requestedImageCount);
      const jobId = rawJobId === null ? null : normalizedJobId(rawJobId);
      const requestedBatch = normalizedBatch(rawBatch);
      const createdAt = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        let batch = requestedBatch;
        if (jobId !== null) {
          const job = db.prepare(`
            SELECT batch_id, batch_name FROM standalone_copy_generation_jobs
            WHERE id = ? AND status = 'RUNNING'
          `).get(jobId);
          if (!job) throw new Error('running copy generation job not found');
          batch = job.batch_id === null
            ? null
            : normalizedBatch({ id: job.batch_id, name: job.batch_name });
        }
        assertCompatibleBatchName(db, batch);
        const result = db.prepare(`
          INSERT INTO standalone_copy_generations
            (batch_id, batch_name, query, input_json, requested_image_count, original_post_json,
             reviewed_post_json, original_model, reviewed_model,
             original_thinking, reviewed_thinking, query_review_json,
             original_text_review_json, reviewed_text_review_json,
             research_snapshot_json, query_review_ms, research_ms,
             original_generation_ms, original_review_ms, reviewed_generation_ms,
             reviewed_review_ms, total_ms, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          batch?.id ?? null,
          batch?.name ?? null,
          query,
          redactedJson(input, 'copy generation input', MAX_INPUT_BYTES),
          requested,
          redactedJson(originalPost, 'original post', MAX_POST_BYTES),
          redactedJson(reviewedPost, 'reviewed post', MAX_POST_BYTES),
          originalModel,
          reviewedModel,
          originalThinking,
          reviewedThinking,
          redactedJson(stageReviews.query, 'query review', MAX_REVIEW_BYTES),
          redactedJson(stageReviews.originalText, 'original text review', MAX_REVIEW_BYTES),
          redactedJson(stageReviews.reviewedText, 'reviewed text review', MAX_REVIEW_BYTES),
          researchSnapshot === null
            ? null
            : redactedJson(researchSnapshot, 'research snapshot', MAX_RESEARCH_BYTES),
          timing.queryReviewMs,
          timing.researchMs,
          timing.originalGenerationMs,
          timing.originalReviewMs,
          timing.reviewedGenerationMs,
          timing.reviewedReviewMs,
          timing.totalMs,
          createdAt,
        );
        const id = Number(result.lastInsertRowid);
        if (jobId !== null) {
          const completed = db.prepare(`
            UPDATE standalone_copy_generation_jobs
            SET status = 'COMPLETED', generation_id = ?, finished_at = ?
            WHERE id = ? AND status = 'RUNNING'
          `).run(id, createdAt, jobId);
          if (Number(completed.changes) !== 1) {
            throw new Error('running copy generation job not found');
          }
        }
        const saved = rowToStandaloneCopyGeneration(
          db.prepare('SELECT * FROM standalone_copy_generations WHERE id = ?').get(id),
        );
        db.exec('COMMIT');
        return saved;
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },

    approveStandaloneCopyGeneration(rawGenerationId, { reviewedBy: rawReviewedBy }) {
      const generationId = normalizedGenerationId(rawGenerationId);
      const reviewedBy = boundedText(rawReviewedBy, 'manual reviewer', 80);
      const existing = db.prepare(`
        SELECT * FROM standalone_copy_generations WHERE id = ?
      `).get(generationId);
      if (!existing) return null;
      if (existing.manual_reviewed_at === null) {
        const reviewedAt = new Date().toISOString();
        db.prepare(`
          UPDATE standalone_copy_generations
          SET manual_reviewed_at = ?, manual_reviewed_by = ?
          WHERE id = ? AND manual_reviewed_at IS NULL
        `).run(reviewedAt, reviewedBy, generationId);
      }
      return rowToStandaloneCopyGeneration(
        db.prepare('SELECT * FROM standalone_copy_generations WHERE id = ?').get(generationId),
      );
    },

    listStandaloneCopyGenerations({
      page: rawPage = 1,
      pageSize: rawPageSize = 20,
      batchId: rawBatchId = null,
    } = {}) {
      const page = normalizedPaginationInteger(rawPage, 1, MAX_HISTORY_PAGE);
      const pageSize = normalizedPaginationInteger(rawPageSize, 20, 50);
      const batchId = normalizedBatchId(rawBatchId, { optional: true });
      const totalItems = Number(
        db.prepare(`
          SELECT COUNT(*) AS count FROM standalone_copy_generations
          WHERE (? IS NULL OR batch_id = ?)
        `).get(batchId, batchId).count,
      );
      const data = db.prepare(`
        SELECT * FROM standalone_copy_generations
        WHERE (? IS NULL OR batch_id = ?)
        ORDER BY id DESC LIMIT ? OFFSET ?
      `).all(batchId, batchId, pageSize, (page - 1) * pageSize)
        .map(rowToStandaloneCopyGeneration);
      return {
        data,
        statistics: timingStatistics(db),
        pagination: {
          page,
          pageSize,
          totalItems,
          totalPages: Math.ceil(totalItems / pageSize),
        },
      };
    },

    listStandaloneCopyGenerationBatches({ limit: rawLimit = 20 } = {}) {
      const limit = normalizedPaginationInteger(rawLimit, 20, MAX_BATCH_LIST_SIZE);
      return db.prepare(`
        WITH batch_entries AS (
          SELECT batch_id, batch_name, 'COMPLETED' AS status, created_at AS activity_at
          FROM standalone_copy_generations
          WHERE batch_id IS NOT NULL
          UNION ALL
          SELECT batch_id, batch_name, status,
                 COALESCE(finished_at, stage_updated_at, created_at) AS activity_at
          FROM standalone_copy_generation_jobs
          WHERE batch_id IS NOT NULL AND status != 'COMPLETED'
        )
        SELECT batch_id, MAX(batch_name) AS batch_name,
               COUNT(*) AS total_count,
               SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_count,
               SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed_count,
               SUM(CASE WHEN status = 'RUNNING' THEN 1 ELSE 0 END) AS running_count,
               MAX(activity_at) AS last_activity_at
        FROM batch_entries
        GROUP BY batch_id
        ORDER BY last_activity_at DESC, batch_id DESC
        LIMIT ?
      `).all(limit).map((row) => ({
        id: row.batch_id,
        name: row.batch_name,
        totalCount: Number(row.total_count),
        completedCount: Number(row.completed_count),
        failedCount: Number(row.failed_count),
        runningCount: Number(row.running_count),
        lastActivityAt: row.last_activity_at,
      }));
    },
  };
}
