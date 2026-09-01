import { createHash } from 'node:crypto';

import { ApiError } from './http.mjs';

const REVIEW_TASK_STAGES = Object.freeze(['COPY', 'IMAGE']);

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback) {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function subjectRecord(value) {
  const serialized = JSON.stringify(stableValue(value));
  if (Buffer.byteLength(serialized, 'utf8') > 100_000) {
    throw new RangeError('review subject cannot exceed 100000 bytes');
  }
  return {
    serialized,
    sha256: createHash('sha256').update(serialized).digest('hex'),
  };
}

function normalizedPagination(page = 1, pageSize = 30) {
  const normalizedPage = Number(page);
  const normalizedPageSize = Number(pageSize);
  if (!Number.isInteger(normalizedPage) || normalizedPage < 1) throw new TypeError('page is invalid');
  if (!Number.isInteger(normalizedPageSize) || normalizedPageSize < 1 || normalizedPageSize > 100) {
    throw new TypeError('page size is invalid');
  }
  return { page: normalizedPage, pageSize: normalizedPageSize };
}

function paginationResult(data, pagination, totalItems) {
  return {
    data,
    pagination: {
      ...pagination,
      totalItems,
      totalPages: Math.ceil(totalItems / pagination.pageSize),
    },
  };
}

function aliasedUser(row, prefix) {
  if (row[`${prefix}_id`] === null || row[`${prefix}_id`] === undefined) return null;
  return {
    id: Number(row[`${prefix}_id`]),
    username: row[`${prefix}_username`],
    displayName: row[`${prefix}_display_name`],
  };
}

function rowToReviewAsset(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    taskId: Number(row.task_id),
    kind: row.kind,
    parentAssetId: row.parent_asset_id === null ? null : Number(row.parent_asset_id),
    revision: Number(row.revision),
    fileName: row.file_name,
    mimeType: row.mime_type,
    width: Number(row.width),
    height: Number(row.height),
    sha256: row.sha256,
    sourceTextRevisionId: row.source_text_revision_id === null ? null : Number(row.source_text_revision_id),
    pageIndex: row.page_index === null ? null : Number(row.page_index),
    alignmentStatus: row.alignment_status,
    createdAt: row.created_at,
  };
}

function rowToTaskStageDecision(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    assignmentId: Number(row.assignment_id),
    stage: row.stage,
    decision: row.decision,
    reasonCodes: parseJson(row.reason_codes_json, []),
    note: row.note,
    subjectSha256: row.subject_sha256,
    subject: parseJson(row.subject_json, {}),
    reviewer: {
      id: Number(row.reviewer_id ?? row.reviewer_user_id),
      username: row.reviewer_username,
      displayName: row.reviewer_display_name,
    },
    createdAt: row.created_at,
  };
}

function stageProgress(decision, currentSubject) {
  if (!decision) return { status: 'PENDING', decision: null };
  if (!currentSubject || decision.subjectSha256 !== currentSubject.sha256) {
    return { status: 'STALE', decision };
  }
  return { status: decision.decision, decision };
}

function actorEventFields(actor) {
  return actor.subject === 'admin' ? ['ADMIN', null] : ['USER', actor.userId];
}

