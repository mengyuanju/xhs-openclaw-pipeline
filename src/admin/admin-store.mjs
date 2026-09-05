import { DatabaseSync } from 'node:sqlite';
import { isAbsolute, normalize } from 'node:path';

import { initializeQueueSchema } from '../queue.mjs';
import { DEFAULT_PROMPTS } from './default-prompts.mjs';
import { createGenerationStore, initializeGenerationSchema } from './generation-store.mjs';
import {
  createStandaloneCopyGenerationStore,
  initializeStandaloneCopyGenerationSchema,
} from './standalone-copy-generation-store.mjs';
import {
  createCopyKnowledgeStore,
  initializeCopyKnowledgeSchema,
} from './copy-knowledge-store.mjs';
import { createImageEditStore, initializeImageEditSchema } from './image-edit-store.mjs';
import {
  createVisualKnowledgeStore,
  initializeVisualKnowledgeSchema,
} from './visual-knowledge-store.mjs';
import {
  PROMPT_KINDS,
  hashPrompt,
  normalizePromptContent,
} from './prompt-service.mjs';
import { readTaskTimingStats } from './task-timing.mjs';
import { createReviewWorkStore, initializeReviewWorkSchema } from './review-work-store.mjs';
import {
  createProductionSettingsStore,
  initializeProductionSettingsSchema,
} from './production-settings-store.mjs';
import { createProductionStatisticsStore } from './production-statistics.mjs';

const REVIEW_STATUSES = ['NOT_READY', 'WAITING_REVIEW', 'APPROVED', 'REJECTED'];
const TASK_STATUSES = ['pending', 'processing', 'completed', 'failed'];
const IMPORT_STATUSES = ['PREVIEW', 'COMMITTED'];
const DEMAND_LEVELS = ['STRONG', 'MEDIUM', 'WEAK', 'NONE'];
const SCREENING_SOURCES = ['EXCEL', 'MANUAL', 'OPENCLAW', 'CODEX'];
const ASSET_ALIGNMENT_STATUSES = [
  'NOT_APPLICABLE',
  'UNVERIFIED',
  'PASSED',
  'FAILED',
  'STALE',
  'MANUAL_REQUIRED',
];

function nowIso() {
  return new Date().toISOString();
}

