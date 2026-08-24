import { createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';

import { renderPrompt } from './prompt-service.mjs';

export const VISUAL_KNOWLEDGE_TYPES = [
  'PHOTO_HERO',
  'STEP_GUIDE',
  'CHECKLIST',
  'COMPARISON',
  'TIMELINE',
  'TRAVEL_GUIDE',
  'EMOTION_STORY',
  'PRODUCT_DISPLAY',
];
export const VISUAL_GENERATION_TARGETS = ['MODEL_IMAGE', 'LOCAL_CARD'];
export const VISUAL_RETENTION_MODES = ['PROMPT_ONLY', 'IMAGE_AND_PROMPT'];
export const VISUAL_RIGHTS_STATUSES = ['SELF_OWNED', 'LICENSED', 'INTERNAL_ANALYSIS_ONLY', 'UNKNOWN'];
export const VISUAL_VERSION_STATUSES = ['DRAFT', 'TESTING', 'PUBLISHED', 'RETIRED'];

const RETAINABLE_RIGHTS = new Set(['SELF_OWNED', 'LICENSED']);
const ALLOWED_VARIABLES = new Set(['query', 'category', 'targetAudience', 'imageIndex', 'imageCount']);

function nowIso() {
  return new Date().toISOString();
}

function requiredText(value, name, maxLength) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} cannot be empty`);
  const text = value.trim();
  if ([...text].length > maxLength) throw new RangeError(`${name} cannot exceed ${maxLength} characters`);
  return text;
}

function optionalText(value, name, maxLength) {
  if (value === undefined || value === null || String(value).trim() === '') return '';
  return requiredText(String(value), name, maxLength);
}

function enumValue(value, name, allowed) {
  if (!allowed.includes(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function stringList(value, name, maxItems = 20) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new TypeError(`${name} must be an array of at most ${maxItems} items`);
  }
  return [...new Set(value.map((item) => requiredText(item, `${name} item`, 50)))];
}

function jsonObject(value, name) {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > 10_000) throw new RangeError(`${name} is too large`);
  return JSON.parse(serialized);
}

function assertPromptVariables(content) {
  for (const match of content.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g)) {
    if (!ALLOWED_VARIABLES.has(match[1])) throw new TypeError(`unknown visual prompt variable: ${match[1]}`);
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertSha256(value, name, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function safeRelativePath(value) {
  const path = requiredText(value, 'relative path', 500).replaceAll('\\', '/');
  const normalized = normalize(path).replaceAll('\\', '/');
  if (isAbsolute(path) || normalized === '..' || normalized.startsWith('../')) {
    throw new TypeError('relative path escaped the knowledge root');
  }
  return path;
}

function normalizeAsset(asset) {
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) throw new TypeError('retained image asset is required');
  const fileName = requiredText(asset.fileName, 'asset file name', 255);
  if (/[\\/]/.test(fileName)) throw new TypeError('asset file name cannot contain path separators');
  if (asset.mimeType !== 'image/png') throw new TypeError('visual knowledge assets must be normalized PNG images');
  if (!Number.isInteger(asset.width) || !Number.isInteger(asset.height)
    || asset.width < 1 || asset.height < 1 || asset.width > 10_000 || asset.height > 10_000) {
    throw new RangeError('asset dimensions are invalid');
  }
  return {
    fileName,
    relativePath: safeRelativePath(asset.relativePath),
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
    sha256: assertSha256(asset.sha256, 'asset sha256'),
  };
}

function normalizeVersionInput(input, fallback = {}) {
  const promptTemplate = requiredText(input.promptTemplate ?? fallback.promptTemplate, 'visual prompt template', 2_000);
  const negativePrompt = optionalText(input.negativePrompt ?? fallback.negativePrompt, 'visual negative prompt', 600);
  assertPromptVariables(promptTemplate);
  assertPromptVariables(negativePrompt);
  const styleTags = stringList(input.styleTags ?? fallback.styleTags ?? [], 'styleTags');
  const categories = stringList(input.categories ?? fallback.categories ?? [], 'categories');
  const layoutRules = jsonObject(input.layoutRules ?? fallback.layoutRules ?? {}, 'layoutRules');
  const qualityScore = Number(input.qualityScore ?? fallback.qualityScore);
  if (!Number.isFinite(qualityScore) || qualityScore < 1 || qualityScore > 5) {
    throw new RangeError('qualityScore must be between 1 and 5');
  }
  const analysisModel = optionalText(input.analysisModel ?? fallback.analysisModel, 'analysis model', 200);
  const content = JSON.stringify({
    promptTemplate,
    negativePrompt,
    styleTags,
    categories,
    layoutRules,
    qualityScore,
    analysisModel,
  });
  return {
    promptTemplate,
    negativePrompt,
    styleTags,
    categories,
    layoutRules,
    qualityScore,
    analysisModel,
    contentSha256: sha256(content),
  };
}

function rowToVersion(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    itemId: Number(row.item_id),
    version: Number(row.version),
    promptTemplate: row.prompt_template,
    negativePrompt: row.negative_prompt,
    styleTags: JSON.parse(row.style_tags_json),
    categories: JSON.parse(row.categories_json),
    layoutRules: JSON.parse(row.layout_rules_json),
    qualityScore: Number(row.quality_score),
    analysisModel: row.analysis_model,
    status: row.status,
    contentSha256: row.content_sha256,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}

function rowToAsset(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    itemId: Number(row.item_id),
    fileName: row.file_name,
    relativePath: row.relative_path,
    mimeType: row.mime_type,
    width: Number(row.width),
    height: Number(row.height),
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

function itemDetail(db, id) {
  const item = db.prepare('SELECT * FROM visual_knowledge_items WHERE id = ?').get(id);
  if (!item) return null;
  const versions = db.prepare(`
    SELECT * FROM visual_knowledge_versions WHERE item_id = ? ORDER BY version DESC
  `).all(id).map(rowToVersion);
  return {
    id: Number(item.id),
    name: item.name,
    type: item.type,
    generationTarget: item.generation_target,
    retentionMode: item.retention_mode,
    rightsStatus: item.rights_status,
    sourceImageSha256: item.source_image_sha256,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    latestVersion: versions[0] ?? null,
    publishedVersion: versions.find((version) => version.status === 'PUBLISHED') ?? null,
    versions,
    asset: rowToAsset(db.prepare('SELECT * FROM visual_knowledge_assets WHERE item_id = ?').get(id)),
  };
}

function pagination(value, fallback) {
  return Math.max(1, Math.floor(Number(value) || fallback));
}

function scoreCandidate(candidate, task) {
  let score = candidate.qualityScore;
  const category = String(task.input?.category ?? '').trim();
  const audience = String(task.input?.targetAudience ?? '').trim();
  if (category && candidate.categories.includes(category)) score += 2;
  if (audience && candidate.promptTemplate.includes(audience)) score += 0.5;
  const haystack = `${task.query} ${category} ${audience}`;
  score += candidate.styleTags.filter((tag) => haystack.includes(tag)).length * 0.25;
  return score;
}

function referenceFromRow(row) {
  if (!row) return null;
  return {
    taskId: Number(row.task_id),
    versionId: Number(row.version_id),
    itemId: Number(row.item_id),
    type: row.type,
    generationTarget: row.generation_target,
    retentionMode: row.retention_mode,
    rightsStatus: row.rights_status,
    promptTemplate: row.prompt_template,
    negativePrompt: row.negative_prompt,
    styleTags: JSON.parse(row.style_tags_json),
    categories: JSON.parse(row.categories_json),
    layoutRules: JSON.parse(row.layout_rules_json),
    qualityScore: Number(row.quality_score),
    contentSha256: row.content_sha256,
    assetId: row.asset_id === null ? null : Number(row.asset_id),
    referenceImageRelativePath: row.relative_path ?? null,
    retrievalScore: Number(row.retrieval_score),
    retrievalReason: row.retrieval_reason,
    createdAt: row.created_at,
  };
}

export function initializeVisualKnowledgeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS visual_knowledge_items (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('PHOTO_HERO', 'STEP_GUIDE', 'CHECKLIST', 'COMPARISON', 'TIMELINE', 'TRAVEL_GUIDE', 'EMOTION_STORY', 'PRODUCT_DISPLAY')),
      generation_target TEXT NOT NULL CHECK (generation_target IN ('MODEL_IMAGE', 'LOCAL_CARD')),
      retention_mode TEXT NOT NULL CHECK (retention_mode IN ('PROMPT_ONLY', 'IMAGE_AND_PROMPT')),
      rights_status TEXT NOT NULL CHECK (rights_status IN ('SELF_OWNED', 'LICENSED', 'INTERNAL_ANALYSIS_ONLY', 'UNKNOWN')),
      source_image_sha256 TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS visual_knowledge_items_type_idx
      ON visual_knowledge_items(type, generation_target);
    CREATE TABLE IF NOT EXISTS visual_knowledge_versions (
      id INTEGER PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES visual_knowledge_items(id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK (version > 0),
      prompt_template TEXT NOT NULL,
      negative_prompt TEXT NOT NULL DEFAULT '',
      style_tags_json TEXT NOT NULL,
      categories_json TEXT NOT NULL,
      layout_rules_json TEXT NOT NULL,
      quality_score REAL NOT NULL CHECK (quality_score BETWEEN 1 AND 5),
      analysis_model TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('DRAFT', 'TESTING', 'PUBLISHED', 'RETIRED')),
      content_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      published_at TEXT,
      UNIQUE(item_id, version)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS visual_knowledge_versions_status_idx
      ON visual_knowledge_versions(status, quality_score DESC);
    CREATE TABLE IF NOT EXISTS visual_knowledge_assets (
      id INTEGER PRIMARY KEY,
      item_id INTEGER NOT NULL UNIQUE REFERENCES visual_knowledge_items(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      relative_path TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL CHECK (mime_type = 'image/png'),
      width INTEGER NOT NULL CHECK (width > 0),
      height INTEGER NOT NULL CHECK (height > 0),
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS task_visual_references (
      task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      version_id INTEGER NOT NULL REFERENCES visual_knowledge_versions(id) ON DELETE RESTRICT,
      asset_id INTEGER REFERENCES visual_knowledge_assets(id) ON DELETE RESTRICT,
      retrieval_score REAL NOT NULL,
      retrieval_reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
  `);
}

