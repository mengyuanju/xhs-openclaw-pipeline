import { createHash } from 'node:crypto';

import { REVIEW_ACCOUNT_ROLES } from './auth.mjs';
import { ApiError } from './http.mjs';
import {
  createReviewTaskStore,
  initializeReviewTaskSchema,
  REVIEW_TASK_STAGES,
} from './review-task-store.mjs';

const REVIEW_TYPES = Object.freeze(['QUERY', 'COPY']);
const REVIEW_STATUSES = Object.freeze([
  'OPEN',
  'IN_REVIEW',
  'APPROVED',
  'REJECTED',
  'STALE',
  'CANCELLED',
]);

function nowIso() {
  return new Date().toISOString();
}

function requiredText(value, name, maxLength) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} cannot be empty`);
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if ([...normalized].length > maxLength) throw new RangeError(`${name} cannot exceed ${maxLength} characters`);
  return normalized;
}

function normalizedUsername(value) {
  const username = requiredText(value, 'username', 50).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,49}$/u.test(username)) {
    throw new TypeError('username must contain 3 to 50 lowercase letters, numbers, dots, underscores or hyphens');
  }
  return username;
}

function normalizedRoles(value) {
  if (!Array.isArray(value) || value.length < 1) throw new TypeError('roles cannot be empty');
  const roles = [...new Set(value)];
  if (roles.some((role) => !REVIEW_ACCOUNT_ROLES.includes(role))) {
    throw new TypeError('review user role is invalid');
  }
  return roles.sort((left, right) => REVIEW_ACCOUNT_ROLES.indexOf(left) - REVIEW_ACCOUNT_ROLES.indexOf(right));
}

function parseJson(value, fallback) {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    username: row.username,
    displayName: row.display_name,
    roles: parseJson(row.roles_json, []),
    status: row.status,
    credentialVersion: Number(row.credential_version),
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

function rowToDecision(row) {
  if (row.decision_id === null || row.decision_id === undefined) return null;
  return {
    id: Number(row.decision_id),
    decision: row.decision_value,
    reasonCodes: parseJson(row.decision_reason_codes_json, []),
    note: row.decision_note,
    subjectSha256: row.decision_subject_sha256,
    reviewer: aliasedUser(row, 'reviewer'),
    createdAt: row.decision_created_at,
  };
}

function rowToWorkItem(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    reviewType: row.review_type,
    importBatchId: Number(row.import_batch_id),
    importRowId: row.import_row_id === null ? null : Number(row.import_row_id),
    taskId: row.task_id === null ? null : Number(row.task_id),
    textRevisionId: row.text_revision_id === null ? null : Number(row.text_revision_id),
    subjectSha256: row.subject_sha256,
    subject: parseJson(row.subject_json, {}),
    status: row.status,
    assignee: aliasedUser(row, 'assignee'),
    priority: Number(row.priority),
    version: Number(row.version),
    assignedAt: row.assigned_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decision: rowToDecision(row),
  };
}

function actorEventFields(actor) {
  return actor.subject === 'admin'
    ? ['ADMIN', null]
    : ['USER', actor.userId];
}

function reviewerTypes(actor) {
  const types = [];
  if (actor.roles.includes('QUERY_REVIEWER')) types.push('QUERY');
  if (actor.roles.includes('COPY_REVIEWER')) types.push('COPY');
  return types;
}

function isManager(actor) {
  return actor.roles.includes('ADMIN') || actor.roles.includes('QC_LEAD');
}

function assertAdmin(actor) {
  if (actor?.subject !== 'admin' || !actor?.roles?.includes('ADMIN')) {
    throw new ApiError(403, 'FORBIDDEN', '仅系统管理员可以执行此操作');
  }
}

export function initializeReviewWorkSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      roles_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
      credential_version INTEGER NOT NULL DEFAULT 1 CHECK (credential_version > 0),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS review_users_status_idx ON review_users(status, id);

    CREATE TABLE IF NOT EXISTS review_work_items (
      id INTEGER PRIMARY KEY,
      review_type TEXT NOT NULL CHECK (review_type IN ('QUERY', 'COPY')),
      import_batch_id INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
      import_row_id INTEGER REFERENCES import_rows(id) ON DELETE CASCADE,
      task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      text_revision_id INTEGER REFERENCES text_revisions(id) ON DELETE CASCADE,
      dedupe_key TEXT NOT NULL UNIQUE,
      subject_sha256 TEXT NOT NULL,
      subject_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN'
        CHECK (status IN ('OPEN', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'STALE', 'CANCELLED')),
      assignee_user_id INTEGER REFERENCES review_users(id) ON DELETE RESTRICT,
      priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      assigned_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (review_type = 'QUERY' AND import_row_id IS NOT NULL AND task_id IS NULL AND text_revision_id IS NULL)
        OR
        (review_type = 'COPY' AND import_row_id IS NULL AND task_id IS NOT NULL AND text_revision_id IS NOT NULL)
      )
    ) STRICT;
    CREATE INDEX IF NOT EXISTS review_work_items_queue_idx
      ON review_work_items(review_type, status, assignee_user_id, priority DESC, id);
    CREATE INDEX IF NOT EXISTS review_work_items_batch_idx
      ON review_work_items(import_batch_id, review_type, id);

    CREATE TABLE IF NOT EXISTS review_decisions (
      id INTEGER PRIMARY KEY,
      work_item_id INTEGER NOT NULL REFERENCES review_work_items(id) ON DELETE CASCADE,
      reviewer_user_id INTEGER NOT NULL REFERENCES review_users(id) ON DELETE RESTRICT,
      decision TEXT NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
      reason_codes_json TEXT NOT NULL DEFAULT '[]',
      note TEXT NOT NULL DEFAULT '',
      subject_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS review_decisions_item_idx ON review_decisions(work_item_id, id DESC);

    CREATE TABLE IF NOT EXISTS review_events (
      id INTEGER PRIMARY KEY,
      work_item_id INTEGER NOT NULL REFERENCES review_work_items(id) ON DELETE CASCADE,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('ADMIN', 'USER')),
      actor_user_id INTEGER REFERENCES review_users(id) ON DELETE RESTRICT,
      action TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      CHECK ((actor_kind = 'ADMIN' AND actor_user_id IS NULL) OR (actor_kind = 'USER' AND actor_user_id IS NOT NULL))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS review_events_item_idx ON review_events(work_item_id, id);

  `);
  initializeReviewTaskSchema(db);
}

