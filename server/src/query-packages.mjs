import { createHash, randomUUID } from 'node:crypto';

import {
  ControlPlaneAuthenticationError,
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  normalizeNodeId,
  normalizeTaskId,
  normalizeTaskInput,
  normalizeUuid,
} from './domain.mjs';
import { normalizeListPagination } from './list-pagination.mjs';
import { verifyUserPassword } from './user-auth.mjs';
import {
  assertQueryPackageImportAllowed,
  readWorkflowQualitySettings,
} from './workflow-quality-settings.mjs';

const PACKAGE_ACTIVE_STATUSES = Object.freeze(['IMPORTED', 'SCREENING', 'READY', 'PARTIALLY_USED']);
const QUERY_PACKAGE_INSERT_CHUNK_SIZE = 500;

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function text(value, name, maximum, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || String(value).trim() === '')) return null;
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (!normalized || [...normalized].length > maximum) {
    throw new RangeError(`${name} must contain between 1 and ${maximum} characters`);
  }
  return normalized;
}

function version(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new TypeError('expectedVersion must be a positive integer');
  }
  return normalized;
}

function normalizeActor(actor) {
  if (!actor || !Number.isSafeInteger(Number(actor.userId)) || !['ADMIN', 'REVIEWER', 'USER'].includes(actor.role)) {
    throw new TypeError('authenticated actor is required');
  }
  return { ...actor, userId: Number(actor.userId), username: String(actor.username).toLowerCase() };
}

async function lockActiveQueryPackageActor(client, actor) {
  const credentialVersion = Number(actor.credentialVersion);
  const result = await client.query(`
    SELECT id FROM app_users
    WHERE id = $1 AND username = $2 AND role = $3 AND status = 'ACTIVE'
      AND ($4::integer IS NULL OR credential_version = $4)
    FOR SHARE
  `, [actor.userId, actor.username, actor.role,
    Number.isSafeInteger(credentialVersion) && credentialVersion > 0 ? credentialVersion : null]);
  if (!result.rows[0]) throw new ControlPlaneAuthenticationError();
}

function normalizedImageCount(value) {
  const resolved = value ?? 'auto';
  if (resolved === 'auto') return 'auto';
  if (![3, 4, 5].includes(Number(resolved))) return null;
  return String(Number(resolved));
}

function queryIdentity(value) {
  // Query words are operational identifiers. Whitespace inserted between
  // Chinese characters must not create a second production item.
  return value.replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');
}

export function normalizeQueryPackageItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 5_000) {
    throw new RangeError('items must contain between 1 and 5000 rows');
  }
  const identities = new Set();
  return rawItems.map((rawItem, index) => {
    const item = typeof rawItem === 'string' ? { query: rawItem } : rawItem;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(`items[${index}] must be a string or object`);
    }
    const rawQuery = String(item.query ?? '').replace(/\r\n?/gu, '\n').trim().slice(0, 5_000);
    const errors = [];
    let query = rawQuery;
    if (!query) errors.push('QUERY_EMPTY');
    if ([...query].length > 500) errors.push('QUERY_TOO_LONG');
    let input = {};
    try { input = normalizeTaskInput(item.input ?? {}); } catch { errors.push('INPUT_INVALID'); }
    const imageCount = normalizedImageCount(item.requestedImageCount ?? item.imageCount);
    if (imageCount === null) errors.push('IMAGE_COUNT_INVALID');
    const identity = errors.length ? null : queryIdentity(query);
    const duplicate = identity !== null && identities.has(identity);
    if (identity !== null) identities.add(identity);
    return {
      rowNumber: index + 1,
      externalId: text(item.externalId, `items[${index}].externalId`, 200, { optional: true }),
      rawQuery,
      query: errors.length ? null : query,
      input,
      requestedImageCount: imageCount ?? 'auto',
      status: errors.length ? 'INVALID' : duplicate ? 'DUPLICATE' : 'READY',
      validationErrors: errors.length ? errors : duplicate ? ['DUPLICATE_QUERY'] : [],
      screeningDecision: errors.length || duplicate ? 'REJECTED' : 'PENDING',
    };
  });
}