export function composeVisualImagePrompt({ systemPrompt, visualReference, variables = {}, taskPrompt }) {
  const sections = [optionalText(systemPrompt, 'image system prompt', 2_000)];
  if (visualReference) {
    const recipe = renderPrompt(
      requiredText(visualReference.promptTemplate, 'visual prompt template', 2_000),
      variables,
    );
    sections.push(`视觉配方：\n${recipe}`);
    const negative = optionalText(visualReference.negativePrompt, 'visual negative prompt', 600);
    if (negative) sections.push(`负面约束：\n${renderPrompt(negative, variables)}`);
  }
  sections.push(requiredText(taskPrompt, 'task image prompt', 1_000));
  const prompt = sections.filter(Boolean).join('\n\n');
  if (prompt.length > 3_000) throw new RangeError('composed image prompt cannot exceed 3000 characters');
  return prompt;
}

export function createVisualKnowledgeStore(db) {
  const getVersionRow = db.prepare('SELECT * FROM visual_knowledge_versions WHERE id = ?');
  const getReferenceRow = db.prepare(`
    SELECT tvr.*, v.item_id, v.prompt_template, v.negative_prompt, v.style_tags_json,
           v.categories_json, v.layout_rules_json, v.quality_score, v.content_sha256,
           i.type, i.generation_target, i.retention_mode, i.rights_status,
           a.relative_path
    FROM task_visual_references tvr
    JOIN visual_knowledge_versions v ON v.id = tvr.version_id
    JOIN visual_knowledge_items i ON i.id = v.item_id
    LEFT JOIN visual_knowledge_assets a ON a.id = tvr.asset_id
    WHERE tvr.task_id = ?
  `);

  return {
    createVisualKnowledge(input) {
      const name = requiredText(input.name, 'visual knowledge name', 200);
      const type = enumValue(input.type, 'visual knowledge type', VISUAL_KNOWLEDGE_TYPES);
      const generationTarget = enumValue(
        input.generationTarget,
        'visual generation target',
        VISUAL_GENERATION_TARGETS,
      );
      const retentionMode = enumValue(input.retentionMode, 'visual retention mode', VISUAL_RETENTION_MODES);
      const rightsStatus = enumValue(input.rightsStatus, 'visual rights status', VISUAL_RIGHTS_STATUSES);
      const sourceImageSha256 = assertSha256(input.sourceImageSha256, 'source image sha256', { optional: true });
      if (retentionMode === 'IMAGE_AND_PROMPT' && !RETAINABLE_RIGHTS.has(rightsStatus)) {
        throw new TypeError('retained images require self-owned or licensed rights');
      }
      if (retentionMode === 'PROMPT_ONLY' && input.asset) {
        throw new TypeError('prompt-only visual knowledge cannot retain an asset');
      }
      const asset = retentionMode === 'IMAGE_AND_PROMPT' ? normalizeAsset(input.asset) : null;
      const version = normalizeVersionInput(input);
      const createdAt = nowIso();

      db.exec('BEGIN IMMEDIATE');
      try {
        const itemId = Number(db.prepare(`
          INSERT INTO visual_knowledge_items
            (name, type, generation_target, retention_mode, rights_status,
             source_image_sha256, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          name,
          type,
          generationTarget,
          retentionMode,
          rightsStatus,
          sourceImageSha256,
          createdAt,
          createdAt,
        ).lastInsertRowid);
        db.prepare(`
          INSERT INTO visual_knowledge_versions
            (item_id, version, prompt_template, negative_prompt, style_tags_json,
             categories_json, layout_rules_json, quality_score, analysis_model,
             status, content_sha256, created_at)
          VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)
        `).run(
          itemId,
          version.promptTemplate,
          version.negativePrompt,
          JSON.stringify(version.styleTags),
          JSON.stringify(version.categories),
          JSON.stringify(version.layoutRules),
          version.qualityScore,
          version.analysisModel,
          version.contentSha256,
          createdAt,
        );
        if (asset) {
          db.prepare(`
            INSERT INTO visual_knowledge_assets
              (item_id, file_name, relative_path, mime_type, width, height, sha256, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            itemId,
            asset.fileName,
            asset.relativePath,
            asset.mimeType,
            asset.width,
            asset.height,
            asset.sha256,
            createdAt,
          );
        }
        db.exec('COMMIT');
        return itemDetail(db, itemId);
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },

    getVisualKnowledge(id) {
      return itemDetail(db, id);
    },

    getVisualKnowledgeAsset(id) {
      return rowToAsset(db.prepare('SELECT * FROM visual_knowledge_assets WHERE id = ?').get(id));
    },

    listVisualKnowledge({ page = 1, pageSize = 20, status, type, query } = {}) {
      const normalizedPage = pagination(page, 1);
      const normalizedPageSize = Math.min(100, pagination(pageSize, 20));
      const clauses = [];
      const parameters = [];
      if (status) {
        enumValue(status, 'visual version status', VISUAL_VERSION_STATUSES);
        clauses.push('EXISTS (SELECT 1 FROM visual_knowledge_versions v WHERE v.item_id = i.id AND v.status = ?)');
        parameters.push(status);
      }
      if (type) {
        enumValue(type, 'visual knowledge type', VISUAL_KNOWLEDGE_TYPES);
        clauses.push('i.type = ?');
        parameters.push(type);
      }
      const normalizedQuery = String(query ?? '').trim();
      if ([...normalizedQuery].length > 200) throw new RangeError('visual knowledge query is too long');
      if (normalizedQuery) {
        clauses.push('(i.name LIKE ? OR EXISTS (SELECT 1 FROM visual_knowledge_versions v WHERE v.item_id = i.id AND v.prompt_template LIKE ?))');
        const pattern = `%${normalizedQuery.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
        parameters.push(pattern, pattern);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const totalItems = Number(db.prepare(`
        SELECT COUNT(*) AS count FROM visual_knowledge_items i ${where}
      `).get(...parameters).count);
      const rows = db.prepare(`
        SELECT i.id FROM visual_knowledge_items i ${where}
        ORDER BY i.id DESC LIMIT ? OFFSET ?
      `).all(
        ...parameters,
        normalizedPageSize,
        (normalizedPage - 1) * normalizedPageSize,
      );
      return {
        data: rows.map((row) => itemDetail(db, row.id)),
        pagination: {
          page: normalizedPage,
          pageSize: normalizedPageSize,
          totalItems,
          totalPages: Math.ceil(totalItems / normalizedPageSize),
        },
      };
    },

    updateVisualKnowledgeVersion(id, input) {
      const current = rowToVersion(getVersionRow.get(id));
      if (!current) throw new Error('visual knowledge version not found');
      if (['PUBLISHED', 'RETIRED'].includes(current.status)) {
        throw new Error('published visual knowledge versions are immutable');
      }
      const next = normalizeVersionInput(input, current);
      db.prepare(`
        UPDATE visual_knowledge_versions
        SET prompt_template = ?, negative_prompt = ?, style_tags_json = ?, categories_json = ?,
            layout_rules_json = ?, quality_score = ?, analysis_model = ?, content_sha256 = ?
        WHERE id = ?
      `).run(
        next.promptTemplate,
        next.negativePrompt,
        JSON.stringify(next.styleTags),
        JSON.stringify(next.categories),
        JSON.stringify(next.layoutRules),
        next.qualityScore,
        next.analysisModel,
        next.contentSha256,
        id,
      );
      return rowToVersion(getVersionRow.get(id));
    },

    publishVisualKnowledgeVersion(id) {
      const current = rowToVersion(getVersionRow.get(id));
      if (!current) throw new Error('visual knowledge version not found');
      if (current.qualityScore < 4) throw new Error('visual knowledge requires a quality score of at least 4 to publish');
      if (current.status === 'RETIRED') throw new Error('retired visual knowledge cannot be published');
      if (current.status === 'PUBLISHED') return current;
      const publishedAt = nowIso();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`
          UPDATE visual_knowledge_versions SET status = 'RETIRED'
          WHERE item_id = ? AND status = 'PUBLISHED'
        `).run(current.itemId);
        db.prepare(`
          UPDATE visual_knowledge_versions SET status = 'PUBLISHED', published_at = ? WHERE id = ?
        `).run(publishedAt, id);
        db.prepare('UPDATE visual_knowledge_items SET updated_at = ? WHERE id = ?')
          .run(publishedAt, current.itemId);
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
      return rowToVersion(getVersionRow.get(id));
    },

    retireVisualKnowledge(id) {
      const item = itemDetail(db, id);
      if (!item) throw new Error('visual knowledge item not found');
      db.prepare(`
        UPDATE visual_knowledge_versions SET status = 'RETIRED' WHERE item_id = ? AND status != 'RETIRED'
      `).run(id);
      db.prepare('UPDATE visual_knowledge_items SET updated_at = ? WHERE id = ?').run(nowIso(), id);
      return itemDetail(db, id);
    },

    getTaskVisualReference(taskId) {
      return referenceFromRow(getReferenceRow.get(taskId));
    },

    resolveVisualReferenceForTask(taskId) {
      const existing = referenceFromRow(getReferenceRow.get(taskId));
      if (existing) return existing;
      const taskRow = db.prepare('SELECT query, input_json FROM tasks WHERE id = ?').get(taskId);
      if (!taskRow) throw new Error('task not found');
      const task = { query: taskRow.query, input: JSON.parse(taskRow.input_json || '{}') };
      const rows = db.prepare(`
        SELECT v.*, i.name, i.type, i.generation_target, i.retention_mode, i.rights_status,
               a.id AS asset_id, a.relative_path
        FROM visual_knowledge_versions v
        JOIN visual_knowledge_items i ON i.id = v.item_id
        LEFT JOIN visual_knowledge_assets a ON a.item_id = i.id
        WHERE v.status = 'PUBLISHED' AND i.generation_target = 'MODEL_IMAGE'
        ORDER BY v.quality_score DESC, v.id
        LIMIT 500
      `).all().map((row) => {
        const version = rowToVersion(row);
        return {
          ...version,
          name: row.name,
          type: row.type,
          generationTarget: row.generation_target,
          retentionMode: row.retention_mode,
          rightsStatus: row.rights_status,
          assetId: row.asset_id === null ? null : Number(row.asset_id),
          relativePath: row.relative_path,
        };
      });
      if (rows.length === 0) return null;
      const selected = rows
        .map((candidate) => ({ candidate, score: scoreCandidate(candidate, task) }))
        .sort((left, right) => right.score - left.score || left.candidate.id - right.candidate.id)[0];
      const assetId = selected.candidate.retentionMode === 'IMAGE_AND_PROMPT'
        && RETAINABLE_RIGHTS.has(selected.candidate.rightsStatus)
        ? selected.candidate.assetId
        : null;
      const reason = `type=${selected.candidate.type}; quality=${selected.candidate.qualityScore}`;
      db.prepare(`
        INSERT OR IGNORE INTO task_visual_references
          (task_id, version_id, asset_id, retrieval_score, retrieval_reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(taskId, selected.candidate.id, assetId, selected.score, reason, nowIso());
      return referenceFromRow(getReferenceRow.get(taskId));
    },
  };
}