export function createReviewWorkStore(db) {
  const getUserRow = db.prepare('SELECT * FROM review_users WHERE id = ?');
  const workItemSelect = `
    SELECT wi.*,
           assignee.id AS assignee_id,
           assignee.username AS assignee_username,
           assignee.display_name AS assignee_display_name,
           decision.id AS decision_id,
           decision.decision AS decision_value,
           decision.reason_codes_json AS decision_reason_codes_json,
           decision.note AS decision_note,
           decision.subject_sha256 AS decision_subject_sha256,
           decision.created_at AS decision_created_at,
           reviewer.id AS reviewer_id,
           reviewer.username AS reviewer_username,
           reviewer.display_name AS reviewer_display_name
    FROM review_work_items wi
    LEFT JOIN review_users assignee ON assignee.id = wi.assignee_user_id
    LEFT JOIN review_decisions decision ON decision.id = (
      SELECT candidate.id FROM review_decisions candidate
      WHERE candidate.work_item_id = wi.id ORDER BY candidate.id DESC LIMIT 1
    )
    LEFT JOIN review_users reviewer ON reviewer.id = decision.reviewer_user_id
  `;
  function getWorkItem(id) {
    return rowToWorkItem(db.prepare(`${workItemSelect} WHERE wi.id = ?`).get(id));
  }

  function insertEvent(workItemId, actor, action, details = {}) {
    const [actorKind, actorUserId] = actorEventFields(actor);
    db.prepare(`
      INSERT INTO review_events
        (work_item_id, actor_kind, actor_user_id, action, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(workItemId, actorKind, actorUserId, action, JSON.stringify(details), nowIso());
  }

  function resolveReviewActor(actor) {
    if (actor?.subject === 'admin' && actor?.roles?.includes('ADMIN')) {
      return { subject: 'admin', roles: ['ADMIN'] };
    }
    if (actor?.subject !== 'user' || !Number.isInteger(actor.userId) || actor.userId < 1) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Please sign in to continue');
    }
    const user = publicUser(getUserRow.get(actor.userId));
    if (!user || user.status !== 'ACTIVE'
      || user.username !== actor.username
      || user.credentialVersion !== actor.credentialVersion) {
      throw new ApiError(401, 'SESSION_STALE', '账号状态已变化，请重新登录');
    }
    return { ...user, subject: 'user', userId: user.id };
  }

  function assertCanReview(actor, reviewType) {
    if (actor.subject !== 'user' || !reviewerTypes(actor).includes(reviewType)) {
      throw new ApiError(403, 'FORBIDDEN', '当前账号没有该类型的质检权限');
    }
  }

  function assertVisible(actor, item) {
    if (isManager(actor)) return;
    assertCanReview(actor, item.reviewType);
    if (item.assignee?.id === actor.userId) return;
    if (item.status === 'OPEN' && item.assignee === null) return;
    throw new ApiError(403, 'FORBIDDEN', '该质检作业未分配给当前账号');
  }

  const reviewTaskStore = createReviewTaskStore(db, {
    resolveReviewActor,
    isManager,
    assertCanReview,
    getReviewUser: (id) => publicUser(getUserRow.get(id)),
  });

  return {
    ...reviewTaskStore,
    resolveReviewActor,

    findReviewUserForLogin(rawUsername) {
      let username;
      try {
        username = normalizedUsername(rawUsername);
      } catch {
        return null;
      }
      const row = db.prepare(`
        SELECT * FROM review_users WHERE username = ? COLLATE NOCASE AND status = 'ACTIVE'
      `).get(username);
      if (!row) return null;
      return { ...publicUser(row), passwordHash: row.password_hash };
    },

    listReviewUsers(actor, { status, page = 1, pageSize = 100 } = {}) {
      const resolved = resolveReviewActor(actor);
      if (!resolved.roles.includes('ADMIN') && !resolved.roles.includes('QC_LEAD')) {
        throw new ApiError(403, 'FORBIDDEN', '没有人员列表权限');
      }
      if (status !== undefined && !['ACTIVE', 'DISABLED'].includes(status)) {
        throw new TypeError('review user status is invalid');
      }
      const pagination = normalizedPagination(page, pageSize);
      const totalItems = Number((status
        ? db.prepare('SELECT COUNT(*) AS count FROM review_users WHERE status = ?').get(status)
        : db.prepare('SELECT COUNT(*) AS count FROM review_users').get()).count);
      const rows = status
        ? db.prepare('SELECT * FROM review_users WHERE status = ? ORDER BY id LIMIT ? OFFSET ?')
          .all(status, pagination.pageSize, (pagination.page - 1) * pagination.pageSize)
        : db.prepare('SELECT * FROM review_users ORDER BY id LIMIT ? OFFSET ?')
          .all(pagination.pageSize, (pagination.page - 1) * pagination.pageSize);
      return paginationResult(rows.map(publicUser), pagination, totalItems);
    },

    createReviewUser(actor, input) {
      assertAdmin(actor);
      const username = normalizedUsername(input?.username);
      const displayName = requiredText(input?.displayName, 'display name', 80);
      const roles = normalizedRoles(input?.roles);
      const passwordHash = requiredText(input?.passwordHash, 'password hash', 500);
      if (!/^scrypt-v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(passwordHash)) {
        throw new TypeError('password hash is invalid');
      }
      const createdAt = nowIso();
      try {
        const result = db.prepare(`
          INSERT INTO review_users
            (username, display_name, password_hash, roles_json, status, credential_version, version, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'ACTIVE', 1, 1, ?, ?)
          RETURNING id
        `).get(username, displayName, passwordHash, JSON.stringify(roles), createdAt, createdAt);
        return publicUser(getUserRow.get(result.id));
      } catch (error) {
        if (String(error?.message).includes('UNIQUE constraint failed')) {
          throw new ApiError(409, 'USERNAME_EXISTS', '用户名已经存在');
        }
        throw error;
      }
    },

    updateReviewUser(actor, userId, input) {
      assertAdmin(actor);
      if (!Number.isInteger(userId) || userId < 1) throw new TypeError('review user id is invalid');
      const current = publicUser(getUserRow.get(userId));
      if (!current) throw new ApiError(404, 'NOT_FOUND', '质检人员不存在');
      if (!Number.isInteger(input?.expectedVersion) || input.expectedVersion < 1) {
        throw new TypeError('expected version is invalid');
      }
      const displayName = requiredText(input?.displayName, 'display name', 80);
      const roles = normalizedRoles(input?.roles);
      if (!['ACTIVE', 'DISABLED'].includes(input?.status)) throw new TypeError('review user status is invalid');
      const credentialChanged = input.status !== current.status
        || JSON.stringify(roles) !== JSON.stringify(current.roles);
      const result = db.prepare(`
        UPDATE review_users
        SET display_name = ?, roles_json = ?, status = ?,
            credential_version = credential_version + ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(
        displayName,
        JSON.stringify(roles),
        input.status,
        credentialChanged ? 1 : 0,
        nowIso(),
        userId,
        input.expectedVersion,
      );
      if (result.changes !== 1) throw new ApiError(409, 'VERSION_CONFLICT', '人员信息已被其他操作更新');
      return publicUser(getUserRow.get(userId));
    },

    seedReviewWorkItems(actor, { reviewType, importBatchId }) {
      const resolved = resolveReviewActor(actor);
      if (!isManager(resolved)) throw new ApiError(403, 'FORBIDDEN', '没有生成质检作业权限');
      if (!REVIEW_TYPES.includes(reviewType)) throw new TypeError('review type is invalid');
      if (!Number.isInteger(importBatchId) || importBatchId < 1) throw new TypeError('import batch id is invalid');
      const batch = db.prepare('SELECT id FROM import_batches WHERE id = ?').get(importBatchId);
      if (!batch) throw new ApiError(404, 'NOT_FOUND', '导入批次不存在');

      const candidates = reviewType === 'QUERY'
        ? db.prepare(`
          SELECT id AS import_row_id, row_number, external_id, query, input_json,
                 demand_level, screening_reason, screening_source
          FROM import_rows WHERE batch_id = ? AND is_valid = 1 ORDER BY row_number
        `).all(importBatchId).map((row) => ({
          importRowId: Number(row.import_row_id),
          taskId: null,
          textRevisionId: null,
          subject: {
            kind: 'QUERY',
            importRowId: Number(row.import_row_id),
            rowNumber: Number(row.row_number),
            externalId: row.external_id,
            query: row.query,
            input: parseJson(row.input_json, {}),
            demandLevel: row.demand_level,
            screeningReason: row.screening_reason,
            screeningSource: row.screening_source,
          },
        }))
        : db.prepare(`
          SELECT t.id AS task_id, t.query, tc.external_id, tc.current_text_revision_id,
                 tr.title, tr.body, tr.tags_json
          FROM tasks t
          JOIN task_configs tc ON tc.task_id = t.id
          JOIN text_revisions tr ON tr.id = tc.current_text_revision_id
          WHERE tc.import_batch_id = ? ORDER BY t.id
        `).all(importBatchId).map((row) => ({
          importRowId: null,
          taskId: Number(row.task_id),
          textRevisionId: Number(row.current_text_revision_id),
          subject: {
            kind: 'COPY',
            taskId: Number(row.task_id),
            textRevisionId: Number(row.current_text_revision_id),
            externalId: row.external_id,
            query: row.query,
            title: row.title,
            body: row.body,
            tags: parseJson(row.tags_json, []),
          },
        }));

      let createdItems = 0;
      let existingItems = 0;
      const createdAt = nowIso();
      db.exec('BEGIN IMMEDIATE');
      try {
        const insert = db.prepare(`
          INSERT OR IGNORE INTO review_work_items
            (review_type, import_batch_id, import_row_id, task_id, text_revision_id,
             dedupe_key, subject_sha256, subject_json, status, priority, version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', 0, 1, ?, ?)
        `);
        for (const candidate of candidates) {
          const subject = subjectRecord(candidate.subject);
          const sourceKey = reviewType === 'QUERY'
            ? `IMPORT_ROW:${candidate.importRowId}`
            : `TEXT_REVISION:${candidate.textRevisionId}`;
          const result = insert.run(
            reviewType,
            importBatchId,
            candidate.importRowId,
            candidate.taskId,
            candidate.textRevisionId,
            `${reviewType}:${sourceKey}:${subject.sha256}`,
            subject.sha256,
            subject.serialized,
            createdAt,
            createdAt,
          );
          if (result.changes === 1) {
            createdItems += 1;
            insertEvent(Number(result.lastInsertRowid), resolved, 'WORK_ITEM_CREATE', { reviewType });
          } else {
            existingItems += 1;
          }
        }
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
      return { createdItems, existingItems };
    },

    listReviewWorkItems(actor, filters = {}) {
      const resolved = resolveReviewActor(actor);
      const pagination = normalizedPagination(filters.page, filters.pageSize);
      const clauses = [];
      const parameters = [];
      if (!isManager(resolved)) {
        const types = reviewerTypes(resolved);
        if (types.length === 0) throw new ApiError(403, 'FORBIDDEN', '当前账号没有质检权限');
        clauses.push(`wi.review_type IN (${types.map(() => '?').join(', ')})`);
        parameters.push(...types);
        clauses.push("(wi.assignee_user_id = ? OR (wi.assignee_user_id IS NULL AND wi.status = 'OPEN'))");
        parameters.push(resolved.userId);
      }
      if (filters.reviewType) {
        if (!REVIEW_TYPES.includes(filters.reviewType)) throw new TypeError('review type is invalid');
        if (!isManager(resolved) && !reviewerTypes(resolved).includes(filters.reviewType)) {
          throw new ApiError(403, 'FORBIDDEN', '当前账号没有该类型的质检权限');
        }
        clauses.push('wi.review_type = ?');
        parameters.push(filters.reviewType);
      }
      if (filters.status) {
        if (!REVIEW_STATUSES.includes(filters.status)) throw new TypeError('review status is invalid');
        clauses.push('wi.status = ?');
        parameters.push(filters.status);
      }
      if (filters.importBatchId !== undefined && filters.importBatchId !== '') {
        const batchId = Number(filters.importBatchId);
        if (!Number.isInteger(batchId) || batchId < 1) throw new TypeError('import batch id is invalid');
        clauses.push('wi.import_batch_id = ?');
        parameters.push(batchId);
      }
      if (filters.assigneeUserId !== undefined && filters.assigneeUserId !== '') {
        if (!isManager(resolved)) throw new ApiError(403, 'FORBIDDEN', '没有按人员筛选权限');
        const assigneeUserId = Number(filters.assigneeUserId);
        if (!Number.isInteger(assigneeUserId) || assigneeUserId < 1) throw new TypeError('assignee user id is invalid');
        clauses.push('wi.assignee_user_id = ?');
        parameters.push(assigneeUserId);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const totalItems = Number(db.prepare(`
        SELECT COUNT(*) AS count FROM review_work_items wi ${where}
      `).get(...parameters).count);
      const rows = db.prepare(`
        ${workItemSelect}
        ${where}
        ORDER BY wi.priority DESC, wi.id ASC LIMIT ? OFFSET ?
      `).all(...parameters, pagination.pageSize, (pagination.page - 1) * pagination.pageSize);
      return paginationResult(rows.map(rowToWorkItem), pagination, totalItems);
    },

    getReviewWorkItem(actor, workItemId) {
      const resolved = resolveReviewActor(actor);
      if (!Number.isInteger(workItemId) || workItemId < 1) throw new TypeError('work item id is invalid');
      const item = getWorkItem(workItemId);
      if (!item) throw new ApiError(404, 'NOT_FOUND', '质检作业不存在');
      assertVisible(resolved, item);
      return item;
    },

    assignReviewWorkItem(actor, workItemId, { assigneeUserId, expectedVersion }) {
      const resolved = resolveReviewActor(actor);
      if (!isManager(resolved)) throw new ApiError(403, 'FORBIDDEN', '没有派单权限');
      if (!Number.isInteger(workItemId) || workItemId < 1) throw new TypeError('work item id is invalid');
      if (!Number.isInteger(assigneeUserId) || assigneeUserId < 1) throw new TypeError('assignee user id is invalid');
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new TypeError('expected version is invalid');
      const assignee = publicUser(getUserRow.get(assigneeUserId));
      if (!assignee || assignee.status !== 'ACTIVE') throw new ApiError(422, 'ASSIGNEE_UNAVAILABLE', '被分配人员不可用');
      const current = getWorkItem(workItemId);
      if (!current) throw new ApiError(404, 'NOT_FOUND', '质检作业不存在');
      if (!reviewerTypes({ roles: assignee.roles }).includes(current.reviewType)) {
        throw new ApiError(422, 'ROLE_MISMATCH', '被分配人员没有该类型的质检角色');
      }
      if (!['OPEN', 'IN_REVIEW'].includes(current.status)) {
        throw new ApiError(409, 'WORK_ITEM_CLOSED', '已完成的质检作业不能重新分配');
      }
      const updatedAt = nowIso();
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = db.prepare(`
          UPDATE review_work_items
          SET assignee_user_id = ?, status = 'IN_REVIEW', assigned_at = ?,
              version = version + 1, updated_at = ?
          WHERE id = ? AND version = ? AND status IN ('OPEN', 'IN_REVIEW')
        `).run(assigneeUserId, updatedAt, updatedAt, workItemId, expectedVersion);
        if (result.changes !== 1) throw new ApiError(409, 'VERSION_CONFLICT', '质检作业已被其他操作更新');
        insertEvent(workItemId, resolved, 'ASSIGNMENT_SET', { assigneeUserId });
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
      return getWorkItem(workItemId);
    },

    claimReviewWorkItem(actor, workItemId, { expectedVersion }) {
      const resolved = resolveReviewActor(actor);
      if (resolved.subject !== 'user') throw new ApiError(403, 'FORBIDDEN', '管理员不能领取质检作业');
      if (!Number.isInteger(workItemId) || workItemId < 1) throw new TypeError('work item id is invalid');
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new TypeError('expected version is invalid');
      const current = getWorkItem(workItemId);
      if (!current) throw new ApiError(404, 'NOT_FOUND', '质检作业不存在');
      assertCanReview(resolved, current.reviewType);
      const updatedAt = nowIso();
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = db.prepare(`
          UPDATE review_work_items
          SET assignee_user_id = ?, status = 'IN_REVIEW', assigned_at = ?,
              version = version + 1, updated_at = ?
          WHERE id = ? AND version = ? AND status = 'OPEN' AND assignee_user_id IS NULL
        `).run(resolved.userId, updatedAt, updatedAt, workItemId, expectedVersion);
        if (result.changes !== 1) throw new ApiError(409, 'CLAIM_CONFLICT', '质检作业已经被领取或更新');
        insertEvent(workItemId, resolved, 'WORK_ITEM_CLAIM', {});
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
      return getWorkItem(workItemId);
    },

    decideReviewWorkItem(actor, workItemId, { decision, reasonCodes = [], note = '', expectedVersion }) {
      const resolved = resolveReviewActor(actor);
      if (resolved.subject !== 'user') throw new ApiError(403, 'FORBIDDEN', '管理员不能代替质检员提交结论');
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
      const current = getWorkItem(workItemId);
      if (!current) throw new ApiError(404, 'NOT_FOUND', '质检作业不存在');
      assertCanReview(resolved, current.reviewType);
      if (current.assignee?.id !== resolved.userId) {
        throw new ApiError(403, 'FORBIDDEN', '只有当前审核人可以提交结论');
      }
      const completedAt = nowIso();
      db.exec('BEGIN IMMEDIATE');
      try {
        const updated = db.prepare(`
          UPDATE review_work_items
          SET status = ?, completed_at = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ? AND status = 'IN_REVIEW' AND assignee_user_id = ?
        `).run(decision, completedAt, completedAt, workItemId, expectedVersion, resolved.userId);
        if (updated.changes !== 1) throw new ApiError(409, 'VERSION_CONFLICT', '质检作业已经完成或被其他操作更新');
        db.prepare(`
          INSERT INTO review_decisions
            (work_item_id, reviewer_user_id, decision, reason_codes_json, note, subject_sha256, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          workItemId,
          resolved.userId,
          decision,
          JSON.stringify([...new Set(reasonCodes)]),
          normalizedNote,
          current.subjectSha256,
          completedAt,
        );
        insertEvent(workItemId, resolved, 'DECISION_SUBMIT', { decision, reasonCodes });
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
      return getWorkItem(workItemId);
    },

    listReviewEvents(actor, workItemId) {
      const resolved = resolveReviewActor(actor);
      const item = getWorkItem(workItemId);
      if (!item) throw new ApiError(404, 'NOT_FOUND', '质检作业不存在');
      assertVisible(resolved, item);
      return db.prepare(`
        SELECT event.*, user.username AS actor_username, user.display_name AS actor_display_name
        FROM review_events event
        LEFT JOIN review_users user ON user.id = event.actor_user_id
        WHERE event.work_item_id = ? ORDER BY event.id
      `).all(workItemId).map((row) => ({
        id: Number(row.id),
        workItemId: Number(row.work_item_id),
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

export { REVIEW_STATUSES, REVIEW_TASK_STAGES, REVIEW_TYPES };
