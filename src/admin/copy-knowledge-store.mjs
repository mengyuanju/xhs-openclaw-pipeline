import { createHash } from 'node:crypto';

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

function normalizeLabel(value) {
  if (typeof value !== 'string') throw new TypeError('label must be text');
  const name = value.normalize('NFKC').trim().replace(/^#+\s*/u, '').replace(/\s+/gu, ' ');
  if (!name) throw new TypeError('label cannot be empty');
  if ([...name].length > 50) throw new RangeError('label cannot exceed 50 characters');
  return { name, key: name.toLocaleLowerCase('zh-CN') };
}

export function normalizeCopyKnowledgeLabels(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) {
    throw new TypeError('copy knowledge requires between 1 and 12 labels');
  }
  const labels = [];
  const seen = new Set();
  for (const item of value) {
    const label = normalizeLabel(item);
    if (seen.has(label.key)) continue;
    seen.add(label.key);
    labels.push(label);
  }
  if (labels.length === 0) throw new TypeError('copy knowledge requires between 1 and 12 labels');
  return labels;
}

function normalizeEditableInput(input) {
  const labels = normalizeCopyKnowledgeLabels(input.labels);
  return {
    title: requiredText(input.title, 'copy knowledge title', 200),
    sourceCopy: requiredText(input.sourceCopy, 'source copy', 20_000),
    analysisPrompt: requiredText(input.analysisPrompt, 'analysis prompt', 8_000),
    summary: requiredText(input.summary, 'analysis summary', 2_000),
    analysis: requiredText(input.analysis, 'analysis result', 15_000),
    labels,
  };
}

function normalizeInput(input) {
  return {
    ...normalizeEditableInput(input),
    analysisModel: optionalText(input.analysisModel, 'analysis model', 200),
  };
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function pagination(value, fallback) {
  return Math.max(1, Math.floor(Number(value) || fallback));
}

function itemDetails(db, ids) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const itemRows = db.prepare(`
    SELECT * FROM copy_knowledge_items WHERE id IN (${placeholders})
  `).all(...ids);
  const labelRows = db.prepare(`
    SELECT cil.item_id, l.name
    FROM copy_knowledge_item_labels cil
    JOIN copy_knowledge_labels l ON l.id = cil.label_id
    WHERE cil.item_id IN (${placeholders})
    ORDER BY cil.item_id, cil.position
  `).all(...ids);
  const labelsByItem = new Map();
  for (const row of labelRows) {
    const itemId = Number(row.item_id);
    const labels = labelsByItem.get(itemId) ?? [];
    labels.push(row.name);
    labelsByItem.set(itemId, labels);
  }
  const itemsById = new Map(itemRows.map((row) => [Number(row.id), row]));
  return ids.flatMap((id) => {
    const row = itemsById.get(Number(id));
    if (!row) return [];
    return [{
      id: Number(row.id),
      title: row.title,
      sourceCopy: row.source_copy,
      sourceCopySha256: row.source_copy_sha256,
      analysisPrompt: row.analysis_prompt,
      summary: row.summary,
      analysis: row.analysis,
      analysisModel: row.analysis_model,
      labels: labelsByItem.get(Number(row.id)) ?? [],
      createdAt: row.created_at,
    }];
  });
}