function requiredText(value, name, maxLength) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} cannot be empty`);
  const normalized = value.trim();
  if ([...normalized].length > maxLength) throw new RangeError(`${name} cannot exceed ${maxLength} characters`);
  return normalized;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  return JSON.parse(value);
}

function rowToPromptVersion(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    templateId: Number(row.template_id),
    version: Number(row.version),
    content: row.content,
    status: row.status,
    contentSha256: row.content_sha256,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}

function rowToTextRevision(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    taskId: Number(row.task_id),
    parentRevisionId: row.parent_revision_id === null ? null : Number(row.parent_revision_id),
    title: row.title,
    body: row.body,
    tags: parseJson(row.tags_json, []),
    source: row.source,
    createdAt: row.created_at,
  };
}

function rowToAsset(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    taskId: Number(row.task_id),
    kind: row.kind,
    parentAssetId: row.parent_asset_id === null ? null : Number(row.parent_asset_id),
    revision: Number(row.revision),
    fileName: row.file_name,
    relativePath: row.relative_path,
    mimeType: row.mime_type,
    width: Number(row.width),
    height: Number(row.height),
    sha256: row.sha256,
    source: row.source,
    sourceTextRevisionId: row.source_text_revision_id === null
      ? null
      : Number(row.source_text_revision_id),
    pageIndex: row.page_index === null ? null : Number(row.page_index),
    visualPlanSha256: row.visual_plan_sha256,
    alignmentStatus: row.alignment_status,
    alignmentResult: parseJson(row.alignment_result_json, {}),
    createdAt: row.created_at,
  };
}

function rowToAuditLog(row) {
  return {
    id: Number(row.id),
    entityType: row.entity_type,
    entityId: Number(row.entity_id),
    action: row.action,
    details: parseJson(row.details_json, {}),
    createdAt: row.created_at,
  };
}

function rowToImportRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    batchId: Number(row.batch_id),
    rowNumber: Number(row.row_number),
    externalId: row.external_id,
    query: row.query,
    input: parseJson(row.input_json, {}),
    imageCount: Number(row.image_count),
    referenceImageFiles: parseJson(row.reference_image_files_json, []),
    errors: parseJson(row.errors_json, []),
    isValid: Boolean(row.is_valid),
    screeningStatus: row.screening_status,
    demandLevel: row.demand_level,
    screeningReason: row.screening_reason,
    screeningSource: row.screening_source,
    screeningModel: row.screening_model,
    isAdmitted: row.is_admitted === null ? null : Boolean(row.is_admitted),
    taskId: row.task_id === null ? null : Number(row.task_id),
  };
}

function normalizePagination(page, pageSize) {
  return {
    page: Math.max(1, Math.floor(Number(page) || 1)),
    pageSize: Math.max(1, Math.min(100, Math.floor(Number(pageSize) || 20))),
  };
}

function paginationResult(data, { page, pageSize }, totalItems) {
  return {
    data,
    pagination: {
      page,
      pageSize,
      totalItems,
      totalPages: Math.ceil(totalItems / pageSize),
    },
  };
}

function escapeLike(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function visibleLength(value) {
  return [...new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(value)].length;
}

function normalizeTextRevision({ title: rawTitle, body: rawBody, tags: rawTags, source }) {
  const title = requiredText(rawTitle, 'title', 100);
  if (visibleLength(title) > 25) throw new RangeError('title cannot exceed 25 visible characters');
  const body = requiredText(rawBody, 'body', 20_000);
  if (!Array.isArray(rawTags) || rawTags.length > 20) throw new TypeError('tags must be an array of at most 20 items');
  const tags = rawTags.map((tag) => requiredText(tag, 'tag', 30));
  if (!['GENERATED', 'MANUAL'].includes(source)) throw new TypeError('text revision source is invalid');
  return { title, body, tags, source };
}

function assertSafeRelativePath(value) {
  const path = requiredText(value, 'relative path', 500).replaceAll('\\', '/');
  const normalized = normalize(path).replaceAll('\\', '/');
  if (isAbsolute(path) || normalized === '..' || normalized.startsWith('../')) {
    throw new TypeError('relative path escaped the asset root');
  }
  return path;
}

function migrateOpenClawScreeningSource(db) {
  const table = db.prepare(`
    SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'import_rows'
  `).get();
  if (!table?.sql || table.sql.includes("'CODEX'")) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      ALTER TABLE import_rows RENAME TO import_rows_before_openclaw;
      CREATE TABLE import_rows (
        id INTEGER PRIMARY KEY,
        batch_id INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
        row_number INTEGER NOT NULL,
        external_id TEXT,
        query TEXT NOT NULL,
        input_json TEXT NOT NULL,
        image_count INTEGER NOT NULL,
        reference_image_files_json TEXT NOT NULL,
        errors_json TEXT NOT NULL,
        is_valid INTEGER NOT NULL CHECK (is_valid IN (0, 1)),
        screening_status TEXT NOT NULL DEFAULT 'PENDING'
          CHECK (screening_status IN ('PENDING', 'COMPLETED', 'NOT_REQUIRED')),
        demand_level TEXT CHECK (demand_level IN ('STRONG', 'MEDIUM', 'WEAK', 'NONE')),
        screening_reason TEXT NOT NULL DEFAULT '',
        screening_source TEXT CHECK (screening_source IN ('EXCEL', 'MANUAL', 'OPENCLAW', 'CODEX')),
        screening_model TEXT,
        is_admitted INTEGER CHECK (is_admitted IN (0, 1)),
        task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
        UNIQUE(batch_id, row_number)
      ) STRICT;
      INSERT INTO import_rows
        (id, batch_id, row_number, external_id, query, input_json, image_count,
         reference_image_files_json, errors_json, is_valid, screening_status,
         demand_level, screening_reason, screening_source, screening_model,
         is_admitted, task_id)
      SELECT id, batch_id, row_number, external_id, query, input_json, image_count,
             reference_image_files_json, errors_json, is_valid, screening_status,
             demand_level, screening_reason, screening_source, screening_model,
             is_admitted, task_id
      FROM import_rows_before_openclaw;
      DROP TABLE import_rows_before_openclaw;
      CREATE INDEX import_rows_batch_valid_idx ON import_rows(batch_id, is_valid);
    `);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function initializeAdminSchema(db) {
  initializeQueueSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_templates (
      id INTEGER PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('TEXT_SYSTEM', 'IMAGE_SYSTEM', 'IMAGE_EDIT_SYSTEM')),
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS prompt_versions (
      id INTEGER PRIMARY KEY,
      template_id INTEGER NOT NULL REFERENCES prompt_templates(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL CHECK (version > 0),
      content TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
      content_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      published_at TEXT,
      UNIQUE(template_id, version)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS prompt_versions_template_status_idx
      ON prompt_versions(template_id, status);
    CREATE TABLE IF NOT EXISTS import_batches (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      source_file_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('PREVIEW', 'COMMITTED')),
      total_rows INTEGER NOT NULL,
      valid_rows INTEGER NOT NULL,
      invalid_rows INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      committed_at TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS import_rows (
      id INTEGER PRIMARY KEY,
      batch_id INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
      row_number INTEGER NOT NULL,
      external_id TEXT,
      query TEXT NOT NULL,
      input_json TEXT NOT NULL,
      image_count INTEGER NOT NULL,
      reference_image_files_json TEXT NOT NULL,
      errors_json TEXT NOT NULL,
      is_valid INTEGER NOT NULL CHECK (is_valid IN (0, 1)),
      screening_status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (screening_status IN ('PENDING', 'COMPLETED', 'NOT_REQUIRED')),
      demand_level TEXT CHECK (demand_level IN ('STRONG', 'MEDIUM', 'WEAK', 'NONE')),
      screening_reason TEXT NOT NULL DEFAULT '',
      screening_source TEXT CHECK (screening_source IN ('EXCEL', 'MANUAL', 'OPENCLAW', 'CODEX')),
      screening_model TEXT,
      is_admitted INTEGER CHECK (is_admitted IN (0, 1)),
      task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      UNIQUE(batch_id, row_number)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS import_rows_batch_valid_idx ON import_rows(batch_id, is_valid);
    CREATE TABLE IF NOT EXISTS text_revisions (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      parent_revision_id INTEGER REFERENCES text_revisions(id) ON DELETE RESTRICT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('GENERATED', 'MANUAL')),
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS text_revisions_task_idx ON text_revisions(task_id, id DESC);
    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('REFERENCE', 'GENERATED', 'EDITED')),
      parent_asset_id INTEGER REFERENCES assets(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK (revision > 0),
      file_name TEXT NOT NULL,
      relative_path TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      width INTEGER NOT NULL CHECK (width > 0),
      height INTEGER NOT NULL CHECK (height > 0),
      sha256 TEXT NOT NULL,
      source TEXT NOT NULL,
      source_text_revision_id INTEGER REFERENCES text_revisions(id) ON DELETE SET NULL,
      page_index INTEGER CHECK (page_index BETWEEN 1 AND 5),
      visual_plan_sha256 TEXT,
      alignment_status TEXT NOT NULL DEFAULT 'UNVERIFIED'
        CHECK (alignment_status IN ('NOT_APPLICABLE', 'UNVERIFIED', 'PASSED', 'FAILED', 'STALE', 'MANUAL_REQUIRED')),
      alignment_result_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS assets_task_idx ON assets(task_id, id DESC);
    CREATE TABLE IF NOT EXISTS task_configs (
      task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
      external_id TEXT,
      text_prompt_version_id INTEGER NOT NULL REFERENCES prompt_versions(id),
      text_prompt_content TEXT NOT NULL,
      text_prompt_sha256 TEXT NOT NULL,
      image_prompt_version_id INTEGER NOT NULL REFERENCES prompt_versions(id),
      image_prompt_content TEXT NOT NULL,
      image_prompt_sha256 TEXT NOT NULL,
      image_edit_prompt_version_id INTEGER NOT NULL REFERENCES prompt_versions(id),
      image_edit_prompt_content TEXT NOT NULL,
      image_edit_prompt_sha256 TEXT NOT NULL,
      image_count INTEGER NOT NULL CHECK (image_count BETWEEN 3 AND 5),
      reference_asset_ids_json TEXT NOT NULL DEFAULT '[]',
      current_text_revision_id INTEGER REFERENCES text_revisions(id) ON DELETE SET NULL,
      review_status TEXT NOT NULL DEFAULT 'NOT_READY'
        CHECK (review_status IN ('NOT_READY', 'WAITING_REVIEW', 'APPROVED', 'REJECTED')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS task_configs_review_idx ON task_configs(review_status, task_id);
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('WAITING_REVIEW', 'APPROVED', 'REJECTED')),
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS reviews_task_idx ON reviews(task_id, id DESC);
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    ) STRICT;
  `);
  initializeImageEditSchema(db);
  initializeGenerationSchema(db);
  initializeStandaloneCopyGenerationSchema(db);
  initializeCopyKnowledgeSchema(db);
  initializeVisualKnowledgeSchema(db);
  initializeProductionSettingsSchema(db);
  initializeReviewWorkSchema(db);
  const assetColumns = new Set(
    db.prepare('PRAGMA table_info(assets)').all().map((column) => column.name),
  );
  const provenanceColumns = [
    ['source_text_revision_id', 'INTEGER REFERENCES text_revisions(id) ON DELETE SET NULL'],
    ['page_index', 'INTEGER CHECK (page_index BETWEEN 1 AND 5)'],
    ['visual_plan_sha256', 'TEXT'],
    ['alignment_status', "TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (alignment_status IN ('NOT_APPLICABLE', 'UNVERIFIED', 'PASSED', 'FAILED', 'STALE', 'MANUAL_REQUIRED'))"],
    ['alignment_result_json', "TEXT NOT NULL DEFAULT '{}'"],
  ];
  for (const [name, definition] of provenanceColumns) {
    if (!assetColumns.has(name)) db.exec(`ALTER TABLE assets ADD COLUMN ${name} ${definition}`);
  }
  const importRowColumns = new Set(
    db.prepare('PRAGMA table_info(import_rows)').all().map((column) => column.name),
  );
  const screeningColumns = [
    ['screening_status', "TEXT NOT NULL DEFAULT 'PENDING' CHECK (screening_status IN ('PENDING', 'COMPLETED', 'NOT_REQUIRED'))"],
    ['demand_level', "TEXT CHECK (demand_level IN ('STRONG', 'MEDIUM', 'WEAK', 'NONE'))"],
    ['screening_reason', "TEXT NOT NULL DEFAULT ''"],
    ['screening_source', "TEXT CHECK (screening_source IN ('EXCEL', 'MANUAL', 'OPENCLAW', 'CODEX'))"],
    ['screening_model', 'TEXT'],
    ['is_admitted', 'INTEGER CHECK (is_admitted IN (0, 1))'],
  ];
  for (const [name, definition] of screeningColumns) {
    if (!importRowColumns.has(name)) db.exec(`ALTER TABLE import_rows ADD COLUMN ${name} ${definition}`);
  }
  migrateOpenClawScreeningSource(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS import_rows_batch_screening_idx
      ON import_rows(batch_id, is_valid, screening_status, is_admitted);
    UPDATE import_rows
    SET screening_status = 'COMPLETED',
        screening_reason = '历史批次未记录需求档位',
        screening_source = 'MANUAL',
        is_admitted = CASE WHEN task_id IS NULL THEN 0 ELSE 1 END
    WHERE is_valid = 1
      AND screening_status = 'PENDING'
      AND batch_id IN (SELECT id FROM import_batches WHERE status = 'COMMITTED');
  `);
}

function seedPrompts(db) {
  const insertTemplate = db.prepare(`
    INSERT OR IGNORE INTO prompt_templates (slug, name, kind, created_at) VALUES (?, ?, ?, ?)
  `);
  const findTemplate = db.prepare('SELECT id FROM prompt_templates WHERE slug = ?');
  const countVersions = db.prepare('SELECT COUNT(*) AS count FROM prompt_versions WHERE template_id = ?');
  const insertVersion = db.prepare(`
    INSERT INTO prompt_versions
      (template_id, version, content, status, content_sha256, created_at, published_at)
    VALUES (?, 1, ?, 'PUBLISHED', ?, ?, ?)
  `);
  for (const prompt of DEFAULT_PROMPTS) {
    const createdAt = nowIso();
    insertTemplate.run(prompt.slug, prompt.name, prompt.kind, createdAt);
    const templateId = findTemplate.get(prompt.slug).id;
    if (Number(countVersions.get(templateId).count) === 0) {
      const content = normalizePromptContent(prompt.content);
      insertVersion.run(templateId, content, hashPrompt(content), createdAt, createdAt);
    }
  }
}

function publishedPromptMap(db) {
  const rows = db.prepare(`
    SELECT pv.*, pt.kind
    FROM prompt_versions pv
    JOIN prompt_templates pt ON pt.id = pv.template_id
    WHERE pv.status = 'PUBLISHED'
  `).all();
  const byKind = new Map(rows.map((row) => [row.kind, row]));
  for (const kind of PROMPT_KINDS) {
    if (!byKind.has(kind)) throw new Error(`published prompt missing for ${kind}`);
  }
  return byKind;
}

function batchSummary(db, id, prefetchedStatistics = null) {
  const row = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(id);
  if (!row) return null;
  const screening = db.prepare(`
    SELECT
      SUM(CASE WHEN is_valid = 1 AND screening_status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN is_valid = 1 AND screening_status = 'COMPLETED' THEN 1 ELSE 0 END) AS screened,
      SUM(CASE WHEN is_valid = 1 AND is_admitted = 1 THEN 1 ELSE 0 END) AS admitted,
      SUM(CASE WHEN is_valid = 1 AND is_admitted = 0 THEN 1 ELSE 0 END) AS discarded,
      SUM(CASE WHEN is_valid = 1 AND demand_level = 'STRONG' THEN 1 ELSE 0 END) AS strong,
      SUM(CASE WHEN is_valid = 1 AND demand_level = 'MEDIUM' THEN 1 ELSE 0 END) AS medium,
      SUM(CASE WHEN is_valid = 1 AND demand_level = 'WEAK' THEN 1 ELSE 0 END) AS weak,
      SUM(CASE WHEN is_valid = 1 AND demand_level = 'NONE' THEN 1 ELSE 0 END) AS none
    FROM import_rows WHERE batch_id = ?
  `).get(id);
  const pendingScreeningRows = Number(screening.pending);
  return {
    id: Number(row.id),
    name: row.name,
    sourceFileName: row.source_file_name,
    status: row.status,
    totalRows: Number(row.total_rows),
    validRows: Number(row.valid_rows),
    invalidRows: Number(row.invalid_rows),
    screenedRows: Number(screening.screened),
    pendingScreeningRows,
    admittedRows: Number(screening.admitted),
    discardedRows: Number(screening.discarded),
    demandCounts: {
      STRONG: Number(screening.strong),
      MEDIUM: Number(screening.medium),
      WEAK: Number(screening.weak),
      NONE: Number(screening.none),
    },
    screeningComplete: pendingScreeningRows === 0,
    createdAt: row.created_at,
    committedAt: row.committed_at,
    statistics: prefetchedStatistics ?? createProductionStatisticsStore(db).getImportBatchStatistics(id),
  };
}

function normalizeDemandDecision({ demandLevel: rawDemandLevel, reason: rawReason }, source = 'MANUAL') {
  const demandLevel = String(rawDemandLevel ?? '').trim().toUpperCase();
  if (!DEMAND_LEVELS.includes(demandLevel)) throw new TypeError('demand level is invalid');
  if (!SCREENING_SOURCES.includes(source)) throw new TypeError('screening source is invalid');
  const reason = requiredText(rawReason, 'screening reason', 500);
  const isAdmitted = demandLevel === 'STRONG' || demandLevel === 'MEDIUM';
  return { demandLevel, reason, source, isAdmitted };
}

function rowToAdminTask(row) {
  if (!row) return null;
  return {
    id: Number(row.task_id),
    query: row.query,
    input: parseJson(row.input_json, {}),
    status: row.task_status,
    attempts: Number(row.attempts),
    recoveryAttempts: Number(row.recovery_attempts),
    recoveryTotalAttempts: Number(row.recovery_total_attempts),
    recoveryClass: row.recovery_class,
    nextAttemptAt: row.next_attempt_at,
    manualRequired: row.manual_required === 1,
    outputDir: row.output_dir,
    error: row.error,
    processingStartedAt: row.processing_started_at,
    finishedAt: row.finished_at,
    queuePosition: row.task_status === 'pending' && row.queue_position !== undefined
      ? Number(row.queue_position)
      : null,
    createdAt: row.task_created_at,
    updatedAt: row.task_updated_at,
    ...(row.export_asset_count === undefined ? {} : {
      exportReadiness: {
        assetCount: Number(row.export_asset_count),
        alignedAssetCount: Number(row.export_aligned_asset_count),
      },
    }),
    config: row.text_prompt_version_id ? {
      importBatchId: row.import_batch_id === null ? null : Number(row.import_batch_id),
      externalId: row.external_id,
      imageCount: Number(row.image_count),
      reviewStatus: row.review_status,
      currentTextRevisionId: row.current_text_revision_id === null
        ? null
        : Number(row.current_text_revision_id),
      textPromptVersionId: Number(row.text_prompt_version_id),
      textPromptSha256: row.text_prompt_sha256,
      imagePromptVersionId: Number(row.image_prompt_version_id),
      imagePromptSha256: row.image_prompt_sha256,
      imageEditPromptVersionId: Number(row.image_edit_prompt_version_id),
    } : null,
  };
}

export function createAdminStore(databasePath) {
  const db = new DatabaseSync(databasePath, { timeout: 5_000 });
  initializeAdminSchema(db);
  seedPrompts(db);

  const getPromptVersionRow = db.prepare('SELECT * FROM prompt_versions WHERE id = ?');
  const imageEditStore = createImageEditStore(db);
  const generationStore = createGenerationStore(db);
  const standaloneCopyGenerationStore = createStandaloneCopyGenerationStore(db);
  const copyKnowledgeStore = createCopyKnowledgeStore(db);
  const visualKnowledgeStore = createVisualKnowledgeStore(db);
  const productionSettingsStore = createProductionSettingsStore(db);
  const productionStatisticsStore = createProductionStatisticsStore(db);
  const reviewWorkStore = createReviewWorkStore(db);
  const countTasks = () => Number(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count);
  const getAssetRow = db.prepare('SELECT * FROM assets WHERE id = ?');
  const getTaskRow = db.prepare(`
    SELECT t.*, tc.*,
           t.id AS task_id, t.status AS task_status, t.created_at AS task_created_at,
           t.updated_at AS task_updated_at,
           (SELECT COUNT(*) + 1 FROM tasks queued
            WHERE queued.status = 'pending' AND queued.id < t.id) AS queue_position
    FROM tasks t
    LEFT JOIN task_configs tc ON tc.task_id = t.id
    WHERE t.id = ?
  `);
  const insertAudit = db.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, action, details_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const getTaskDetail = (id) => {
    const row = getTaskRow.get(id);
    const task = rowToAdminTask(row);
    if (!task) return null;
    const textRevisions = db.prepare(`
      SELECT * FROM text_revisions WHERE task_id = ? ORDER BY id
    `).all(id).map(rowToTextRevision);
    const assets = db.prepare('SELECT * FROM assets WHERE task_id = ? ORDER BY id').all(id).map(rowToAsset);
    const reviews = db.prepare('SELECT * FROM reviews WHERE task_id = ? ORDER BY id').all(id).map((row) => ({
      id: Number(row.id),
      taskId: Number(row.task_id),
      status: row.status,
      note: row.note,
      createdAt: row.created_at,
    }));
    const auditLogs = db.prepare(`
      SELECT * FROM audit_logs WHERE entity_type = 'task' AND entity_id = ? ORDER BY id
    `).all(id).map(rowToAuditLog);
    return {
      ...task,
      config: task.config,
      textRevisions,
      currentTextRevision: textRevisions.find(
        (revision) => revision.id === task.config?.currentTextRevisionId,
      ) ?? null,
      assets,
      reviews,
      imageEditRequests: imageEditStore.listForTask(id),
      generationRuns: generationStore.listGenerationRuns(id),
      visualReference: visualKnowledgeStore.getTaskVisualReference(id),
      auditLogs,
    };
  };

  return {
    ...imageEditStore,
    ...generationStore,
    ...standaloneCopyGenerationStore,
    ...copyKnowledgeStore,
    ...visualKnowledgeStore,
    ...productionSettingsStore,
    ...productionStatisticsStore,
    ...reviewWorkStore,
    close() {
      db.close();
    },

    listPromptTemplates() {
      const templates = db.prepare('SELECT * FROM prompt_templates ORDER BY id').all().map((row) => ({
        id: Number(row.id),
        slug: row.slug,
        name: row.name,
        kind: row.kind,
        createdAt: row.created_at,
        versions: [],
      }));
      const byId = new Map(templates.map((template) => [template.id, template]));
      for (const row of db.prepare('SELECT * FROM prompt_versions ORDER BY template_id, version DESC').all()) {
        byId.get(Number(row.template_id))?.versions.push(rowToPromptVersion(row));
      }
      return templates;
    },

    getPromptVersion(id) {
      return rowToPromptVersion(getPromptVersionRow.get(id));
    },

    createPromptVersion({ templateId, content: rawContent }) {
      const template = db.prepare('SELECT id FROM prompt_templates WHERE id = ?').get(templateId);
      if (!template) throw new Error('prompt template not found');
      const content = normalizePromptContent(rawContent);
      const next = Number(db.prepare(`
        SELECT COALESCE(MAX(version), 0) + 1 AS version FROM prompt_versions WHERE template_id = ?
      `).get(templateId).version);
      const createdAt = nowIso();
      const result = db.prepare(`
        INSERT INTO prompt_versions
          (template_id, version, content, status, content_sha256, created_at)
        VALUES (?, ?, ?, 'DRAFT', ?, ?)
      `).run(templateId, next, content, hashPrompt(content), createdAt);
      return rowToPromptVersion(getPromptVersionRow.get(result.lastInsertRowid));
    },

    updatePromptVersion(id, { content: rawContent }) {
      const current = getPromptVersionRow.get(id);
      if (!current) throw new Error('prompt version not found');
      if (current.status !== 'DRAFT') throw new Error('published prompt versions are immutable');
      const content = normalizePromptContent(rawContent);
      db.prepare('UPDATE prompt_versions SET content = ?, content_sha256 = ? WHERE id = ?')
        .run(content, hashPrompt(content), id);
      return rowToPromptVersion(getPromptVersionRow.get(id));
    },

    publishPromptVersion(id) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = getPromptVersionRow.get(id);
        if (!current) throw new Error('prompt version not found');
        if (current.status !== 'PUBLISHED') {
          db.prepare(`
            UPDATE prompt_versions SET status = 'RETIRED'
            WHERE template_id = ? AND status = 'PUBLISHED'
          `).run(current.template_id);
          db.prepare(`
            UPDATE prompt_versions SET status = 'PUBLISHED', published_at = ? WHERE id = ?
          `).run(nowIso(), id);
          db.prepare(`
            INSERT INTO audit_logs (entity_type, entity_id, action, details_json, created_at)
            VALUES ('prompt_version', ?, 'PUBLISH', '{}', ?)
          `).run(id, nowIso());
        }
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
      return rowToPromptVersion(getPromptVersionRow.get(id));
    },

    createImportBatch({ name: rawName, sourceFileName: rawSourceFileName, rows }) {
      const name = requiredText(rawName, 'batch name', 200);
      const sourceFileName = requiredText(rawSourceFileName, 'source file name', 255);
      if (!Array.isArray(rows) || rows.length === 0 || rows.length > 5_000) {
        throw new RangeError('rows must contain between 1 and 5000 items');
      }
      const validRows = rows.filter((row) => Array.isArray(row.errors) && row.errors.length === 0).length;
      const createdAt = nowIso();
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = db.prepare(`
          INSERT INTO import_batches
            (name, source_file_name, status, total_rows, valid_rows, invalid_rows, created_at)
          VALUES (?, ?, 'PREVIEW', ?, ?, ?, ?)
        `).run(name, sourceFileName, rows.length, validRows, rows.length - validRows, createdAt);
        const batchId = Number(result.lastInsertRowid);
        const insertRow = db.prepare(`
          INSERT INTO import_rows
            (batch_id, row_number, external_id, query, input_json, image_count,
             reference_image_files_json, errors_json, is_valid, screening_status,
             demand_level, screening_reason, screening_source, screening_model, is_admitted)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of rows) {
          const errors = Array.isArray(row.errors) ? row.errors.map(String) : ['row errors are missing'];
          const structurallyValid = errors.length === 0;
          const decision = structurallyValid && row.screening
            ? normalizeDemandDecision(row.screening, row.screening.source ?? 'EXCEL')
            : null;
          const screeningModel = ['OPENCLAW', 'CODEX'].includes(decision?.source)
            ? requiredText(row.screening.model, 'screening model', 200)
            : null;
          if (decision && row.screening.admitted !== decision.isAdmitted) {
            throw new TypeError('screening admitted value conflicts with demand level');
          }
          const input = { ...(row.input ?? {}) };
          if (decision) {
            input.taskJudgement = {
              admitted: decision.isAdmitted,
              demandLevel: decision.demandLevel.toLowerCase(),
              reason: decision.reason,
            };
          }
          insertRow.run(
            batchId,
            Number(row.rowNumber),
            row.externalId || null,
            typeof row.query === 'string' ? row.query : '',
            JSON.stringify(input),
            Number(row.imageCount) || 3,
            JSON.stringify(row.referenceImageFiles ?? []),
            JSON.stringify(errors),
            structurallyValid ? 1 : 0,
            structurallyValid ? (decision ? 'COMPLETED' : 'PENDING') : 'NOT_REQUIRED',
            decision?.demandLevel ?? null,
            decision?.reason ?? '',
            decision?.source ?? null,
            screeningModel,
            decision ? Number(decision.isAdmitted) : null,
          );
        }
        db.exec('COMMIT');
        return batchSummary(db, batchId);
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },

    listImportBatches({ page = 1, pageSize = 20, status } = {}) {
      const pagination = normalizePagination(page, pageSize);
      const clauses = [];
      const parameters = [];
      if (status !== undefined && status !== '') {
        if (!IMPORT_STATUSES.includes(status)) throw new TypeError('import status is invalid');
        clauses.push('status = ?');
        parameters.push(status);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const totalItems = Number(db.prepare(`
        SELECT COUNT(*) AS count FROM import_batches ${where}
      `).get(...parameters).count);
      const rows = db.prepare(`
        SELECT id FROM import_batches ${where}
        ORDER BY id DESC LIMIT ? OFFSET ?
      `).all(
        ...parameters,
        pagination.pageSize,
        (pagination.page - 1) * pagination.pageSize,
      );
      const batchIds = rows.map((row) => Number(row.id));
      const statisticsByBatchId = productionStatisticsStore.getImportBatchStatisticsMap(batchIds);
      return paginationResult(
        rows.map((row) => batchSummary(
          db,
          row.id,
          statisticsByBatchId.get(Number(row.id)),
        )),
        pagination,
        totalItems,
      );
    },

    getImportBatch(id) {
      const batch = batchSummary(db, id);
      if (!batch) return null;
      return {
        ...batch,
        rows: db.prepare(`
          SELECT * FROM import_rows WHERE batch_id = ? ORDER BY row_number, id
        `).all(id).map(rowToImportRow),
      };
    },

    screenImportBatch(batchId, { decisions }) {
      if (!Array.isArray(decisions) || decisions.length < 1 || decisions.length > 5_000) {
        throw new RangeError('screening decisions must contain between 1 and 5000 items');
      }
      const normalized = decisions.map((decision) => ({
        rowId: Number(decision.rowId),
        ...normalizeDemandDecision(decision),
      }));
      if (normalized.some((decision) => !Number.isInteger(decision.rowId) || decision.rowId < 1)) {
        throw new TypeError('screening row id is invalid');
      }
      if (new Set(normalized.map((decision) => decision.rowId)).size !== normalized.length) {
        throw new TypeError('screening row ids must be unique');
      }

      db.exec('BEGIN IMMEDIATE');
      try {
        const batch = db.prepare('SELECT status FROM import_batches WHERE id = ?').get(batchId);
        if (!batch) throw new Error('import batch not found');
        const getRow = db.prepare(`
          SELECT id, input_json, task_id FROM import_rows
          WHERE id = ? AND batch_id = ? AND is_valid = 1
        `);
        const updateRow = db.prepare(`
          UPDATE import_rows
          SET input_json = ?, screening_status = 'COMPLETED', demand_level = ?,
              screening_reason = ?, screening_source = 'MANUAL', screening_model = NULL,
              is_admitted = ?
          WHERE id = ? AND batch_id = ? AND is_valid = 1
        `);
        for (const decision of normalized) {
          const row = getRow.get(decision.rowId, batchId);
          if (!row) throw new TypeError(`screening row ${decision.rowId} is not a valid row in this batch`);
          if (batch.status === 'COMMITTED' && row.task_id !== null) {
            throw new TypeError('committed import rows with tasks cannot be screened');
          }
          const input = parseJson(row.input_json, {});
          input.taskJudgement = {
            admitted: decision.isAdmitted,
            demandLevel: decision.demandLevel.toLowerCase(),
            reason: decision.reason,
          };
          updateRow.run(
            JSON.stringify(input),
            decision.demandLevel,
            decision.reason,
            Number(decision.isAdmitted),
            decision.rowId,
            batchId,
          );
        }
        insertAudit.run(
          'import_batch',
          batchId,
          'SCREEN_QUERY_DEMAND',
          JSON.stringify({ updatedRows: normalized.length }),
          nowIso(),
        );
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
      return batchSummary(db, batchId);
    },

    commitImportBatch(batchId) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const batch = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId);
        if (!batch) throw new Error('import batch not found');
        const wasAlreadyCommitted = batch.status === 'COMMITTED';
        const pendingScreeningRows = Number(db.prepare(`
          SELECT COUNT(*) AS count FROM import_rows
          WHERE batch_id = ? AND is_valid = 1 AND screening_status != 'COMPLETED'
        `).get(batchId).count);
        if (pendingScreeningRows > 0) throw new TypeError('demand screening must be complete before commit');
        const rows = db.prepare(`
          SELECT * FROM import_rows
          WHERE batch_id = ? AND is_valid = 1 AND is_admitted = 1 AND task_id IS NULL
          ORDER BY row_number
        `).all(batchId);
        const createdAt = nowIso();
        if (rows.length > 0) {
          const prompts = publishedPromptMap(db);
          const insertTask = db.prepare(`
            INSERT INTO tasks (query, input_json, status, created_at, updated_at)
            VALUES (?, ?, 'pending', ?, ?)
          `);
          const insertConfig = db.prepare(`
            INSERT INTO task_configs
              (task_id, import_batch_id, external_id,
               text_prompt_version_id, text_prompt_content, text_prompt_sha256,
               image_prompt_version_id, image_prompt_content, image_prompt_sha256,
               image_edit_prompt_version_id, image_edit_prompt_content, image_edit_prompt_sha256,
               image_count, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          const setTaskId = db.prepare('UPDATE import_rows SET task_id = ? WHERE id = ?');
          const textPrompt = prompts.get('TEXT_SYSTEM');
          const imagePrompt = prompts.get('IMAGE_SYSTEM');
          const editPrompt = prompts.get('IMAGE_EDIT_SYSTEM');
          for (const row of rows) {
            const taskId = Number(insertTask.run(row.query, row.input_json, createdAt, createdAt).lastInsertRowid);
            insertConfig.run(
              taskId,
              batchId,
              row.external_id,
              textPrompt.id,
              textPrompt.content,
              textPrompt.content_sha256,
              imagePrompt.id,
              imagePrompt.content,
              imagePrompt.content_sha256,
              editPrompt.id,
              editPrompt.content,
              editPrompt.content_sha256,
              row.image_count,
              createdAt,
              createdAt,
            );
            setTaskId.run(taskId, row.id);
          }
        }
        if (!wasAlreadyCommitted) {
          db.prepare(`
            UPDATE import_batches SET status = 'COMMITTED', committed_at = ? WHERE id = ?
          `).run(createdAt, batchId);
        }
        const createdTasks = Number(db.prepare(`
          SELECT COUNT(*) AS count FROM import_rows WHERE batch_id = ? AND task_id IS NOT NULL
        `).get(batchId).count);
        db.exec('COMMIT');
        return {
          batch: batchSummary(db, batchId),
          createdTasks,
          wasAlreadyCommitted,
        };
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },

    getTask(id) {
      return getTaskDetail(id);
    },

    retryTask(id) {
      const updatedAt = nowIso();
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = db.prepare(`
          UPDATE tasks
          SET status = 'pending', error = NULL, output_dir = NULL,
              lease_owner = NULL, lease_until = NULL,
              recovery_attempts = 0, recovery_total_attempts = 0,
              recovery_class = NULL, next_attempt_at = NULL, manual_required = 0,
              processing_started_at = NULL, finished_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'failed'
        `).run(updatedAt, id);
        if (Number(result.changes) !== 1) throw new Error('only failed tasks can be retried');
        db.prepare(`
          UPDATE task_configs SET review_status = 'NOT_READY', updated_at = ? WHERE task_id = ?
        `).run(updatedAt, id);
        insertAudit.run('task', id, 'TASK_RETRY', '{}', updatedAt);
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
      return getTaskDetail(id);
    },

    getWorkerConfig(taskId) {
      const row = db.prepare(`
        SELECT t.query, t.input_json, tc.*
        FROM tasks t JOIN task_configs tc ON tc.task_id = t.id
        WHERE t.id = ?
      `).get(taskId);
      if (!row) return null;
      const referenceAssets = db.prepare(`
        SELECT * FROM assets WHERE task_id = ? AND kind = 'REFERENCE' ORDER BY id
      `).all(taskId).map(rowToAsset);
      return {
        taskId: Number(taskId),
        query: row.query,
        input: parseJson(row.input_json, {}),
        imageCount: Number(row.image_count),
        textPromptContent: row.text_prompt_content,
        imagePromptContent: row.image_prompt_content,
        imageEditPromptContent: row.image_edit_prompt_content,
        productionSettings: productionSettingsStore.getProductionSettings().settings,
        referenceAssets,
      };
    },

    setTaskImageCount(taskId, imageCount) {
      if (!Number.isInteger(imageCount) || imageCount < 3 || imageCount > 5) {
        throw new RangeError('image count must be an integer between 3 and 5');
      }
      const previous = db.prepare('SELECT image_count FROM task_configs WHERE task_id = ?').get(taskId);
      if (!previous) throw new Error('task config not found');
      const updatedAt = nowIso();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`
          UPDATE task_configs SET image_count = ?, updated_at = ? WHERE task_id = ?
        `).run(imageCount, updatedAt, taskId);
        insertAudit.run(
          'task',
          taskId,
          'TASK_IMAGE_COUNT_SELECT',
          JSON.stringify({ previousImageCount: Number(previous.image_count), imageCount }),
          updatedAt,
        );
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
      return imageCount;
    },

    addTextRevision(taskId, input) {
      const task = getTaskRow.get(taskId);
      if (!task?.text_prompt_version_id) throw new Error('task configuration not found');
      const revision = normalizeTextRevision(input);
      if (revision.source === 'MANUAL' && task.task_status === 'processing') {
        throw new Error('text cannot be edited while generation is processing');
      }
      const createdAt = nowIso();
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = db.prepare(`
          INSERT INTO text_revisions
            (task_id, parent_revision_id, title, body, tags_json, source, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          taskId,
          task.current_text_revision_id,
          revision.title,
          revision.body,
          JSON.stringify(revision.tags),
          revision.source,
          createdAt,
        );
        const revisionId = Number(result.lastInsertRowid);
        db.prepare(`
          UPDATE task_configs
          SET current_text_revision_id = ?, review_status = 'WAITING_REVIEW', updated_at = ?
          WHERE task_id = ?
        `).run(revisionId, createdAt, taskId);
        db.prepare(`
          UPDATE assets
          SET alignment_status = 'STALE'
          WHERE task_id = ? AND kind != 'REFERENCE'
            AND source_text_revision_id IS NOT NULL AND source_text_revision_id != ?
            AND alignment_status != 'STALE'
        `).run(taskId, revisionId);
        if (revision.source === 'MANUAL') {
          db.prepare(`
            UPDATE tasks
            SET status = 'pending', error = NULL, output_dir = NULL,
                lease_owner = NULL, lease_until = NULL,
                processing_started_at = NULL, finished_at = NULL, updated_at = ?
            WHERE id = ? AND status IN ('completed', 'failed')
          `).run(createdAt, taskId);
        }
        insertAudit.run(
          'task',
          taskId,
          'TEXT_REVISION_CREATE',
          JSON.stringify({ revisionId, source: revision.source }),
          createdAt,
        );
        db.exec('COMMIT');
        return rowToTextRevision(db.prepare('SELECT * FROM text_revisions WHERE id = ?').get(revisionId));
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },

    getAsset(id) {
      return rowToAsset(getAssetRow.get(id));
    },

    deleteAssetsForRetention(taskId, assetIds) {
      if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('task id is invalid');
      if (!Array.isArray(assetIds) || assetIds.length < 1 || assetIds.length > 1_000) {
        throw new RangeError('asset ids must contain between 1 and 1000 items');
      }
      const ids = [...new Set(assetIds)];
      if (ids.length !== assetIds.length
        || ids.some((id) => !Number.isInteger(id) || id < 1)) {
        throw new TypeError('asset ids must be unique positive integers');
      }
      const placeholders = ids.map(() => '?').join(', ');
      const rows = db.prepare(`
        SELECT * FROM assets
        WHERE task_id = ? AND id IN (${placeholders})
        ORDER BY id DESC
      `).all(taskId, ...ids);
      if (rows.length !== ids.length) throw new Error('retention asset was not found for task');
      if (rows.some((row) => row.kind !== 'GENERATED')) {
        throw new Error('retention cleanup can delete only generated assets');
      }
      const child = db.prepare(`
        SELECT id FROM assets WHERE parent_asset_id IN (${placeholders}) LIMIT 1
      `).get(...ids);
      if (child) throw new Error('retention asset is still referenced by an edited asset');
      const createdAt = nowIso();
      db.exec('BEGIN IMMEDIATE');
      try {
        const deletion = db.prepare(`
          DELETE FROM assets WHERE task_id = ? AND id IN (${placeholders})
        `).run(taskId, ...ids);
        if (Number(deletion.changes) !== ids.length) {
          throw new Error('retention asset deletion was incomplete');
        }
        insertAudit.run(
          'task',
          taskId,
          'STORAGE_RETENTION_CLEANUP',
          JSON.stringify({ assetIds: ids }),
          createdAt,
        );
        db.exec('COMMIT');
        return rows.map(rowToAsset);
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },

    addAsset({
      taskId,
      kind,
      parentAssetId = null,
      fileName: rawFileName,
      relativePath: rawRelativePath,
      mimeType,
      width,
      height,
      sha256,
      source: rawSource,
      sourceTextRevisionId = null,
      pageIndex = null,
      visualPlanSha256 = null,
      alignmentStatus: rawAlignmentStatus,
      alignmentResult = {},
    }) {
      if (!getTaskRow.get(taskId)) throw new Error('task not found');
      if (!['REFERENCE', 'GENERATED', 'EDITED'].includes(kind)) throw new TypeError('asset kind is invalid');
      const fileName = requiredText(rawFileName, 'file name', 255);
      if (/[\\/]/.test(fileName)) throw new TypeError('file name cannot contain path separators');
      const relativePath = assertSafeRelativePath(rawRelativePath);
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) throw new TypeError('asset MIME type is invalid');
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
        || width > 10_000 || height > 10_000) {
        throw new RangeError('asset dimensions are invalid');
      }
      if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new TypeError('asset sha256 is invalid');
      const source = requiredText(rawSource, 'asset source', 100);
      const alignmentStatus = rawAlignmentStatus
        ?? (kind === 'REFERENCE' ? 'NOT_APPLICABLE' : 'UNVERIFIED');
      if (!ASSET_ALIGNMENT_STATUSES.includes(alignmentStatus)) {
        throw new TypeError('asset alignment status is invalid');
      }
      if (sourceTextRevisionId !== null) {
        if (!Number.isInteger(sourceTextRevisionId) || sourceTextRevisionId < 1) {
          throw new TypeError('source text revision id is invalid');
        }
        const revisionRow = db.prepare('SELECT task_id FROM text_revisions WHERE id = ?').get(sourceTextRevisionId);
        if (!revisionRow || Number(revisionRow.task_id) !== Number(taskId)) {
          throw new Error('source text revision not found for task');
        }
      }
      if (pageIndex !== null && (!Number.isInteger(pageIndex) || pageIndex < 1 || pageIndex > 5)) {
        throw new RangeError('asset page index must be between 1 and 5');
      }
      if (visualPlanSha256 !== null
        && (typeof visualPlanSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(visualPlanSha256))) {
        throw new TypeError('visual plan sha256 is invalid');
      }
      if (!alignmentResult || typeof alignmentResult !== 'object' || Array.isArray(alignmentResult)) {
        throw new TypeError('alignment result must be an object');
      }
      const alignmentResultJson = JSON.stringify(alignmentResult);
      if (Buffer.byteLength(alignmentResultJson, 'utf8') > 20_000) {
        throw new RangeError('alignment result cannot exceed 20000 bytes');
      }
      if (alignmentStatus === 'PASSED'
        && (sourceTextRevisionId === null || pageIndex === null || visualPlanSha256 === null)) {
        throw new TypeError('passed alignment requires text revision, page index and visual plan hash');
      }
      if (parentAssetId !== null) {
        const parent = getAssetRow.get(parentAssetId);
        if (!parent || Number(parent.task_id) !== Number(taskId)) throw new Error('parent asset not found for task');
      }
      const revision = Number(db.prepare(`
        SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM assets WHERE task_id = ?
      `).get(taskId).revision);
      const createdAt = nowIso();
      const result = db.prepare(`
        INSERT INTO assets
          (task_id, kind, parent_asset_id, revision, file_name, relative_path,
           mime_type, width, height, sha256, source, source_text_revision_id,
           page_index, visual_plan_sha256, alignment_status, alignment_result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        taskId,
        kind,
        parentAssetId,
        revision,
        fileName,
        relativePath,
        mimeType,
        width,
        height,
        sha256,
        source,
        sourceTextRevisionId,
        pageIndex,
        visualPlanSha256,
        alignmentStatus,
        alignmentResultJson,
        createdAt,
      );
      if (kind !== 'REFERENCE') {
        db.prepare(`
          UPDATE task_configs SET review_status = 'WAITING_REVIEW', updated_at = ? WHERE task_id = ?
        `).run(createdAt, taskId);
      }
      insertAudit.run(
        'task',
        taskId,
        'ASSET_CREATE',
        JSON.stringify({ assetId: Number(result.lastInsertRowid), kind, parentAssetId }),
        createdAt,
      );
      return rowToAsset(getAssetRow.get(result.lastInsertRowid));
    },

    setReviewStatus(taskId, { status, note: rawNote = '' }) {
      if (!['WAITING_REVIEW', 'APPROVED', 'REJECTED'].includes(status)) {
        throw new TypeError('review status is invalid');
      }
      const task = getTaskDetail(taskId);
      if (!task?.config) throw new Error('task configuration not found');
      const note = String(rawNote ?? '').trim();
      if ([...note].length > 2_000) throw new RangeError('review note cannot exceed 2000 characters');
      if (status === 'REJECTED' && !note) throw new TypeError('rejection note is required');
      if (status === 'APPROVED') {
        if (!task.currentTextRevision) throw new Error('current text revision is required before approval');
        const latestRun = task.generationRuns.at(-1);
        if (latestRun && ['mock_only', 'blocked'].includes(latestRun.qcDisposition)) {
          throw new Error(`${latestRun.qcDisposition} generation cannot be approved`);
        }
        const latestByPage = new Map();
        for (const asset of task.assets) {
          if ((asset.kind === 'GENERATED' || asset.kind === 'EDITED')
            && asset.sourceTextRevisionId === task.currentTextRevision.id
            && asset.pageIndex !== null) {
            latestByPage.set(asset.pageIndex, asset);
          }
        }
        const hasCompleteAlignedSet = latestByPage.size === task.config.imageCount
          && [...latestByPage.values()].every((asset) => asset.alignmentStatus === 'PASSED');
        if (!hasCompleteAlignedSet) {
          throw new Error('current text revision complete aligned image set is required before approval');
        }
      }
      const createdAt = nowIso();
      const action = status === 'APPROVED'
        ? 'REVIEW_APPROVE'
        : status === 'REJECTED' ? 'REVIEW_REJECT' : 'REVIEW_REOPEN';
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`
          UPDATE task_configs SET review_status = ?, updated_at = ? WHERE task_id = ?
        `).run(status, createdAt, taskId);
        db.prepare(`
          INSERT INTO reviews (task_id, status, note, created_at) VALUES (?, ?, ?, ?)
        `).run(taskId, status, note, createdAt);
        insertAudit.run('task', taskId, action, JSON.stringify({ note }), createdAt);
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
      return getTaskDetail(taskId);
    },

    countTasks() {
      return countTasks();
    },

    getAdjacentTaskIds(taskId) {
      if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('task id is invalid');
      const taskConfig = db.prepare(`
        SELECT import_batch_id FROM task_configs WHERE task_id = ?
      `).get(taskId);
      const row = taskConfig?.import_batch_id === null || taskConfig?.import_batch_id === undefined
        ? db.prepare(`
          SELECT
            (SELECT id FROM tasks WHERE id > ? ORDER BY id ASC LIMIT 1) AS previous_task_id,
            (SELECT id FROM tasks WHERE id < ? ORDER BY id DESC LIMIT 1) AS next_task_id
        `).get(taskId, taskId)
        : db.prepare(`
          SELECT
            (SELECT candidate.id
             FROM tasks candidate
             JOIN task_configs candidate_config ON candidate_config.task_id = candidate.id
             WHERE candidate.id > ? AND candidate_config.import_batch_id = ?
             ORDER BY candidate.id ASC LIMIT 1) AS previous_task_id,
            (SELECT candidate.id
             FROM tasks candidate
             JOIN task_configs candidate_config ON candidate_config.task_id = candidate.id
             WHERE candidate.id < ? AND candidate_config.import_batch_id = ?
             ORDER BY candidate.id DESC LIMIT 1) AS next_task_id
        `).get(taskId, taskConfig.import_batch_id, taskId, taskConfig.import_batch_id);
      return {
        previousTaskId: row.previous_task_id === null ? null : Number(row.previous_task_id),
        nextTaskId: row.next_task_id === null ? null : Number(row.next_task_id),
      };
    },

    getTaskTimingStats() {
      return readTaskTimingStats(db);
    },

    listTasks({ page = 1, pageSize = 20, importBatchId, status, reviewStatus, query } = {}) {
      const pagination = normalizePagination(page, pageSize);
      const clauses = [];
      const parameters = [];
      if (importBatchId !== undefined && importBatchId !== '') {
        const normalizedImportBatchId = Number(importBatchId);
        if (!Number.isInteger(normalizedImportBatchId) || normalizedImportBatchId < 1) {
          throw new TypeError('import batch id is invalid');
        }
        clauses.push('tc.import_batch_id = ?');
        parameters.push(normalizedImportBatchId);
      }
      if (status !== undefined && status !== '') {
        if (!TASK_STATUSES.includes(status)) throw new TypeError('task status is invalid');
        clauses.push('t.status = ?');
        parameters.push(status);
      }
      if (reviewStatus !== undefined && reviewStatus !== '') {
        if (!REVIEW_STATUSES.includes(reviewStatus)) throw new TypeError('review status is invalid');
        clauses.push('tc.review_status = ?');
        parameters.push(reviewStatus);
      }
      const normalizedQuery = String(query ?? '').trim();
      if ([...normalizedQuery].length > 500) throw new RangeError('query filter cannot exceed 500 characters');
      if (normalizedQuery) {
        clauses.push("(t.query LIKE ? ESCAPE '\\' OR tc.external_id LIKE ? ESCAPE '\\')");
        const pattern = `%${escapeLike(normalizedQuery)}%`;
        parameters.push(pattern, pattern);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const totalItems = Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM tasks t LEFT JOIN task_configs tc ON tc.task_id = t.id
        ${where}
      `).get(...parameters).count);
      const rows = db.prepare(`
        WITH latest_delivery_assets AS (
          SELECT task_id, source_text_revision_id, page_index, alignment_status,
                 ROW_NUMBER() OVER (
                   PARTITION BY task_id, source_text_revision_id, page_index
                   ORDER BY id DESC
                 ) AS recency
          FROM assets
          WHERE kind IN ('GENERATED', 'EDITED') AND page_index IS NOT NULL
        )
        SELECT t.*, tc.*,
               t.id AS task_id, t.status AS task_status, t.created_at AS task_created_at,
               t.updated_at AS task_updated_at,
               (SELECT COUNT(*) + 1 FROM tasks queued
                WHERE queued.status = 'pending' AND queued.id < t.id) AS queue_position,
               (SELECT COUNT(*) FROM latest_delivery_assets delivery
                WHERE delivery.task_id = t.id
                  AND delivery.source_text_revision_id = tc.current_text_revision_id
                  AND delivery.page_index BETWEEN 1 AND tc.image_count
                  AND delivery.recency = 1) AS export_asset_count,
               (SELECT COUNT(*) FROM latest_delivery_assets delivery
                WHERE delivery.task_id = t.id
                  AND delivery.source_text_revision_id = tc.current_text_revision_id
                  AND delivery.page_index BETWEEN 1 AND tc.image_count
                  AND delivery.recency = 1
                  AND delivery.alignment_status = 'PASSED') AS export_aligned_asset_count
        FROM tasks t
        LEFT JOIN task_configs tc ON tc.task_id = t.id
        ${where}
        ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?
      `).all(
        ...parameters,
        pagination.pageSize,
        (pagination.page - 1) * pagination.pageSize,
      );
      return paginationResult(rows.map(rowToAdminTask), pagination, totalItems);
    },

    getDashboardStats() {
      const taskRows = db.prepare(`
        SELECT status, COUNT(*) AS count FROM tasks GROUP BY status
      `).all();
      const tasks = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0]));
      for (const row of taskRows) tasks[row.status] = Number(row.count);
      tasks.total = Object.values(tasks).reduce((sum, count) => sum + count, 0);

      const reviewRows = db.prepare(`
        SELECT review_status AS status, COUNT(*) AS count
        FROM task_configs GROUP BY review_status
      `).all();
      const reviews = {
        notReady: 0,
        waiting: 0,
        approved: 0,
        rejected: 0,
      };
      const reviewKeys = {
        NOT_READY: 'notReady',
        WAITING_REVIEW: 'waiting',
        APPROVED: 'approved',
        REJECTED: 'rejected',
      };
      for (const row of reviewRows) reviews[reviewKeys[row.status]] = Number(row.count);

      const importRows = db.prepare(`
        SELECT status, COUNT(*) AS count FROM import_batches GROUP BY status
      `).all();
      const imports = { preview: 0, committed: 0 };
      for (const row of importRows) imports[row.status.toLowerCase()] = Number(row.count);
      return { tasks, reviews, imports };
    },
  };
}

export { REVIEW_STATUSES };