export function initializeReviewTaskSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_task_assignments (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
      import_batch_id INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
      assignee_user_id INTEGER NOT NULL REFERENCES review_users(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      assigned_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS review_task_assignments_queue_idx
      ON review_task_assignments(assignee_user_id, import_batch_id, id);

    CREATE TABLE IF NOT EXISTS review_task_stage_decisions (
      id INTEGER PRIMARY KEY,
      assignment_id INTEGER NOT NULL REFERENCES review_task_assignments(id) ON DELETE CASCADE,
      reviewer_user_id INTEGER NOT NULL REFERENCES review_users(id) ON DELETE RESTRICT,
      stage TEXT NOT NULL CHECK (stage IN ('COPY', 'IMAGE')),
      decision TEXT NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
      reason_codes_json TEXT NOT NULL DEFAULT '[]',
      note TEXT NOT NULL DEFAULT '',
      subject_sha256 TEXT NOT NULL,
      subject_json TEXT NOT NULL,
      legacy_work_item_id INTEGER UNIQUE REFERENCES review_work_items(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS review_task_stage_decisions_assignment_idx
      ON review_task_stage_decisions(assignment_id, stage, id DESC);

    CREATE TABLE IF NOT EXISTS review_task_events (
      id INTEGER PRIMARY KEY,
      assignment_id INTEGER NOT NULL REFERENCES review_task_assignments(id) ON DELETE CASCADE,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('ADMIN', 'USER')),
      actor_user_id INTEGER REFERENCES review_users(id) ON DELETE RESTRICT,
      action TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      CHECK ((actor_kind = 'ADMIN' AND actor_user_id IS NULL) OR (actor_kind = 'USER' AND actor_user_id IS NOT NULL))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS review_task_events_assignment_idx
      ON review_task_events(assignment_id, id);

    INSERT OR IGNORE INTO review_task_assignments
      (task_id, import_batch_id, assignee_user_id, version, assigned_at, created_at, updated_at)
    SELECT item.task_id, item.import_batch_id, item.assignee_user_id, 1,
           COALESCE(item.assigned_at, item.created_at), item.created_at, item.updated_at
    FROM review_work_items item
    WHERE item.review_type = 'COPY' AND item.assignee_user_id IS NOT NULL
      AND item.id = (
        SELECT MIN(candidate.id) FROM review_work_items candidate
        WHERE candidate.review_type = 'COPY'
          AND candidate.task_id = item.task_id
          AND candidate.assignee_user_id IS NOT NULL
      );

    INSERT OR IGNORE INTO review_task_stage_decisions
      (assignment_id, reviewer_user_id, stage, decision, reason_codes_json, note,
       subject_sha256, subject_json, legacy_work_item_id, created_at)
    SELECT assignment.id, decision.reviewer_user_id, 'COPY', decision.decision,
           decision.reason_codes_json, decision.note, decision.subject_sha256,
           item.subject_json, item.id, decision.created_at
    FROM review_decisions decision
    JOIN review_work_items item ON item.id = decision.work_item_id AND item.review_type = 'COPY'
    JOIN review_task_assignments assignment ON assignment.task_id = item.task_id;
  `);
}

export function createReviewTaskStore(db, {
  resolveReviewActor,
  isManager,
  assertCanReview,
  getReviewUser,
}) {
  const taskAssignmentSelect = `
    SELECT assignment.*,
           task.query,
           task.status AS task_status,
           config.external_id,
           config.image_count,
           config.current_text_revision_id,
           batch.name AS import_batch_name,
           assignee.id AS assignee_id,
           assignee.username AS assignee_username,
           assignee.display_name AS assignee_display_name
    FROM review_task_assignments assignment
    JOIN tasks task ON task.id = assignment.task_id
    JOIN task_configs config ON config.task_id = task.id
    JOIN import_batches batch ON batch.id = assignment.import_batch_id
    JOIN review_users assignee ON assignee.id = assignment.assignee_user_id
  `;

  function insertTaskEvent(assignmentId, actor, action, details = {}) {
    const [actorKind, actorUserId] = actorEventFields(actor);
    db.prepare(`
      INSERT INTO review_task_events
        (assignment_id, actor_kind, actor_user_id, action, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(assignmentId, actorKind, actorUserId, action, JSON.stringify(details), nowIso());
  }

  function getTaskAssignmentRow(id) {
    return db.prepare(`${taskAssignmentSelect} WHERE assignment.id = ?`).get(id);
  }

  function latestTaskStageDecision(assignmentId, stage) {
    const row = db.prepare(`
      SELECT decision.*,
             reviewer.id AS reviewer_id,
             reviewer.username AS reviewer_username,
             reviewer.display_name AS reviewer_display_name
      FROM review_task_stage_decisions decision
      JOIN review_users reviewer ON reviewer.id = decision.reviewer_user_id
      WHERE decision.assignment_id = ? AND decision.stage = ?
      ORDER BY decision.id DESC LIMIT 1
    `).get(assignmentId, stage);
    return rowToTaskStageDecision(row);
  }

  function taskReviewSubjects(row) {
    const revision = row.current_text_revision_id === null
      ? null
      : db.prepare('SELECT * FROM text_revisions WHERE id = ? AND task_id = ?')
        .get(row.current_text_revision_id, row.task_id);
    const assets = db.prepare('SELECT * FROM assets WHERE task_id = ? ORDER BY id')
      .all(row.task_id).map(rowToReviewAsset);
    const latestAssetByPage = new Map();
    if (revision) {
      for (const asset of assets) {
        if (asset.kind === 'REFERENCE'
          || asset.sourceTextRevisionId !== Number(revision.id)
          || !Number.isInteger(asset.pageIndex)
          || asset.pageIndex < 1
          || asset.pageIndex > Number(row.image_count)) continue;
        const previous = latestAssetByPage.get(asset.pageIndex);
        if (!previous || asset.id > previous.id) latestAssetByPage.set(asset.pageIndex, asset);
      }
    }
    const currentAssets = [...latestAssetByPage.values()]
      .sort((left, right) => left.pageIndex - right.pageIndex);
    const imageSetComplete = currentAssets.length === Number(row.image_count)
      && currentAssets.every((asset, index) => asset.pageIndex === index + 1);
    const imageSetReady = imageSetComplete
      && currentAssets.every((asset) => asset.alignmentStatus === 'PASSED');
    const copyValue = revision ? {
      kind: 'COPY',
      taskId: Number(row.task_id),
      textRevisionId: Number(revision.id),
      externalId: row.external_id,
      query: row.query,
      title: revision.title,
      body: revision.body,
      tags: parseJson(revision.tags_json, []),
    } : null;
    const copySubject = copyValue ? { ...subjectRecord(copyValue), value: copyValue } : null;
    const imageValue = copySubject && currentAssets.length > 0 ? {
      kind: 'IMAGE',
      taskId: Number(row.task_id),
      textRevisionId: Number(revision.id),
      copySha256: copySubject.sha256,
      assets: currentAssets.map((asset) => ({
        id: asset.id,
        sha256: asset.sha256,
        kind: asset.kind,
        revision: asset.revision,
        pageIndex: asset.pageIndex,
        alignmentStatus: asset.alignmentStatus,
      })),
    } : null;
    const imageSubject = imageValue ? { ...subjectRecord(imageValue), value: imageValue } : null;
    return {
      revision: revision ? {
        id: Number(revision.id),
        title: revision.title,
        body: revision.body,
        tags: parseJson(revision.tags_json, []),
        source: revision.source,
        createdAt: revision.created_at,
      } : null,
      assets,
      currentAssets,
      imageSetComplete,
      imageSetReady,
      copySubject,
      imageSubject,
    };
  }

  function buildTaskAssignment(row) {
    if (!row) return null;
    const subjects = taskReviewSubjects(row);
    const copyDecision = latestTaskStageDecision(row.id, 'COPY');
    const imageDecision = latestTaskStageDecision(row.id, 'IMAGE');
    const copy = stageProgress(copyDecision, subjects.copySubject);
    const currentImageProgress = stageProgress(imageDecision, subjects.imageSubject);
    const image = currentImageProgress.status === 'APPROVED' && !subjects.imageSetReady
      ? { status: 'STALE', decision: currentImageProgress.decision }
      : currentImageProgress;
    return {
      id: Number(row.id),
      taskId: Number(row.task_id),
      importBatchId: Number(row.import_batch_id),
      importBatch: { id: Number(row.import_batch_id), name: row.import_batch_name },
      assignee: aliasedUser(row, 'assignee'),
      version: Number(row.version),
      assignedAt: row.assigned_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      task: {
        id: Number(row.task_id),
        query: row.query,
        status: row.task_status,
        externalId: row.external_id,
        imageCount: Number(row.image_count),
        currentTextRevision: subjects.revision,
        assets: subjects.assets,
        currentAssets: subjects.currentAssets,
        imageSetComplete: subjects.imageSetComplete,
        imageSetReady: subjects.imageSetReady,
      },
      progress: {
        status: copy.status === 'APPROVED' && image.status === 'APPROVED' ? 'COMPLETED' : 'IN_REVIEW',
        copy,
        image,
      },
    };
  }

  function assertTaskAssignmentVisible(actor, assignment) {
    if (isManager(actor)) return;
    assertCanReview(actor, 'COPY');
    if (assignment.assignee?.id !== actor.userId) {
      throw new ApiError(403, 'FORBIDDEN', '该内容任务未分配给当前账号');
    }
  }

  function activeContentReviewer(userId) {
    if (!Number.isInteger(userId) || userId < 1) throw new TypeError('assignee user id is invalid');
    const user = getReviewUser(userId);
    if (!user || user.status !== 'ACTIVE' || !user.roles.includes('COPY_REVIEWER')) {
      throw new ApiError(422, 'INVALID_ASSIGNEE', '只能分配给启用的内容质检员');
    }
    return user;
  }

  return {
    listReviewTaskAllocationBatches(actor) {
      const resolved = resolveReviewActor(actor);
      if (!isManager(resolved)) throw new ApiError(403, 'FORBIDDEN', '没有查看任务分配统计的权限');
      return db.prepare(`
        SELECT batch.id, batch.name, batch.status,
               COUNT(config.task_id) AS total_count,
               COUNT(assignment.id) AS assigned_count
        FROM import_batches batch
        LEFT JOIN task_configs config ON config.import_batch_id = batch.id
        LEFT JOIN review_task_assignments assignment ON assignment.task_id = config.task_id
        WHERE batch.status = 'COMMITTED'
        GROUP BY batch.id
        ORDER BY batch.id DESC
      `).all().map((row) => ({
        id: Number(row.id),
        name: row.name,
        status: row.status,
        totalCount: Number(row.total_count),
        assignedCount: Number(row.assigned_count),
        unassignedCount: Number(row.total_count) - Number(row.assigned_count),
      }));
    },

    listReviewTaskAssignments(actor, filters = {}) {
      const resolved = resolveReviewActor(actor);
      const pagination = normalizedPagination(filters.page, filters.pageSize);
      const clauses = [];
      const parameters = [];
      if (!isManager(resolved)) {
        assertCanReview(resolved, 'COPY');
        clauses.push('assignment.assignee_user_id = ?');
        parameters.push(resolved.userId);
      }
      if (filters.importBatchId !== undefined && filters.importBatchId !== '') {
        const importBatchId = Number(filters.importBatchId);
        if (!Number.isInteger(importBatchId) || importBatchId < 1) throw new TypeError('import batch id is invalid');
        clauses.push('assignment.import_batch_id = ?');
        parameters.push(importBatchId);
      }
      if (filters.assigneeUserId !== undefined && filters.assigneeUserId !== '') {
        if (!isManager(resolved)) throw new ApiError(403, 'FORBIDDEN', '没有按人员筛选权限');
        const assigneeUserId = Number(filters.assigneeUserId);
        if (!Number.isInteger(assigneeUserId) || assigneeUserId < 1) throw new TypeError('assignee user id is invalid');
        clauses.push('assignment.assignee_user_id = ?');
        parameters.push(assigneeUserId);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const totalItems = Number(db.prepare(`
        SELECT COUNT(*) AS count FROM review_task_assignments assignment ${where}
      `).get(...parameters).count);
      const rows = db.prepare(`
        ${taskAssignmentSelect}
        ${where}
        ORDER BY assignment.id ASC LIMIT ? OFFSET ?
      `).all(...parameters, pagination.pageSize, (pagination.page - 1) * pagination.pageSize);
      return paginationResult(rows.map(buildTaskAssignment), pagination, totalItems);
    },

    getReviewTaskAssignment(actor, assignmentId) {
      const resolved = resolveReviewActor(actor);
      if (!Number.isInteger(assignmentId) || assignmentId < 1) throw new TypeError('assignment id is invalid');
      const assignment = buildTaskAssignment(getTaskAssignmentRow(assignmentId));
      if (!assignment) throw new ApiError(404, 'NOT_FOUND', '内容质检任务不存在');
      assertTaskAssignmentVisible(resolved, assignment);
      return assignment;
    },

    allocateReviewTasks(actor, { importBatchId, assigneeUserId, count }) {
      const resolved = resolveReviewActor(actor);
      if (!isManager(resolved)) throw new ApiError(403, 'FORBIDDEN', '没有按条数派单权限');
      if (!Number.isInteger(importBatchId) || importBatchId < 1) throw new TypeError('import batch id is invalid');
      if (!Number.isInteger(count) || count < 1 || count > 500) throw new RangeError('assignment count must be between 1 and 500');
      const assignee = activeContentReviewer(assigneeUserId);
      const batch = db.prepare("SELECT id FROM import_batches WHERE id = ? AND status = 'COMMITTED'").get(importBatchId);
      if (!batch) throw new ApiError(404, 'NOT_FOUND', '已提交的导入批次不存在');
      const assignedAt = nowIso();
      const assignmentIds = [];
      db.exec('BEGIN IMMEDIATE');
      try {
        const candidates = db.prepare(`
          SELECT config.task_id
          FROM task_configs config
          LEFT JOIN review_task_assignments assignment ON assignment.task_id = config.task_id
          WHERE config.import_batch_id = ? AND assignment.id IS NULL
          ORDER BY config.task_id ASC LIMIT ?
        `).all(importBatchId, count).map((row) => Number(row.task_id));
        if (candidates.length < count) {
          throw new ApiError(
            409,
            'INSUFFICIENT_UNASSIGNED_TASKS',
            `当前批次只剩 ${candidates.length} 条未分配任务，无法分配 ${count} 条`,
          );
        }
        const insert = db.prepare(`
          INSERT INTO review_task_assignments
            (task_id, import_batch_id, assignee_user_id, version, assigned_at, created_at, updated_at)
          VALUES (?, ?, ?, 1, ?, ?, ?)
        `);
        for (const taskId of candidates) {
          const result = insert.run(taskId, importBatchId, assignee.id, assignedAt, assignedAt, assignedAt);
          const assignmentId = Number(result.lastInsertRowid);
          assignmentIds.push(assignmentId);
          insertTaskEvent(assignmentId, resolved, 'TASK_ALLOCATED', { taskId, assigneeUserId: assignee.id });
        }
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
      const remainingCount = Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM task_configs config
        LEFT JOIN review_task_assignments assignment ON assignment.task_id = config.task_id
        WHERE config.import_batch_id = ? AND assignment.id IS NULL
      `).get(importBatchId).count);
      return {
        assignedCount: assignmentIds.length,
        remainingCount,
        assignments: assignmentIds.map((id) => buildTaskAssignment(getTaskAssignmentRow(id))),
      };
    },

    reassignReviewTask(actor, assignmentId, { assigneeUserId, expectedVersion }) {
      const resolved = resolveReviewActor(actor);
      if (!isManager(resolved)) throw new ApiError(403, 'FORBIDDEN', '没有转派权限');
      if (!Number.isInteger(assignmentId) || assignmentId < 1) throw new TypeError('assignment id is invalid');
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new TypeError('expected version is invalid');
      const assignee = activeContentReviewer(assigneeUserId);
      const current = buildTaskAssignment(getTaskAssignmentRow(assignmentId));
      if (!current) throw new ApiError(404, 'NOT_FOUND', '内容质检任务不存在');
      const updatedAt = nowIso();
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = db.prepare(`
          UPDATE review_task_assignments
          SET assignee_user_id = ?, assigned_at = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ?
        `).run(assignee.id, updatedAt, updatedAt, assignmentId, expectedVersion);
        if (result.changes !== 1) throw new ApiError(409, 'VERSION_CONFLICT', '内容质检任务已被其他操作更新');
        insertTaskEvent(assignmentId, resolved, 'TASK_REASSIGNED', {
          previousAssigneeUserId: current.assignee.id,
          assigneeUserId: assignee.id,
        });
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
      return buildTaskAssignment(getTaskAssignmentRow(assignmentId));
    },

    decideReviewTaskStage(actor, assignmentId, {
      stage,
      decision,
      reasonCodes = [],
      note = '',
      expectedVersion,
    }) {
      const resolved = resolveReviewActor(actor);
      if (resolved.subject !== 'user') throw new ApiError(403, 'FORBIDDEN', '管理员不能代替质检员提交结论');
      assertCanReview(resolved, 'COPY');
      if (!Number.isInteger(assignmentId) || assignmentId < 1) throw new TypeError('assignment id is invalid');
      if (!REVIEW_TASK_STAGES.includes(stage)) throw new TypeError('review task stage is invalid');
      if (!['APPROVED', 'REJECTED'].includes(decision)) throw new TypeError('review decision is invalid');
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new TypeError('expected version is invalid');
      if (!Array.isArray(reasonCodes) || reasonCodes.length > 20
        || reasonCodes.some((code) => typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{1,39}$/u.test(code))) {
        throw new TypeError('reason codes are invalid');
      }
      const normalizedNote = String(note ?? '').trim();
      if ([...normalizedNote].length > 2_000) throw new RangeError('review note cannot exceed 2000 characters');
      if (decision === 'REJECTED' && reasonCodes.length === 0 && normalizedNote === '') {
        throw new TypeError('rejection reason is required');
      }

      const createdAt = nowIso();
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = getTaskAssignmentRow(assignmentId);
        const current = buildTaskAssignment(row);
        if (!current) throw new ApiError(404, 'NOT_FOUND', '内容质检任务不存在');
        assertTaskAssignmentVisible(resolved, current);
        const subjects = taskReviewSubjects(row);
        const subject = stage === 'COPY' ? subjects.copySubject : subjects.imageSubject;
        if (stage === 'COPY' && !subject) {
          throw new ApiError(409, 'COPY_NOT_READY', '当前任务还没有可审核的文案');
        }
        if (stage === 'IMAGE') {
          const latestCopy = latestTaskStageDecision(assignmentId, 'COPY');
          const copy = stageProgress(latestCopy, subjects.copySubject);
          if (copy.status !== 'APPROVED') {
            throw new ApiError(409, 'COPY_APPROVAL_REQUIRED', '当前文案通过后才能提交图片结论');
          }
          if (!subject) throw new ApiError(409, 'IMAGES_NOT_READY', '当前文案还没有可审核的图片');
          if (decision === 'APPROVED' && !subjects.imageSetReady) {
            throw new ApiError(409, 'IMAGES_NOT_READY', '当前文案的完整图片集尚未全部通过图文匹配验收');
          }
        }
        const updated = db.prepare(`
          UPDATE review_task_assignments
          SET version = version + 1, updated_at = ?
          WHERE id = ? AND version = ? AND assignee_user_id = ?
        `).run(createdAt, assignmentId, expectedVersion, resolved.userId);
        if (updated.changes !== 1) throw new ApiError(409, 'VERSION_CONFLICT', '内容质检任务已被转派或更新');
        db.prepare(`
          INSERT INTO review_task_stage_decisions
            (assignment_id, reviewer_user_id, stage, decision, reason_codes_json,
             note, subject_sha256, subject_json, legacy_work_item_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        `).run(
          assignmentId,
          resolved.userId,
          stage,
          decision,
          JSON.stringify([...new Set(reasonCodes)]),
          normalizedNote,
          subject.sha256,
          subject.serialized,
          createdAt,
        );
        insertTaskEvent(assignmentId, resolved, 'STAGE_DECISION_SUBMIT', { stage, decision, reasonCodes });
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
      return buildTaskAssignment(getTaskAssignmentRow(assignmentId));
    },

    authorizeReviewTaskAsset(actor, assignmentId, assetId) {
      const resolved = resolveReviewActor(actor);
      if (!Number.isInteger(assignmentId) || assignmentId < 1) throw new TypeError('assignment id is invalid');
      if (!Number.isInteger(assetId) || assetId < 1) throw new TypeError('asset id is invalid');
      const assignment = buildTaskAssignment(getTaskAssignmentRow(assignmentId));
      if (!assignment) throw new ApiError(404, 'NOT_FOUND', '内容质检任务不存在');
      assertTaskAssignmentVisible(resolved, assignment);
      const row = db.prepare('SELECT * FROM assets WHERE id = ? AND task_id = ?').get(assetId, assignment.taskId);
      const asset = rowToReviewAsset(row);
      if (!asset) throw new ApiError(404, 'NOT_FOUND', '任务图片不存在');
      return { ...asset, relativePath: row.relative_path };
    },

    listReviewTaskEvents(actor, assignmentId) {
      const resolved = resolveReviewActor(actor);
      const assignment = buildTaskAssignment(getTaskAssignmentRow(assignmentId));
      if (!assignment) throw new ApiError(404, 'NOT_FOUND', '内容质检任务不存在');
      assertTaskAssignmentVisible(resolved, assignment);
      return db.prepare(`
        SELECT event.*, user.username AS actor_username, user.display_name AS actor_display_name
        FROM review_task_events event
        LEFT JOIN review_users user ON user.id = event.actor_user_id
        WHERE event.assignment_id = ? ORDER BY event.id
      `).all(assignmentId).map((row) => ({
        id: Number(row.id),
        assignmentId: Number(row.assignment_id),
        actor: row.actor_kind === 'ADMIN'
          ? { subject: 'admin', displayName: '系统管理员' }
          : { subject: 'user', id: Number(row.actor_user_id), username: row.actor_username, displayName: row.actor_display_name },
        action: row.action,
        details: parseJson(row.details_json, {}),
        createdAt: row.created_at,
      }));
    },
  };
}

export { REVIEW_TASK_STAGES };