export function initializeCopyKnowledgeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS copy_knowledge_items (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      source_copy TEXT NOT NULL,
      source_copy_sha256 TEXT NOT NULL,
      analysis_prompt TEXT NOT NULL,
      summary TEXT NOT NULL,
      analysis TEXT NOT NULL,
      analysis_model TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS copy_knowledge_labels (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS copy_knowledge_item_labels (
      item_id INTEGER NOT NULL REFERENCES copy_knowledge_items(id) ON DELETE CASCADE,
      label_id INTEGER NOT NULL REFERENCES copy_knowledge_labels(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL CHECK (position >= 0),
      PRIMARY KEY (item_id, label_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS copy_knowledge_item_labels_label_idx
      ON copy_knowledge_item_labels(label_id, item_id DESC);
  `);
}

export function createCopyKnowledgeStore(db) {
  const insertItem = db.prepare(`
    INSERT INTO copy_knowledge_items
      (title, source_copy, source_copy_sha256, analysis_prompt, summary, analysis, analysis_model, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertLabel = db.prepare(`
    INSERT INTO copy_knowledge_labels (name, normalized_name, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(normalized_name) DO NOTHING
  `);
  const findLabel = db.prepare('SELECT id FROM copy_knowledge_labels WHERE normalized_name = ?');
  const linkLabel = db.prepare(`
    INSERT INTO copy_knowledge_item_labels (item_id, label_id, position) VALUES (?, ?, ?)
  `);
  const findItem = db.prepare('SELECT id FROM copy_knowledge_items WHERE id = ?');
  const updateItem = db.prepare(`
    UPDATE copy_knowledge_items
    SET title = ?, source_copy = ?, source_copy_sha256 = ?, analysis_prompt = ?, summary = ?, analysis = ?
    WHERE id = ?
  `);
  const unlinkLabels = db.prepare('DELETE FROM copy_knowledge_item_labels WHERE item_id = ?');

  function attachLabels(itemId, labels, createdAt) {
    labels.forEach((label, position) => {
      insertLabel.run(label.name, label.key, createdAt);
      const labelId = Number(findLabel.get(label.key).id);
      linkLabel.run(itemId, labelId, position);
    });
  }

  return {
    createCopyKnowledge(input) {
      const normalized = normalizeInput(input);
      db.exec('BEGIN IMMEDIATE');
      try {
        const createdAt = nowIso();
        const result = insertItem.run(
          normalized.title,
          normalized.sourceCopy,
          sha256(normalized.sourceCopy),
          normalized.analysisPrompt,
          normalized.summary,
          normalized.analysis,
          normalized.analysisModel,
          createdAt,
        );
        const itemId = Number(result.lastInsertRowid);
        attachLabels(itemId, normalized.labels, createdAt);
        db.exec('COMMIT');
        return itemDetails(db, [itemId])[0];
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },

    updateCopyKnowledge(id, input) {
      if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('copy knowledge id is invalid');
      if (!findItem.get(id)) return null;
      const normalized = normalizeEditableInput(input);
      db.exec('BEGIN IMMEDIATE');
      try {
        updateItem.run(
          normalized.title,
          normalized.sourceCopy,
          sha256(normalized.sourceCopy),
          normalized.analysisPrompt,
          normalized.summary,
          normalized.analysis,
          id,
        );
        unlinkLabels.run(id);
        attachLabels(id, normalized.labels, nowIso());
        db.exec('COMMIT');
        return itemDetails(db, [id])[0];
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },

    listCopyKnowledge({ page = 1, pageSize = 20, label } = {}) {
      const normalizedPage = pagination(page, 1);
      const normalizedPageSize = Math.min(100, pagination(pageSize, 20));
      const labelKey = label === undefined || label === null || String(label).trim() === ''
        ? null
        : normalizeLabel(String(label)).key;
      const from = labelKey
        ? `FROM copy_knowledge_items i
           JOIN copy_knowledge_item_labels cil ON cil.item_id = i.id
           JOIN copy_knowledge_labels l ON l.id = cil.label_id
           WHERE l.normalized_name = ?`
        : 'FROM copy_knowledge_items i';
      const parameters = labelKey ? [labelKey] : [];
      const totalItems = Number(db.prepare(`SELECT COUNT(*) AS count ${from}`).get(...parameters).count);
      const ids = db.prepare(`
        SELECT i.id ${from}
        ORDER BY i.id DESC
        LIMIT ? OFFSET ?
      `).all(
        ...parameters,
        normalizedPageSize,
        (normalizedPage - 1) * normalizedPageSize,
      ).map((row) => Number(row.id));
      return {
        data: itemDetails(db, ids),
        pagination: {
          page: normalizedPage,
          pageSize: normalizedPageSize,
          totalItems,
          totalPages: Math.max(1, Math.ceil(totalItems / normalizedPageSize)),
        },
      };
    },

    listCopyKnowledgeLabels() {
      return db.prepare(`
        SELECT l.name, COUNT(cil.item_id) AS item_count
        FROM copy_knowledge_labels l
        JOIN copy_knowledge_item_labels cil ON cil.label_id = l.id
        GROUP BY l.id, l.name
        ORDER BY item_count DESC, l.name COLLATE NOCASE ASC
      `).all().map((row) => ({ name: row.name, itemCount: Number(row.item_count) }));
    },
  };
}
