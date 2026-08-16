import { DatabaseSync } from 'node:sqlite';

import { initializeQueueSchema } from '../queue.mjs';
import { DEFAULT_PROMPTS } from './default-prompts.mjs';
import {
  PROMPT_KINDS,
  hashPrompt,
  normalizePromptContent,
} from './prompt-service.mjs';

const REVIEW_STATUSES = ['NOT_READY', 'WAITING_REVIEW', 'APPROVED', 'REJECTED'];

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
      review_status TEXT NOT NULL DEFAULT 'NOT_READY'
        CHECK (review_status IN ('NOT_READY', 'WAITING_REVIEW', 'APPROVED', 'REJECTED')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS task_configs_review_idx ON task_configs(review_status, task_id);
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    ) STRICT;
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

export function createAdminStore(databasePath) {
  const db = new DatabaseSync(databasePath, { timeout: 5_000 });
  initializeAdminSchema(db);
  seedPrompts(db);

  const getPromptVersionRow = db.prepare('SELECT * FROM prompt_versions WHERE id = ?');
  const countTasks = () => Number(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count);

  return {
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

    countTasks() {
      return countTasks();
    },

    listTasks({ page = 1, pageSize = 20 } = {}) {
      const safePage = Math.max(1, Math.floor(Number(page) || 1));
      const safePageSize = Math.max(1, Math.min(100, Math.floor(Number(pageSize) || 20)));
      const totalItems = countTasks();
      const rows = db.prepare(`
        SELECT t.*, tc.*,
               t.id AS task_id, t.status AS task_status, t.created_at AS task_created_at,
               t.updated_at AS task_updated_at
        FROM tasks t
        LEFT JOIN task_configs tc ON tc.task_id = t.id
        ORDER BY t.id DESC LIMIT ? OFFSET ?
      `).all(safePageSize, (safePage - 1) * safePageSize);
      return {
        data: rows.map((row) => ({
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
            textPromptVersionId: Number(row.text_prompt_version_id),
            textPromptSha256: row.text_prompt_sha256,
            imagePromptVersionId: Number(row.image_prompt_version_id),
            imagePromptSha256: row.image_prompt_sha256,
            imageEditPromptVersionId: Number(row.image_edit_prompt_version_id),
          } : null,
        })),
        pagination: {
          page: safePage,
          pageSize: safePageSize,
          totalItems,
          totalPages: Math.ceil(totalItems / safePageSize),
        },
      };
    },
  };
}

export { REVIEW_STATUSES };
