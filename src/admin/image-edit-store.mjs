function nowIso() {
  return new Date().toISOString();
}

function normalizeWorkerId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,100}$/.test(value)) {
    throw new TypeError('workerId is invalid');
  }
  return value;
}

function rowToImageEditRequest(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    taskId: Number(row.task_id),
    sourceAssetId: Number(row.source_asset_id),
    instruction: row.instruction,
    status: row.status,
    attempts: Number(row.attempts),
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    resultAssetId: row.result_asset_id === null ? null : Number(row.result_asset_id),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function boundedError(value) {
  return String(value instanceof Error ? value.message : value ?? 'Unknown error')
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]{12,}\b/gi, 'Bearer [REDACTED_TOKEN]')
    .slice(0, 2_000);
}

export function initializeImageEditSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS image_edit_requests (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      source_asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
      instruction TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      lease_owner TEXT,
      lease_until TEXT,
      result_asset_id INTEGER REFERENCES assets(id) ON DELETE RESTRICT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS image_edit_requests_status_idx
      ON image_edit_requests(status, id);
    CREATE INDEX IF NOT EXISTS image_edit_requests_task_idx
      ON image_edit_requests(task_id, id DESC);
  `);
}

export function createImageEditStore(db) {
  const getById = db.prepare('SELECT * FROM image_edit_requests WHERE id = ?');
  const getAsset = db.prepare('SELECT * FROM assets WHERE id = ?');
  const addAudit = db.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, action, details_json, created_at)
    VALUES ('task', ?, ?, ?, ?)
  `);

  return {
    listForTask(taskId) {
      return db.prepare(`
        SELECT * FROM image_edit_requests WHERE task_id = ? ORDER BY id
      `).all(taskId).map(rowToImageEditRequest);
    },

    createImageEditRequest(taskId, { sourceAssetId, instruction: rawInstruction }) {
      const source = getAsset.get(sourceAssetId);
      if (!source || Number(source.task_id) !== Number(taskId)) {
        throw new Error('source asset not found for task');
      }
      if (typeof rawInstruction !== 'string' || rawInstruction.trim() === '') {
        throw new TypeError('image edit instruction cannot be empty');
      }
      const instruction = rawInstruction.trim();
      if ([...instruction].length > 1_000) {
        throw new RangeError('image edit instruction cannot exceed 1000 characters');
      }
      const createdAt = nowIso();
      const result = db.prepare(`
        INSERT INTO image_edit_requests
          (task_id, source_asset_id, instruction, status, created_at, updated_at)
        VALUES (?, ?, ?, 'PENDING', ?, ?)
      `).run(taskId, sourceAssetId, instruction, createdAt, createdAt);
      addAudit.run(
        taskId,
        'IMAGE_EDIT_REQUEST_CREATE',
        JSON.stringify({ requestId: Number(result.lastInsertRowid), sourceAssetId }),
        createdAt,
      );
      return rowToImageEditRequest(getById.get(result.lastInsertRowid));
    },

    claimNextImageEdit({ workerId: rawWorkerId, leaseMs = 10 * 60_000 }) {
      const workerId = normalizeWorkerId(rawWorkerId);
      if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 60 * 60_000) {
        throw new RangeError('leaseMs is invalid');
      }
      const now = new Date();
      const createdAt = now.toISOString();
      const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`
          UPDATE image_edit_requests
          SET status = 'PENDING', lease_owner = NULL, lease_until = NULL, updated_at = ?
          WHERE status = 'PROCESSING' AND lease_until <= ?
        `).run(createdAt, createdAt);
        const candidate = db.prepare(`
          SELECT id FROM image_edit_requests WHERE status = 'PENDING' ORDER BY id LIMIT 1
        `).get();
        if (!candidate) {
          db.exec('COMMIT');
          return null;
        }
        db.prepare(`
          UPDATE image_edit_requests
          SET status = 'PROCESSING', attempts = attempts + 1,
              lease_owner = ?, lease_until = ?, error = NULL, updated_at = ?
          WHERE id = ? AND status = 'PENDING'
        `).run(workerId, leaseUntil, createdAt, candidate.id);
        db.exec('COMMIT');
        return rowToImageEditRequest(getById.get(candidate.id));
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },

    completeImageEdit(id, { workerId: rawWorkerId, resultAssetId }) {
      const workerId = normalizeWorkerId(rawWorkerId);
      const request = getById.get(id);
      const resultAsset = getAsset.get(resultAssetId);
      if (!request || !resultAsset || Number(resultAsset.task_id) !== Number(request.task_id)
        || resultAsset.kind !== 'EDITED') {
        throw new Error('image edit result asset is invalid');
      }
      const updatedAt = nowIso();
      const result = db.prepare(`
        UPDATE image_edit_requests
        SET status = 'COMPLETED', result_asset_id = ?, lease_owner = NULL,
            lease_until = NULL, error = NULL, updated_at = ?
        WHERE id = ? AND status = 'PROCESSING' AND lease_owner = ?
      `).run(resultAssetId, updatedAt, id, workerId);
      if (Number(result.changes) !== 1) throw new Error('image edit request is not held by worker');
      addAudit.run(
        request.task_id,
        'IMAGE_EDIT_REQUEST_COMPLETE',
        JSON.stringify({ requestId: Number(id), resultAssetId: Number(resultAssetId) }),
        updatedAt,
      );
      return rowToImageEditRequest(getById.get(id));
    },

    failImageEdit(id, { workerId: rawWorkerId, error }) {
      const workerId = normalizeWorkerId(rawWorkerId);
      const result = db.prepare(`
        UPDATE image_edit_requests
        SET status = 'FAILED', error = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'PROCESSING' AND lease_owner = ?
      `).run(boundedError(error), nowIso(), id, workerId);
      if (Number(result.changes) !== 1) throw new Error('image edit request is not held by worker');
      return rowToImageEditRequest(getById.get(id));
    },
  };
}