function packageFrom(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    sourceFileName: row.source_file_name ?? null,
    status: row.status,
    createdByUserId: row.created_by_username,
    createdByAccountId: row.created_by_account_id === null ? null : Number(row.created_by_account_id),
    assignedToUserId: row.assigned_to_username ?? null,
    assignedToAccountId: row.assigned_to_account_id === null ? null : Number(row.assigned_to_account_id),
    assignedToDisplayName: row.assigned_to_display_name ?? null,
    assignedToRole: ['REVIEWER', 'USER'].includes(row.assigned_to_role) ? row.assigned_to_role : null,
    assigneeStatus: ['ACTIVE', 'DISABLED'].includes(row.assignee_status) ? row.assignee_status : null,
    version: Number(row.version),
    counts: {
      total: Number(row.total_count ?? 0),
      pending: Number(row.pending_count ?? 0),
      selected: Number(row.selected_count ?? 0),
      rejected: Number(row.rejected_count ?? 0),
      produced: Number(row.produced_count ?? 0),
      invalid: Number(row.invalid_count ?? 0),
      duplicate: Number(row.duplicate_count ?? 0),
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function packageItemFrom(row) {
  return {
    id: Number(row.id),
    rowNumber: Number(row.row_number),
    externalId: row.external_id ?? null,
    query: row.query ?? row.raw_query,
    input: row.input,
    requestedImageCount: row.requested_image_count === 'auto' ? 'auto' : Number(row.requested_image_count),
    status: row.status,
    validationErrors: row.validation_errors ?? [],
    screeningDecision: row.screening_decision,
    screeningReason: row.screening_reason ?? null,
    taskId: row.task_id === undefined || row.task_id === null ? null : Number(row.task_id),
    version: Number(row.version),
    updatedAt: row.updated_at,
  };
}

function productionBatchFrom(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    publicId: row.public_id,
    queryPackageId: row.query_package_id === null ? null : Number(row.query_package_id),
    queryPackageName: row.query_package_name,
    status: row.status,
    samplingStatus: row.sampling_status,
    taskCount: Number(row.task_count ?? 0),
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertPackageAccess(row, actor) {
  if (actor.role === 'ADMIN') return;
  if (['REVIEWER', 'USER'].includes(actor.role)
      && Number(row.assigned_to_account_id) === actor.userId
      && row.assigned_to_username === actor.username) return;
  throw new ControlPlaneAuthorizationError('当前账号不能操作这个 Query 词包');
}

function assertQueryPackageAdministrator(actor, operation) {
  if (actor.role === 'ADMIN') return;
  throw new ControlPlaneAuthorizationError(`only administrators can ${operation} Query packages`);
}

async function withTransaction(pool, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function lockPackage(client, rawPackageId, actor) {
  const packageId = normalizeTaskId(rawPackageId);
  const result = await client.query('SELECT * FROM query_packages WHERE id = $1 FOR UPDATE', [packageId]);
  const row = result.rows[0];
  if (!row) throw new ControlPlaneNotFoundError('Query 词包不存在');
  assertPackageAccess(row, actor);
  return row;
}

async function lockPackageReadAccess(client, packageId, actor) {
  const result = await client.query(`
    SELECT id, assigned_to_account_id, assigned_to_username
    FROM query_packages WHERE id = $1 FOR SHARE
  `, [packageId]);
  const row = result.rows[0];
  if (!row) throw new ControlPlaneNotFoundError('Query 词包不存在');
  assertPackageAccess(row, actor);
}

async function lockMutationRequest(client, actor, requestId) {
  // The receipt row does not exist on the first attempt, so a unique index by
  // itself cannot serialize two simultaneous first requests.  A transaction
  // advisory lock gives every mutation (including CREATE) a stable lock row
  // before either request checks or writes its receipt.
  await client.query(`
    SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))
  `, [`query-package:${actor.userId}:${actor.username}`, requestId]);
}

async function existingMutation(client, actor, requestId, operation, packageId, fingerprint) {
  const result = await client.query(`
    SELECT * FROM query_package_mutation_requests
    WHERE actor_account_id = $1 AND request_id = $2
  `, [actor.userId, requestId]);
  const row = result.rows[0];
  if (!row) return null;
  const storedPackageId = row.query_package_id === null ? null : Number(row.query_package_id);
  if (row.operation !== operation || (operation !== 'CREATE' && storedPackageId !== packageId)
      || row.request_fingerprint !== fingerprint) {
    throw new ControlPlaneConflictError('REQUEST_ID_CONFLICT', 'requestId 已用于其他词包操作');
  }
  return row.response;
}

async function saveMutation(client, actor, requestId, operation, packageId, fingerprint, response) {
  await client.query(`
    INSERT INTO query_package_mutation_requests(
      actor_account_id, actor_username, request_id, operation, query_package_id,
      request_fingerprint, response
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [actor.userId, actor.username, requestId, operation, packageId, fingerprint, response]);
}

async function insertQueryPackageItems(client, packageId, items) {
  for (let offset = 0; offset < items.length; offset += QUERY_PACKAGE_INSERT_CHUNK_SIZE) {
    const chunk = items.slice(offset, offset + QUERY_PACKAGE_INSERT_CHUNK_SIZE);
    await client.query(`
      INSERT INTO query_package_items(
        query_package_id, row_number, external_id, raw_query, query, input,
        requested_image_count, status, validation_errors, screening_decision
      )
      SELECT $1,
        (source.item ->> 'rowNumber')::integer,
        source.item ->> 'externalId',
        source.item ->> 'rawQuery',
        source.item ->> 'query',
        source.item -> 'input',
        source.item ->> 'requestedImageCount',
        source.item ->> 'status',
        ARRAY(
          SELECT jsonb_array_elements_text(
            COALESCE(source.item -> 'validationErrors', '[]'::jsonb)
          )
        ),
        source.item ->> 'screeningDecision'
      FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS source(item, ordinal)
      ORDER BY source.ordinal
    `, [packageId, JSON.stringify(chunk)]);
  }
}

export async function createQueryPackage(pool, input, rawActor) {
  const actor = normalizeActor(rawActor);
  assertQueryPackageAdministrator(actor, 'create');
  const name = text(input?.name, 'name', 200);
  const sourceFileName = text(input?.sourceFileName, 'sourceFileName', 255, { optional: true });
  const items = normalizeQueryPackageItems(input?.items ?? input?.queries);
  const requestId = normalizeUuid(input?.requestId, 'requestId');
  const requestedAssignee = input?.assignedToUserId === undefined
    ? null : String(input.assignedToUserId).toLowerCase();
  const fingerprint = hashJson({ name, sourceFileName, items, requestedAssignee });
  return withTransaction(pool, async (client) => {
    await lockActiveQueryPackageActor(client, actor);
    await lockMutationRequest(client, actor, requestId);
    const replay = await existingMutation(client, actor, requestId, 'CREATE', null, fingerprint);
    if (replay) return replay;
    assertQueryPackageImportAllowed(actor, await readWorkflowQualitySettings(client));
    // Keep the legacy assignee columns readable for historical packages, but
    // all newly imported packages are unassigned. The deprecated request field
    // remains part of the fingerprint so retries of old client requests retain
    // their idempotency boundary without creating a new ownership dependency.
    const assignedAccountId = null;
    const assignedUsername = null;
    const created = await client.query(`
      INSERT INTO query_packages(
        name, source_file_name, created_by_account_id, created_by_username,
        assigned_to_account_id, assigned_to_username
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [name, sourceFileName, actor.userId, actor.username, assignedAccountId, assignedUsername]);
    await insertQueryPackageItems(client, created.rows[0].id, items);
    const response = { ...packageFrom(created.rows[0]), counts: {
      total: items.length,
      pending: items.filter((item) => item.screeningDecision === 'PENDING').length,
      selected: 0,
      rejected: items.filter((item) => item.screeningDecision === 'REJECTED').length,
      produced: 0,
      invalid: items.filter((item) => item.status === 'INVALID').length,
      duplicate: items.filter((item) => item.status === 'DUPLICATE').length,
    } };
    await saveMutation(client, actor, requestId, 'CREATE', Number(created.rows[0].id), fingerprint, response);
    return response;
  });
}

const PACKAGE_SUMMARY_SQL = `
  SELECT package.*,
    assignee.display_name AS assigned_to_display_name,
    assignee.role AS assigned_to_role,
    assignee.status AS assignee_status,
    COUNT(item.id) AS total_count,
    COUNT(item.id) FILTER (WHERE item.status = 'READY' AND item.screening_decision = 'PENDING') AS pending_count,
    COUNT(item.id) FILTER (WHERE item.screening_decision = 'SELECTED') AS selected_count,
    COUNT(item.id) FILTER (WHERE item.screening_decision = 'REJECTED') AS rejected_count,
    COUNT(item.id) FILTER (WHERE item.status = 'TASK_CREATED') AS produced_count,
    COUNT(item.id) FILTER (WHERE item.status = 'INVALID') AS invalid_count,
    COUNT(item.id) FILTER (WHERE item.status = 'DUPLICATE') AS duplicate_count
  FROM query_packages AS package
  LEFT JOIN app_users AS assignee
    ON assignee.id = package.assigned_to_account_id
    AND assignee.username = package.assigned_to_username
  LEFT JOIN query_package_items AS item ON item.query_package_id = package.id
`;

async function readPackageSummary(database, packageId) {
  const result = await database.query(`${PACKAGE_SUMMARY_SQL}
    WHERE package.id = $1
    GROUP BY package.id, assignee.id
  `, [packageId]);
  if (!result.rows[0]) throw new ControlPlaneNotFoundError('Query 词包不存在');
  return packageFrom(result.rows[0]);
}

async function readPackageLifecycleCounts(database, packageId) {
  const result = await database.query(`
    SELECT
      COUNT(*) FILTER (
        WHERE status = 'READY' AND screening_decision = 'PENDING'
      ) AS pending_count,
      COUNT(*) FILTER (
        WHERE status = 'READY' AND screening_decision = 'SELECTED'
      ) AS selected_count,
      COUNT(*) FILTER (WHERE status = 'TASK_CREATED') AS produced_count
    FROM query_package_items
    WHERE query_package_id = $1
  `, [packageId]);
  return {
    pending: Number(result.rows[0]?.pending_count ?? 0),
    selected: Number(result.rows[0]?.selected_count ?? 0),
    produced: Number(result.rows[0]?.produced_count ?? 0),
  };
}

function packageStatusFromCounts({ pending, selected, produced }) {
  if (pending > 0) return produced > 0 ? 'PARTIALLY_USED' : 'SCREENING';
  if (selected > 0) return produced > 0 ? 'PARTIALLY_USED' : 'READY';
  return produced > 0 ? 'USED_UP' : 'ABANDONED';
}

async function createProductionBatchTasks(client, {
  actor,
  packageRow: current,
  itemIds,
  nodeId,
  requestId,
  requestFingerprint,
}) {
  if (!itemIds.length) return null;
  const packageId = Number(current.id);
  const taskCreatorUsername = current.created_by_account_id === null
    ? null
    : current.created_by_username;
  await client.query(`
    INSERT INTO executor_nodes(id, name, image_worker_enabled, last_seen_at)
    VALUES ($1, $1, false, 'epoch'::timestamptz) ON CONFLICT(id) DO NOTHING
  `, [nodeId]);
  const batch = await client.query(`
    INSERT INTO production_batches(
      public_id, query_package_id, query_package_name, created_by_account_id, created_by_username,
      request_id, request_fingerprint
    ) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
  `, [randomUUID(), packageId, current.name, actor.userId, actor.username, requestId, requestFingerprint]);
  const createdTasks = await client.query(`
    WITH source_items AS MATERIALIZED (
      SELECT item.id, item.query, item.input, item.requested_image_count, item.external_id
      FROM query_package_items AS item
      WHERE item.query_package_id = $1
        AND item.id = ANY($2::bigint[])
        AND item.status = 'READY'
        AND item.screening_decision = 'SELECTED'
      ORDER BY item.id
    ), created_tasks AS (
      INSERT INTO tasks(
        query, input, requested_image_count, created_by_node_id, created_by_user_id,
        assigned_to_user_id, assigned_at, assignment_source,
        source_query_package_id, source_query_package_item_id,
        source_query_package_name, source_query_package_external_id, production_batch_id,
        state, current_stage, progress_message
      )
      SELECT item.query, item.input, item.requested_image_count, $3, $4,
        NULL::varchar, NULL::timestamptz, NULL::varchar,
        $1, item.id, $5, item.external_id, $6,
        'COPY_QUEUED', 'COPY_QUEUED', '等待文案执行机领取'
      FROM source_items AS item
      ORDER BY item.id
      RETURNING id, source_query_package_item_id
    ), created_batch_items AS (
      INSERT INTO production_batch_items(
        production_batch_id, source_query_package_item_id, source_external_id,
        query_snapshot, task_id
      )
      SELECT $6, item.id, item.external_id, item.query, task.id
      FROM created_tasks AS task
      JOIN source_items AS item ON item.id = task.source_query_package_item_id
      ORDER BY item.id
      RETURNING task_id, source_query_package_item_id
    ), updated_items AS (
      UPDATE query_package_items AS item
      SET status = 'TASK_CREATED', version = item.version + 1, updated_at = now()
      FROM created_tasks AS task
      WHERE item.id = task.source_query_package_item_id
      RETURNING item.id
    )
    SELECT batch_item.task_id, batch_item.source_query_package_item_id
    FROM created_batch_items AS batch_item
    JOIN updated_items AS updated ON updated.id = batch_item.source_query_package_item_id
    ORDER BY batch_item.source_query_package_item_id
  `, [packageId, itemIds, nodeId, taskCreatorUsername, current.name, batch.rows[0].id]);
  if (createdTasks.rows.length !== itemIds.length) {
    throw new Error('query package production did not create every selected task');
  }
  const linkedSearches = await client.query(`
    WITH created AS MATERIALIZED (
      SELECT source.task_id, source.source_query_package_item_id
      FROM jsonb_to_recordset($1::jsonb) AS source(
        task_id bigint,
        source_query_package_item_id bigint
      )
    )
    UPDATE xhs_query_search_jobs AS job
    SET task_id = created.task_id, updated_at = now()
    FROM created
    WHERE job.query_package_item_id = created.source_query_package_item_id
    RETURNING job.id
  `, [JSON.stringify(createdTasks.rows)]);
  if (linkedSearches.rows.length !== createdTasks.rows.length) {
    throw new Error('query package production did not bind every task to its Xiaohongshu search');
  }
  const taskIds = createdTasks.rows.map((row) => Number(row.task_id));
  return { ...productionBatchFrom({ ...batch.rows[0], task_count: taskIds.length }), taskIds };
}

export async function listQueryPackages(pool, { limit: rawLimit = 50, offset: rawOffset = 0 } = {}, rawActor) {
  const actor = normalizeActor(rawActor);
  const { limit, offset } = normalizeListPagination(rawLimit, rawOffset);
  const visibility = actor.role === 'ADMIN'
    ? { sql: '', values: [] }
    : {
        sql: 'WHERE package.assigned_to_account_id = $1 AND package.assigned_to_username = $2',
        values: [actor.userId, actor.username],
      };
  const result = await pool.query(`${PACKAGE_SUMMARY_SQL}
    ${visibility.sql}
    GROUP BY package.id, assignee.id
    ORDER BY package.updated_at DESC, package.id DESC
    LIMIT $${visibility.values.length + 1} OFFSET $${visibility.values.length + 2}
  `, [...visibility.values, limit, offset]);
  return result.rows.map(packageFrom);
}

export async function getQueryPackage(pool, rawPackageId, rawActor) {
  const actor = normalizeActor(rawActor);
  const packageId = normalizeTaskId(rawPackageId);
  return withTransaction(pool, async (client) => {
    // Keep the package assignment stable while the complete detail snapshot is
    // assembled. Reassignment then governs every subsequent detail request.
    await lockPackageReadAccess(client, packageId, actor);
    const result = await client.query(`${PACKAGE_SUMMARY_SQL}
      WHERE package.id = $1 GROUP BY package.id, assignee.id
    `, [packageId]);
    if (!result.rows[0]) throw new ControlPlaneNotFoundError('Query 词包不存在');
    const items = await client.query(`
      SELECT item.*, production_item.task_id
      FROM query_package_items AS item
      LEFT JOIN production_batch_items AS production_item
        ON production_item.source_query_package_item_id = item.id
      WHERE item.query_package_id = $1 ORDER BY item.row_number, item.id
    `, [packageId]);
    const batches = await client.query(`
      SELECT batch.*, COUNT(item.id) AS task_count
      FROM production_batches AS batch
      LEFT JOIN production_batch_items AS item ON item.production_batch_id = batch.id
      WHERE batch.query_package_id = $1
      GROUP BY batch.id ORDER BY batch.id DESC
    `, [packageId]);
    return {
      ...packageFrom(result.rows[0]),
      items: items.rows.map(packageItemFrom),
      productionBatches: batches.rows.map(productionBatchFrom),
    };
  });
}

export async function updateQueryPackageScreening(pool, rawPackageId, input, rawActor) {
  const actor = normalizeActor(rawActor);
  const packageId = normalizeTaskId(rawPackageId);
  const expectedVersion = version(input?.expectedVersion);
  const requestId = normalizeUuid(input?.requestId, 'requestId');
  if (!Array.isArray(input?.decisions) || input.decisions.length < 1 || input.decisions.length > 5_000) {
    throw new RangeError('decisions must contain between 1 and 5000 items');
  }
  const decisions = input.decisions.map((entry, index) => {
    const decision = String(entry?.decision ?? '').toUpperCase();
    if (!['SELECT', 'REJECT'].includes(decision)) throw new TypeError(`decisions[${index}].decision is invalid`);
    return {
      itemId: normalizeTaskId(entry.itemId),
      decision: decision === 'SELECT' ? 'SELECTED' : 'REJECTED',
      reason: text(entry.reason, `decisions[${index}].reason`, 500, { optional: true }),
    };
  });
  if (new Set(decisions.map((entry) => entry.itemId)).size !== decisions.length) {
    throw new TypeError('screening item ids must be unique');
  }
  const fingerprint = hashJson({ expectedVersion, decisions });
  return withTransaction(pool, async (client) => {
    await lockActiveQueryPackageActor(client, actor);
    await lockMutationRequest(client, actor, requestId);
    const current = await lockPackage(client, packageId, actor);
    const replay = await existingMutation(client, actor, requestId, 'SCREEN', packageId, fingerprint);
    if (replay) return replay;
    if (!PACKAGE_ACTIVE_STATUSES.includes(current.status)) {
      throw new ControlPlaneConflictError('PACKAGE_NOT_SCREENABLE', '词包已结束，不能继续筛选');
    }
    if (Number(current.version) !== expectedVersion) throw new ControlPlaneConflictError('VERSION_CONFLICT', '词包已被修改');
    const decisionJson = JSON.stringify(decisions);
    // Lock the complete submitted set in one deterministic statement. The
    // package row above serializes screening within a package; ordering the
    // item locks also keeps this safe if that invariant is widened later.
    const lockedItems = await client.query(`
      WITH requested AS MATERIALIZED (
        SELECT (source.entry ->> 'itemId')::bigint AS item_id
        FROM jsonb_array_elements($2::jsonb) AS source(entry)
      )
      SELECT item.id, item.status, item.screening_decision
      FROM requested
      JOIN query_package_items AS item ON item.id = requested.item_id
      WHERE item.query_package_id = $1
      ORDER BY item.id
      FOR UPDATE OF item
    `, [packageId, decisionJson]);
    const lockedById = new Map(lockedItems.rows.map((row) => [Number(row.id), row]));
    const invalid = decisions.find((decision) => lockedById.get(decision.itemId)?.status !== 'READY');
    if (invalid) {
      throw new ControlPlaneConflictError('ITEM_NOT_SCREENABLE', `词包明细 ${invalid.itemId} 不可筛选`);
    }
    const mutations = decisions.map((decision, ordinal) => ({
      ordinal,
      ...decision,
      previousDecision: lockedById.get(decision.itemId).screening_decision,
    }));
    // Re-confirming a historical READY+SELECTED row also migrates it into the
    // automatic production flow. TASK_CREATED rows are rejected by the lock
    // guard above, so a source item can still create at most one task.
    const selectedItemIds = mutations
      .filter((decision) => decision.decision === 'SELECTED')
      .map((decision) => decision.itemId);
    const changed = await client.query(`
      WITH requested AS MATERIALIZED (
        SELECT source.ordinality::integer AS ordinal,
          (source.entry ->> 'itemId')::bigint AS item_id,
          source.entry ->> 'decision' AS decision,
          source.entry ->> 'reason' AS reason,
          source.entry ->> 'previousDecision' AS previous_decision
        FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS source(entry, ordinality)
      ), updated_items AS (
        UPDATE query_package_items AS item
        SET screening_decision = requested.decision,
          screening_reason = requested.reason,
          screened_by_account_id = $3,
          screened_by_username = $4,
          screened_at = now(),
          version = item.version + 1,
          updated_at = now()
        FROM requested
        WHERE item.id = requested.item_id
          AND item.query_package_id = $1
          AND item.status = 'READY'
          AND item.screening_decision = requested.previous_decision
        RETURNING item.id
      ), inserted_events AS (
        INSERT INTO query_package_screening_events(
          query_package_id, query_package_item_id, actor_account_id, actor_username,
          previous_decision, decision, reason, request_id
        )
        SELECT $1, requested.item_id, $3, $4, requested.previous_decision,
          requested.decision, requested.reason, $5
        FROM requested
        JOIN updated_items ON updated_items.id = requested.item_id
        ORDER BY requested.ordinal
        RETURNING id
      ), queued_xhs_searches AS (
        INSERT INTO xhs_query_search_jobs(query_package_item_id, query_snapshot)
        SELECT item.id, item.query
        FROM requested
        JOIN updated_items ON updated_items.id = requested.item_id
        JOIN query_package_items AS item ON item.id = requested.item_id
        WHERE requested.decision = 'SELECTED'
        ORDER BY requested.ordinal
        ON CONFLICT(query_package_item_id) DO UPDATE SET
          query_snapshot = EXCLUDED.query_snapshot,
          status = CASE
            WHEN xhs_query_search_jobs.status = 'CANCELLED' THEN 'PENDING'
            ELSE xhs_query_search_jobs.status
          END,
          attempt_count = CASE
            WHEN xhs_query_search_jobs.status = 'CANCELLED' THEN 0
            ELSE xhs_query_search_jobs.attempt_count
          END,
          claimed_by_node_id = CASE
            WHEN xhs_query_search_jobs.status = 'CANCELLED' THEN NULL
            ELSE xhs_query_search_jobs.claimed_by_node_id
          END,
          lease_token = CASE
            WHEN xhs_query_search_jobs.status = 'CANCELLED' THEN NULL
            ELSE xhs_query_search_jobs.lease_token
          END,
          lease_expires_at = CASE
            WHEN xhs_query_search_jobs.status = 'CANCELLED' THEN NULL
            ELSE xhs_query_search_jobs.lease_expires_at
          END,
          retry_after = CASE
            WHEN xhs_query_search_jobs.status = 'CANCELLED' THEN NULL
            ELSE xhs_query_search_jobs.retry_after
          END,
          blocked_reason = CASE
            WHEN xhs_query_search_jobs.status = 'CANCELLED' THEN NULL
            ELSE xhs_query_search_jobs.blocked_reason
          END,
          error = CASE
            WHEN xhs_query_search_jobs.status = 'CANCELLED' THEN NULL
            ELSE xhs_query_search_jobs.error
          END,
          result_count = CASE
            WHEN xhs_query_search_jobs.status = 'CANCELLED' THEN 0
            ELSE xhs_query_search_jobs.result_count
          END,
          searched_at = CASE
            WHEN xhs_query_search_jobs.status = 'CANCELLED' THEN NULL
            ELSE xhs_query_search_jobs.searched_at
          END,
          updated_at = now()
        RETURNING id
      ), cancelled_xhs_searches AS (
        UPDATE xhs_query_search_jobs AS job
        SET status = 'CANCELLED', claimed_by_node_id = NULL,
          lease_token = NULL, lease_expires_at = NULL, retry_after = NULL,
          blocked_reason = NULL, error = NULL, updated_at = now()
        FROM requested
        JOIN updated_items ON updated_items.id = requested.item_id
        WHERE job.query_package_item_id = requested.item_id
          AND requested.decision = 'REJECTED'
          AND job.status <> 'SUCCEEDED'
        RETURNING job.id
      )
      SELECT
        (SELECT COUNT(*) FROM updated_items) AS updated_count,
        (SELECT COUNT(*) FROM inserted_events) AS event_count,
        (SELECT COUNT(*) FROM queued_xhs_searches) AS queued_xhs_search_count,
        (SELECT COUNT(*) FROM cancelled_xhs_searches) AS cancelled_xhs_search_count
    `, [packageId, JSON.stringify(mutations), actor.userId, actor.username, requestId]);
    if (Number(changed.rows[0]?.updated_count) !== decisions.length
        || Number(changed.rows[0]?.event_count) !== decisions.length) {
      throw new ControlPlaneConflictError('ITEM_NOT_SCREENABLE', '词包明细状态已变化，请刷新后重试');
    }
    if (selectedItemIds.length > 0) {
      await createProductionBatchTasks(client, {
        actor,
        packageRow: current,
        itemIds: selectedItemIds,
        nodeId: normalizeNodeId('web-query-packages'),
        requestId,
        requestFingerprint: hashJson({
          operation: 'SCREEN_AUTO_PRODUCE',
          packageId,
          screeningFingerprint: fingerprint,
          itemIds: selectedItemIds,
        }),
      });
    }
    const nextStatus = packageStatusFromCounts(
      await readPackageLifecycleCounts(client, packageId),
    );
    const updated = await client.query(`
      UPDATE query_packages SET status = $2, version = version + 1, updated_at = now()
      WHERE id = $1 RETURNING *
    `, [packageId, nextStatus]);
    const response = await readPackageSummary(client, updated.rows[0].id);
    await saveMutation(client, actor, requestId, 'SCREEN', packageId, fingerprint, response);
    return response;
  });
}

export async function assignQueryPackage(pool, rawPackageId, input, rawActor) {
  const actor = normalizeActor(rawActor);
  assertQueryPackageAdministrator(actor, 'assign');
  const packageId = normalizeTaskId(rawPackageId);
  const expectedVersion = version(input?.expectedVersion);
  const hasUsername = input !== null && typeof input === 'object'
    && Object.hasOwn(input, 'assignedToUserId');
  const hasAccountId = input !== null && typeof input === 'object'
    && Object.hasOwn(input, 'assignedToAccountId');
  if (!hasUsername || !hasAccountId) {
    throw new TypeError('assignedToUserId and assignedToAccountId are required');
  }
  const unassigned = input.assignedToUserId === null && input.assignedToAccountId === null;
  if (!unassigned && (input.assignedToUserId === null || input.assignedToAccountId === null)) {
    throw new TypeError('assignedToUserId and assignedToAccountId must both be null or both identify an account');
  }
  const username = unassigned
    ? null : text(input.assignedToUserId, 'assignedToUserId', 50).toLowerCase();
  const accountId = unassigned ? null : normalizeTaskId(input.assignedToAccountId);
  return withTransaction(pool, async (client) => {
    await lockActiveQueryPackageActor(client, actor);
    let assignee = null;
    if (!unassigned) {
      const result = await client.query(`
      SELECT id, username FROM app_users
      WHERE id = $1 AND username = $2 AND status = 'ACTIVE'
        AND role IN ('REVIEWER', 'USER')
      FOR SHARE
      `, [accountId, username]);
      assignee = result.rows[0] ?? null;
      if (!assignee) {
        throw new ControlPlaneConflictError('ASSIGNEE_UNAVAILABLE', '指定筛选人员不可用');
      }
    }
    const current = await lockPackage(client, packageId, actor);
    if (Number(current.version) !== expectedVersion) {
      throw new ControlPlaneConflictError('VERSION_CONFLICT', '词包已被修改');
    }
    const updated = await client.query(`
      UPDATE query_packages
      SET assigned_to_account_id = $2, assigned_to_username = $3,
        version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $4
      RETURNING *
    `, [packageId, assignee === null ? null : Number(assignee.id), assignee?.username ?? null, expectedVersion]);
    if (!updated.rows[0]) {
      throw new ControlPlaneConflictError('VERSION_CONFLICT', '词包已被修改');
    }
    return readPackageSummary(client, packageId);
  });
}

export async function createQueryPackageProductionBatch(pool, rawPackageId, input, rawActor) {
  const actor = normalizeActor(rawActor);
  assertQueryPackageAdministrator(actor, 'create production batches for');
  const packageId = normalizeTaskId(rawPackageId);
  const expectedVersion = version(input?.expectedVersion);
  const requestId = normalizeUuid(input?.requestId, 'requestId');
  const nodeId = normalizeNodeId(input?.nodeId ?? 'web-query-packages');
  if (input?.itemIds !== undefined && !Array.isArray(input.itemIds)) {
    throw new TypeError('itemIds must be an array');
  }
  const itemIds = input?.itemIds === undefined
    ? null : [...new Set(input.itemIds.map((itemId) => normalizeTaskId(itemId)))].toSorted((a, b) => a - b);
  if (itemIds !== null && (itemIds.length < 1 || itemIds.length > 5_000)) {
    throw new RangeError('itemIds must contain between 1 and 5000 items');
  }
  const fingerprint = hashJson({ expectedVersion, itemIds, nodeId });
  return withTransaction(pool, async (client) => {
    await lockActiveQueryPackageActor(client, actor);
    await lockMutationRequest(client, actor, requestId);
    const replay = await existingMutation(client, actor, requestId, 'PRODUCE', packageId, fingerprint);
    if (replay) return replay;
    const current = await lockPackage(client, packageId, actor);
    if (!['READY', 'PARTIALLY_USED'].includes(current.status)) {
      throw new ControlPlaneConflictError('PACKAGE_NOT_READY', '必须先完成全部有效明细筛选');
    }
    if (Number(current.version) !== expectedVersion) throw new ControlPlaneConflictError('VERSION_CONFLICT', '词包已被修改');
    const candidates = await client.query(`
      SELECT id FROM query_package_items
      WHERE query_package_id = $1 AND status = 'READY' AND screening_decision = 'SELECTED'
        AND ($2::bigint[] IS NULL OR id = ANY($2::bigint[]))
      ORDER BY id FOR UPDATE
    `, [packageId, itemIds]);
    if (!candidates.rows.length || (itemIds !== null && candidates.rows.length !== itemIds.length)) {
      throw new ControlPlaneConflictError('PRODUCTION_ITEMS_INVALID', '投产明细必须全部是已通过且未投产的词包明细');
    }
    const response = await createProductionBatchTasks(client, {
      actor,
      packageRow: current,
      itemIds: candidates.rows.map((item) => Number(item.id)),
      nodeId,
      requestId,
      requestFingerprint: fingerprint,
    });
    const packageStatus = packageStatusFromCounts(
      await readPackageLifecycleCounts(client, packageId),
    );
    await client.query(`
      UPDATE query_packages SET status = $2, version = version + 1, updated_at = now()
      WHERE id = $1
    `, [packageId, packageStatus]);
    await saveMutation(client, actor, requestId, 'PRODUCE', packageId, fingerprint, response);
    return response;
  });
}

export async function permanentlyDeleteQueryPackage(pool, rawPackageId, input, rawActor) {
  const actor = normalizeActor(rawActor);
  if (actor.role !== 'ADMIN') throw new ControlPlaneAuthorizationError('only administrators can permanently delete Query 词包');
  const packageId = normalizeTaskId(rawPackageId);
  const expectedVersion = version(input?.expectedVersion);
  const requestId = normalizeUuid(input?.requestId, 'requestId');
  const reason = text(input?.reason, 'reason', 500);
  const confirmationName = text(input?.confirmationName, 'confirmationName', 200);
  const fingerprint = hashJson({ expectedVersion, reason, confirmationName });
  return withTransaction(pool, async (client) => {
    await lockActiveQueryPackageActor(client, actor);
    await lockMutationRequest(client, actor, requestId);
    const replay = await existingMutation(client, actor, requestId, 'DELETE', packageId, fingerprint);
    if (replay) return replay;
    const current = await lockPackage(client, packageId, actor);
    if (Number(current.version) !== expectedVersion) throw new ControlPlaneConflictError('VERSION_CONFLICT', '词包已被修改');
    if (!['USED_UP', 'ABANDONED'].includes(current.status)) {
      throw new ControlPlaneConflictError('PACKAGE_MUST_BE_INACTIVE', '仅已用尽或已放弃的词包可永久删除');
    }
    if (confirmationName !== current.name) {
      throw new ControlPlaneConflictError('CONFIRMATION_MISMATCH', '确认名称与词包名称不一致');
    }
    const user = await client.query(`
      SELECT deletion_password_hash FROM app_users
      WHERE id = $1 AND username = $2 AND role = 'ADMIN' AND status = 'ACTIVE'
    `, [actor.userId, actor.username]);
    if (!user.rows[0]?.deletion_password_hash
        || !await verifyUserPassword(input?.deletionPassword, user.rows[0].deletion_password_hash)) {
      throw new ControlPlaneConflictError('DELETION_PASSWORD_INVALID', '删除密码错误或尚未设置');
    }
    const counts = await client.query(`
      SELECT COUNT(*) AS item_count,
        COUNT(DISTINCT production_item.task_id) FILTER (WHERE production_item.task_id IS NOT NULL) AS task_count
      FROM query_package_items AS item
      LEFT JOIN production_batch_items AS production_item
        ON production_item.source_query_package_item_id = item.id
      WHERE item.query_package_id = $1
    `, [packageId]);
    const response = { id: packageId, permanentlyDeleted: true,
      detachedTaskCount: Number(counts.rows[0].task_count) };
    // Remove prior mutation snapshots (including the import response) so true
    // deletion does not retain the package name, filename, Query or input.
    await client.query(`
      DELETE FROM query_package_mutation_requests WHERE query_package_id = $1
    `, [packageId]);
    // Save only the content-free deletion receipt for safe network retries.
    await saveMutation(client, actor, requestId, 'DELETE', packageId, fingerprint, response);
    // Search rows bound to produced tasks are durable delivery history. Remove
    // only taskless searches before the package cascade clears their item key.
    await client.query(`
      DELETE FROM xhs_query_search_jobs AS job
      USING query_package_items AS item
      WHERE item.id = job.query_package_item_id
        AND item.query_package_id = $1
        AND job.task_id IS NULL
    `, [packageId]);
    await client.query('DELETE FROM query_packages WHERE id = $1', [packageId]);
    await client.query(`
      INSERT INTO query_package_deletion_audits(
        deleted_query_package_id, deleted_item_count, detached_task_count,
        actor_account_id, actor_username, reason, request_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [packageId, Number(counts.rows[0].item_count), response.detachedTaskCount,
      actor.userId, actor.username, reason, requestId]);
    return response;
  });
}

export async function abandonQueryPackage(pool, rawPackageId, input, rawActor) {
  const actor = normalizeActor(rawActor);
  if (actor.role !== 'ADMIN') throw new ControlPlaneAuthorizationError('only administrators can abandon Query 词包');
  const packageId = normalizeTaskId(rawPackageId);
  const expectedVersion = version(input?.expectedVersion);
  const requestId = normalizeUuid(input?.requestId, 'requestId');
  const reason = text(input?.reason, 'reason', 500);
  const fingerprint = hashJson({ expectedVersion, reason });
  return withTransaction(pool, async (client) => {
    await lockActiveQueryPackageActor(client, actor);
    await lockMutationRequest(client, actor, requestId);
    const replay = await existingMutation(client, actor, requestId, 'ABANDON', packageId, fingerprint);
    if (replay) return replay;
    const current = await lockPackage(client, packageId, actor);
    if (Number(current.version) !== expectedVersion) {
      throw new ControlPlaneConflictError('VERSION_CONFLICT', '词包已被修改');
    }
    if (['USED_UP', 'ABANDONED'].includes(current.status)) {
      throw new ControlPlaneConflictError('PACKAGE_ALREADY_INACTIVE', '词包已经结束');
    }
    const updated = await client.query(`
      UPDATE query_packages SET status = 'ABANDONED', version = version + 1, updated_at = now()
      WHERE id = $1 RETURNING *
    `, [packageId]);
    await client.query(`
      UPDATE xhs_query_search_jobs AS job
      SET status = 'CANCELLED', claimed_by_node_id = NULL,
        lease_token = NULL, lease_expires_at = NULL, retry_after = NULL,
        blocked_reason = NULL, error = NULL, updated_at = now()
      FROM query_package_items AS item
      WHERE item.id = job.query_package_item_id
        AND item.query_package_id = $1
        AND job.task_id IS NULL
        AND job.status NOT IN ('SUCCEEDED', 'CANCELLED')
    `, [packageId]);
    const response = await readPackageSummary(client, updated.rows[0].id);
    await saveMutation(client, actor, requestId, 'ABANDON', packageId, fingerprint, response);
    await client.query(`
      INSERT INTO query_package_lifecycle_audits(
        query_package_id, action, actor_account_id, actor_username, reason, request_id
      ) VALUES ($1, 'ABANDON', $2, $3, $4, $5)
    `, [packageId, actor.userId, actor.username, reason, requestId]);
    return response;
  });
}

export async function previewPermanentQueryPackageDeletion(pool, rawPackageId, rawActor) {
  const actor = normalizeActor(rawActor);
  if (actor.role !== 'ADMIN') {
    throw new ControlPlaneAuthorizationError('only administrators can preview permanent Query package deletion');
  }
  const packageId = normalizeTaskId(rawPackageId);
  const result = await pool.query(`
    SELECT package.id, package.name, package.status, package.version,
      COALESCE(item_summary.item_count, 0) AS item_count,
      COALESCE(item_summary.detached_task_count, 0) AS detached_task_count,
      COALESCE(batch_summary.production_batch_count, 0) AS production_batch_count
    FROM query_packages AS package
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS item_count,
        COUNT(DISTINCT production_item.task_id)
          FILTER (WHERE production_item.task_id IS NOT NULL) AS detached_task_count
      FROM query_package_items AS item
      LEFT JOIN production_batch_items AS production_item
        ON production_item.source_query_package_item_id = item.id
      WHERE item.query_package_id = package.id
    ) AS item_summary ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS production_batch_count
      FROM production_batches AS batch
      WHERE batch.query_package_id = package.id
    ) AS batch_summary ON true
    WHERE package.id = $1
  `, [packageId]);
  const row = result.rows[0];
  if (!row) throw new ControlPlaneNotFoundError('Query 词包不存在');
  return {
    id: Number(row.id),
    name: row.name,
    status: row.status,
    version: Number(row.version),
    eligible: ['USED_UP', 'ABANDONED'].includes(row.status),
    itemCount: Number(row.item_count ?? 0),
    detachedTaskCount: Number(row.detached_task_count ?? 0),
    productionBatchCount: Number(row.production_batch_count ?? 0),
    tasksWillBeDeleted: false,
  };
}
