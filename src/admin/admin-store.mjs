import { DatabaseSync } from 'node:sqlite';
import { isAbsolute, normalize } from 'node:path';

import { initializeQueueSchema } from '../queue.mjs';
import { DEFAULT_PROMPTS } from './default-prompts.mjs';
import { createGenerationStore, initializeGenerationSchema } from './generation-store.mjs';
import { createImageEditStore, initializeImageEditSchema } from './image-edit-store.mjs';
import {
  PROMPT_KINDS,
  hashPrompt,
  normalizePromptContent,
} from './prompt-service.mjs';

const REVIEW_STATUSES = ['NOT_READY', 'WAITING_REVIEW', 'APPROVED', 'REJECTED'];
const TASK_STATUSES = ['pending', 'processing', 'completed', 'failed'];
const IMPORT_STATUSES = ['PREVIEW', 'COMMITTED'];

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

function batchSummary(db, id) {
  const row = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    sourceFileName: row.source_file_name,
    status: row.status,
    totalRows: Number(row.total_rows),
    validRows: Number(row.valid_rows),
    invalidRows: Number(row.invalid_rows),
    createdAt: row.created_at,
    committedAt: row.committed_at,
  };
}

function rowToAdminTask(row) {
  if (!row) return null;
  return {
    id: Number(row.task_id),
    query: row.query,
    input: parseJson(row.input_json, {}),
    status: row.task_status,
    attempts: Number(row.attempts),
    outputDir: row.output_dir,
    error: row.error,
    createdAt: row.task_created_at,
    updatedAt: row.task_updated_at,
    config: row.text_prompt_version_id ? {
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
  const countTasks = () => Number(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count);
  const getAssetRow = db.prepare('SELECT * FROM assets WHERE id = ?');
  const getTaskRow = db.prepare(`
    SELECT t.*, tc.*,
           t.id AS task_id, t.status AS task_status, t.created_at AS task_created_at,
           t.updated_at AS task_updated_at
    FROM tasks t
    LEFT JOIN task_configs tc ON tc.task_id = t.id
    WHERE t.id = ?
  `);
  const insertAudit = db.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, action, details_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const getTaskDetail = (id) => {
    const task = rowToAdminTask(getTaskRow.get(id));
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
      textRevisions,
      currentTextRevision: textRevisions.find(
        (revision) => revision.id === task.config?.currentTextRevisionId,
      ) ?? null,
      assets,
      reviews,
      imageEditRequests: imageEditStore.listForTask(id),
      generationRuns: generationStore.listGenerationRuns(id),
      auditLogs,
    };
  };

  return {
    ...imageEditStore,
    ...generationStore,
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
             reference_image_files_json, errors_json, is_valid)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of rows) {
          const errors = Array.isArray(row.errors) ? row.errors.map(String) : ['row errors are missing'];
          insertRow.run(
            batchId,
            Number(row.rowNumber),
            row.externalId || null,
            typeof row.query === 'string' ? row.query : '',
            JSON.stringify(row.input ?? {}),
            Number(row.imageCount) || 3,
            JSON.stringify(row.referenceImageFiles ?? []),
            JSON.stringify(errors),
            errors.length === 0 ? 1 : 0,
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
      return paginationResult(
        rows.map((row) => batchSummary(db, row.id)),
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

    commitImportBatch(batchId) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const batch = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId);
        if (!batch) throw new Error('import batch not found');
        if (batch.status === 'COMMITTED') {
          const count = Number(db.prepare(`
            SELECT COUNT(*) AS count FROM import_rows WHERE batch_id = ? AND task_id IS NOT NULL
          `).get(batchId).count);
          db.exec('COMMIT');
          return { batch: batchSummary(db, batchId), createdTasks: count, wasAlreadyCommitted: true };
        }
        const prompts = publishedPromptMap(db);
        const rows = db.prepare(`
          SELECT * FROM import_rows WHERE batch_id = ? AND is_valid = 1 ORDER BY row_number
        `).all(batchId);
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
        const createdAt = nowIso();
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
        db.prepare(`
          UPDATE import_batches SET status = 'COMMITTED', committed_at = ? WHERE id = ?
        `).run(createdAt, batchId);
        db.exec('COMMIT');
        return {
          batch: batchSummary(db, batchId),
          createdTasks: rows.length,
          wasAlreadyCommitted: false,
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
              lease_owner = NULL, lease_until = NULL, updated_at = ?
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
        referenceAssets,
      };
    },

    addTextRevision(taskId, input) {
      const task = getTaskRow.get(taskId);
      if (!task?.text_prompt_version_id) throw new Error('task configuration not found');
      const revision = normalizeTextRevision(input);
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
           mime_type, width, height, sha256, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        if (!task.assets.some((asset) => asset.kind === 'GENERATED' || asset.kind === 'EDITED')) {
          throw new Error('delivery image is required before approval');
        }
        const latestRun = task.generationRuns.at(-1);
        if (latestRun && ['mock_only', 'blocked'].includes(latestRun.qcDisposition)) {
          throw new Error(`${latestRun.qcDisposition} generation cannot be approved`);
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

    listTasks({ page = 1, pageSize = 20, status, reviewStatus, query } = {}) {
      const pagination = normalizePagination(page, pageSize);
      const clauses = [];
      const parameters = [];
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
        SELECT t.*, tc.*,
               t.id AS task_id, t.status AS task_status, t.created_at AS task_created_at,
               t.updated_at AS task_updated_at
        FROM tasks t
        LEFT JOIN task_configs tc ON tc.task_id = t.id
        ${where}
        ORDER BY t.id DESC LIMIT ? OFFSET ?
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
