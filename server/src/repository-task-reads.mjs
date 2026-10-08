import { hydrateExecutionSnapshots } from './execution-snapshot-storage.mjs';
import {
  CURRENT_COPY_CONTEXT_SQL,
  ControlPlaneNotFoundError,
  TASK_HISTORY_TYPES,
  TASK_LATEST_ACTIVITY_SQL,
  TASK_LIST_COLUMNS_SQL,
  TASK_PAGE_KEYS_SQL,
  TASK_PAGE_SUMMARY_SQL,
  TASK_QUERY_COVER_BYTES_SQL,
  USER_ROLES,
  activeBlindQaSql,
  copyReworkChanges,
  createHash,
  executionFrom,
  findCopyReworkBaseline,
  imagePlanRegenerationFrom,
  imageQaReturnFrom,
  imageRunFrom,
  integerOption,
  latestImageRetryFailures,
  normalizeAssigneeUserId,
  normalizeCreatorUserId,
  normalizeNodeId,
  normalizePriorityMode,
  normalizeTaskAttention,
  normalizeTaskCreatorRole,
  normalizeTaskDateRange,
  normalizeTaskId,
  normalizeUuid,
  normalizedCompletionBoundary,
  normalizedHistoryCursor,
  normalizedQueryPackageNameFilter,
  normalizedTaskPageCursor,
  normalizedTaskQuery,
  normalizedTaskSort,
  normalizedTaskStates,
  normalizedUsername,
  personalTaskCompletionFrom,
  qualityAssessmentFrom,
  readSecondaryAssignmentFeedback,
  readTaskTotal,
  revisionFrom,
  savedTaskViewFrom,
  taskAssetFrom,
  taskCursorPredicate,
  taskFrom,
  taskHistoryId,
  taskHistoryMetadata,
  taskHistoryType,
  taskPageCursor,
  taskQueryIdentitySql,
  taskSortOrder
} from './repository-context.mjs';

/** TaskRead operations; inherited methods preserve the public repository API. */
export class TaskReadRepository {
  async listTasks({
    taskIds = null,
    state = null,
    states = null,
    nodeId = null,
    createdByUserId = null,
    createdByAccountId = null,
    assignedToUserId = null,
    assignedToAccountId = null,
    visibleToUserId = null,
    visibleToAccountId = null,
    unassignedOnly = false,
    excludeUnassigned = false,
    createdByRole = null,
    createdDateFrom = null,
    createdDateTo = null,
    taskId = null,
    query = null,
    queryPackageName = null,
    deduplicateQuery = false,
    attention = null,
    reviewAssignedToAccountId = null,
    priorityMode = null,
    sortBy = 'priority',
    sortOrder = 'desc',
    limit = 50,
    offset = 0,
    cursor = null,
    lastPage = false,
    includeTotal = false,
    refreshTotal = false,
    countCacheIdentity = null,
    excludeActiveBlindQa = false,
    copyQaReturnedOnly = false,
    workModeKind = null,
  } = {}) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const safeOffset = Math.max(0, Number(offset) || 0);
    if (typeof includeTotal !== 'boolean') throw new TypeError('includeTotal must be a boolean');
    if (typeof refreshTotal !== 'boolean') throw new TypeError('refreshTotal must be a boolean');
    if (typeof deduplicateQuery !== 'boolean') throw new TypeError('deduplicateQuery must be a boolean');
    if (typeof unassignedOnly !== 'boolean') throw new TypeError('unassignedOnly must be a boolean');
    if (typeof excludeUnassigned !== 'boolean') throw new TypeError('excludeUnassigned must be a boolean');
    if (typeof excludeActiveBlindQa !== 'boolean') throw new TypeError('excludeActiveBlindQa must be a boolean');
    if (typeof copyQaReturnedOnly !== 'boolean') throw new TypeError('copyQaReturnedOnly must be a boolean');
    if (typeof lastPage !== 'boolean') throw new TypeError('lastPage must be a boolean');
    if (lastPage && !includeTotal) throw new TypeError('lastPage requires includeTotal');
    if (unassignedOnly && assignedToUserId !== null) throw new TypeError('assignee and unassigned filters conflict');
    if (assignedToAccountId !== null && assignedToUserId === null) {
      throw new TypeError('assignedToAccountId requires assignedToUserId');
    }
    if (visibleToAccountId !== null && visibleToUserId === null) {
      throw new TypeError('visibleToAccountId requires visibleToUserId');
    }
    if (visibleToUserId !== null && visibleToAccountId === null) {
      throw new TypeError('visibleToUserId requires visibleToAccountId');
    }
    if (visibleToUserId !== null
        && (assignedToUserId !== null || unassignedOnly || excludeUnassigned)) {
      throw new TypeError('visibility and assignee filters conflict');
    }
    const values = [];
    const filters = ["task_kind = 'CONTENT'"];
    if (taskIds !== null) {
      if (!Array.isArray(taskIds) || taskIds.length > 100) throw new TypeError('invalid personal task page');
      values.push(taskIds.map(normalizeTaskId));
      filters.push(`id = ANY($${values.length}::bigint[])`);
    }
    if (workModeKind !== null) {
      if (!['COPY', 'IMAGE'].includes(workModeKind)) throw new TypeError('invalid work mode kind');
      filters.push('priority_paused = false AND current_copy_revision_id IS NOT NULL');
      if (workModeKind === 'IMAGE') filters.push('current_image_run_id IS NOT NULL');
    }
    const createdDateRange = normalizeTaskDateRange(createdDateFrom, createdDateTo);
    if (createdDateRange.createdDateFrom !== null) {
      values.push(createdDateRange.createdDateFrom);
      filters.push(`${TASK_LATEST_ACTIVITY_SQL} >= ($${values.length}::date::timestamp AT TIME ZONE 'Asia/Shanghai')`);
    }
    if (createdDateRange.createdDateTo !== null) {
      values.push(createdDateRange.createdDateTo);
      filters.push(`${TASK_LATEST_ACTIVITY_SQL} < (($${values.length}::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')`);
    }
    if (reviewAssignedToAccountId !== null) {
      values.push(normalizeTaskId(reviewAssignedToAccountId));
      filters.push(`(state <> 'MANUAL_ARCHIVE' OR review_assigned_to_account_id = $${values.length}::bigint)`);
    }
    if (priorityMode !== null) {
      normalizePriorityMode(priorityMode);
      values.push(priorityMode);
      filters.push(`priority_mode = $${values.length}::varchar`);
    }
    if (excludeActiveBlindQa) {
      filters.push(`NOT ${activeBlindQaSql('tasks')}`);
    }
    if (copyQaReturnedOnly) {
      filters.push("(copy_qa_rework_pending = true OR (mandatory_copy_qc = true AND mandatory_copy_qc_origin = 'QA_RETURN'))");
    }
    const stateFilters = normalizedTaskStates(state, states);
    if (stateFilters.length > 0) {
      values.push(stateFilters);
      filters.push(`state = ANY($${values.length}::varchar[])`);
    }
    if (nodeId !== null) {
      values.push(normalizeNodeId(nodeId));
      filters.push(`copy_executor_node_id = $${values.length}`);
    }
    if (createdByAccountId !== null && createdByUserId === null) {
      throw new TypeError('createdByAccountId requires createdByUserId');
    }
    if (createdByUserId !== null) {
      values.push(normalizeCreatorUserId(createdByUserId));
      const creatorParameter = values.length;
      let accountPredicate = '';
      if (createdByAccountId !== null) {
        values.push(normalizeTaskId(createdByAccountId));
        accountPredicate = `AND exact_creator.id = $${values.length}`;
      }
      filters.push(`created_by_user_id = $${creatorParameter}
        AND EXISTS (
          SELECT 1 FROM app_users exact_creator
          WHERE exact_creator.username = tasks.created_by_user_id
            AND exact_creator.username = $${creatorParameter}
            ${accountPredicate}
            AND exact_creator.created_at < tasks.created_at
        )`);
    }
    if (assignedToUserId !== null) {
      values.push(normalizeAssigneeUserId(assignedToUserId, { allowNull: false }));
      const assigneeParameter = values.length;
      if (assignedToAccountId !== null) {
        values.push(normalizeTaskId(assignedToAccountId));
        filters.push(`assigned_to_user_id = $${assigneeParameter}
          AND EXISTS (
            SELECT 1 FROM app_users exact_assignee
            WHERE exact_assignee.username = tasks.assigned_to_user_id
              AND exact_assignee.username = $${assigneeParameter}
              AND exact_assignee.id = $${values.length}
              AND exact_assignee.created_at < tasks.assigned_at
          )`);
      } else {
        filters.push(`assigned_to_user_id = $${assigneeParameter}`);
      }
    } else if (unassignedOnly) {
      filters.push('assigned_to_user_id IS NULL');
    } else if (excludeUnassigned) {
      filters.push('assigned_to_user_id IS NOT NULL');
    }
    if (visibleToUserId !== null) {
      values.push(normalizeCreatorUserId(visibleToUserId));
      const visibleUsernameParameter = values.length;
      values.push(normalizeTaskId(visibleToAccountId));
      const visibleAccountParameter = values.length;
      filters.push(`(
        (
          assigned_to_user_id = $${visibleUsernameParameter}
          AND EXISTS (
            SELECT 1 FROM app_users visible_assignee
            WHERE visible_assignee.id = $${visibleAccountParameter}
              AND visible_assignee.username = tasks.assigned_to_user_id
              AND visible_assignee.created_at < tasks.assigned_at
          )
        )
        OR (
          created_by_user_id = $${visibleUsernameParameter}
          AND EXISTS (
            SELECT 1 FROM app_users visible_creator
            WHERE visible_creator.id = $${visibleAccountParameter}
              AND visible_creator.username = tasks.created_by_user_id
              AND visible_creator.created_at < tasks.created_at
          )
        )
      )`);
    }
    const creatorRole = normalizeTaskCreatorRole(createdByRole);
    if (creatorRole === 'UNKNOWN') {
      filters.push(`NOT EXISTS (SELECT 1 FROM app_users role_creator
        WHERE role_creator.username = tasks.created_by_user_id
          AND role_creator.created_at < tasks.created_at)`);
    } else if (creatorRole !== null) {
      values.push(creatorRole);
      filters.push(`EXISTS (SELECT 1 FROM app_users role_creator
        WHERE role_creator.username = tasks.created_by_user_id
          AND role_creator.created_at < tasks.created_at
          AND role_creator.role = $${values.length})`);
    }
    if (taskId !== null && taskId !== undefined && taskId !== '') {
      values.push(normalizeTaskId(taskId));
      filters.push(`id = $${values.length}`);
    }
    const taskAttention = normalizeTaskAttention(attention);
    if (taskAttention) {
      const stale = `(state IN ('COPY_RUNNING', 'IMAGE_RUNNING')
        AND COALESCE(last_activity_at, execution_started_at, updated_at, created_at) <= now() - interval '30 minutes')`;
      const failed = `(state IN ('COPY_FAILED', 'IMAGE_FAILED') OR current_stage = 'IMAGE_RETRY_EXHAUSTED')`;
      filters.push(taskAttention === 'STALE' ? stale : taskAttention === 'FAILED' ? failed : `(${stale} OR ${failed})`);
    }
    const searchQuery = normalizedTaskQuery(query);
    if (searchQuery !== null) {
      values.push(searchQuery);
      filters.push(`lower(query) LIKE '%' || lower($${values.length}) || '%'`);
    }
    const searchQueryPackageName = normalizedQueryPackageNameFilter(queryPackageName);
    if (searchQueryPackageName !== null) {
      values.push(searchQueryPackageName);
      filters.push(`lower(COALESCE(source_query_package_name, '')) LIKE '%' || lower($${values.length}) || '%'`);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const queryIdentity = taskQueryIdentitySql('query');
    const taskSort = normalizedTaskSort(sortBy, sortOrder);
    const cursorScope = createHash('sha256')
      .update(JSON.stringify({ where, values, deduplicateQuery }))
      .digest('base64url');
    const pageCursor = normalizedTaskPageCursor(cursor, taskSort, cursorScope);
    if (lastPage && pageCursor) throw new TypeError('lastPage and cursor cannot be combined');
    const resultOrder = taskSortOrder(taskSort, 'page.');
    // Query is at most 500 characters, but its UTF-8 bytes can exceed B-tree's
    // safe tuple size when both normalized and original text are included.
    // Merge the covered short-text and narrow long-text branches before DISTINCT.
    const queryCandidateBranch = comparison => `SELECT ${queryIdentity} AS query_identity, ${TASK_PAGE_KEYS_SQL}
      FROM tasks ${where} AND (${TASK_QUERY_COVER_BYTES_SQL}) ${comparison}
      ORDER BY ${queryIdentity}, created_at DESC, id DESC`;
    const queryCandidates = deduplicateQuery
      ? `(${queryCandidateBranch('<= 2300')}) UNION ALL (${queryCandidateBranch('> 2300')})` : '';
    const taskPage = deduplicateQuery ? `
        SELECT DISTINCT ON (query_identity) ${TASK_PAGE_KEYS_SQL}
        FROM (${queryCandidates}) deduplicated_tasks
        ORDER BY query_identity, created_at DESC, id DESC
      ` : `
        SELECT ${TASK_PAGE_KEYS_SQL} FROM tasks
        ${where}
      `;
    const countSql = deduplicateQuery
      ? `SELECT COUNT(DISTINCT query_identity) AS total FROM (${queryCandidates}) deduplicated_query_ids`
      : `SELECT COUNT(*) AS total FROM tasks ${where}`;
    const hasCountIdentity = countCacheIdentity
      && Number.isSafeInteger(Number(countCacheIdentity.userId)) && Number(countCacheIdentity.userId) > 0
      && typeof countCacheIdentity.username === 'string' && countCacheIdentity.username.length > 0
      && USER_ROLES.includes(countCacheIdentity.role)
      && Number.isSafeInteger(Number(countCacheIdentity.credentialVersion ?? countCacheIdentity.version));
    const countIdentity = hasCountIdentity && JSON.stringify({
      userId: countCacheIdentity.userId,
      username: countCacheIdentity.username,
      role: countCacheIdentity.role,
      credentialVersion: countCacheIdentity.credentialVersion ?? countCacheIdentity.version,
    });
    const countPromise = includeTotal ? readTaskTotal(this.pool, countSql, values, {
      key: countIdentity ? `${countIdentity}:${cursorScope}` : null,
      ttl: this.totalCacheTtlMs,
      now: this.now,
      fresh: lastPage || refreshTotal,
      scopeUsernames: [assignedToUserId == null ? null : normalizeAssigneeUserId(assignedToUserId,{allowNull:false}),
        createdByUserId == null ? null : normalizeCreatorUserId(createdByUserId),
        visibleToUserId == null ? null : normalizeCreatorUserId(visibleToUserId)].filter(value => typeof value === 'string'),
    }) : Promise.resolve(null);
    const knownCount = lastPage ? await countPromise : null;
    const countResult = knownCount?.result ?? null;
    const knownTotal = countResult ? Number(countResult.rows[0].total) : null;
    const lastPageSize = knownTotal === null || knownTotal === 0
      ? 0
      : knownTotal % safeLimit || safeLimit;
    const reversePage = lastPage || pageCursor?.mode === 'BEFORE';
    const cursorValues = [...values];
    const cursorPredicate = taskCursorPredicate(pageCursor, taskSort, cursorValues);
    const cursorWhere = cursorPredicate ? `WHERE ${cursorPredicate}` : '';
    const queryLimit = lastPage ? lastPageSize : safeLimit + 1;
    const pageValues = [...cursorValues, queryLimit];
    const limitParameter = pageValues.length;
    const usesOffset = !lastPage && !pageCursor;
    if (usesOffset) pageValues.push(safeOffset);
    const offsetSql = usesOffset ? `OFFSET $${pageValues.length}` : '';
    const pageOrder = taskSortOrder(taskSort, 'cursor_page.', reversePage);
    const pageRequest = this.pool.query(`
      SELECT page.*, COALESCE(e.node_id, successful_image.node_id) AS image_executor_node_id,
        n.name AS image_executor_node_name, creator.id AS creator_account_id,
        COALESCE(active_image_edits.executions, '[]'::jsonb) AS active_image_edit_executions,
        creator.display_name AS creator_display_name,
        creator.role AS creator_role, assignee.id AS assignee_account_id,
        assignee.display_name AS assigned_to_display_name,
        assignee.role AS assigned_to_role,
        assignee.status AS assignee_status,
        EXISTS (
          SELECT 1 FROM delivery_entries AS current_delivery
          WHERE current_delivery.task_id = page.id AND current_delivery.status = 'READY'
            AND current_delivery.copy_revision_id = page.current_copy_revision_id
            AND current_delivery.image_run_id = page.current_image_run_id
        ) AS delivery_ready
      FROM (
        SELECT ${TASK_PAGE_SUMMARY_SQL} FROM tasks page_task
        JOIN (
          SELECT cursor_page.id FROM (
            ${taskPage}
          ) cursor_page
          ${cursorWhere}
          ORDER BY ${pageOrder}
          LIMIT $${limitParameter} ${offsetSql}
        ) page_ids ON page_task.id = page_ids.id
      ) page
      LEFT JOIN task_executions e ON e.id = page.current_execution_id
        AND e.kind = 'IMAGE' AND e.status = 'RUNNING' AND page.state = 'IMAGE_RUNNING'
      LEFT JOIN image_runs delivered_run ON delivered_run.id = page.current_image_run_id
        AND delivered_run.task_id = page.id AND delivered_run.status = 'COMPLETED'
        AND page.state IN ('MANUAL_ARCHIVE', 'REVIEWED')
      LEFT JOIN task_executions successful_image ON successful_image.id = delivered_run.execution_id
        AND successful_image.task_id = page.id
        AND successful_image.kind = 'IMAGE' AND successful_image.status = 'SUCCEEDED'
      LEFT JOIN executor_nodes n ON n.id = COALESCE(e.node_id, successful_image.node_id)
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'executionId', active_execution.id,
          'nodeId', active_execution.node_id,
          'nodeName', active_node.name
        ) ORDER BY active_execution.started_at, active_execution.id) AS executions
        FROM image_edit_requests active_edit
        JOIN task_executions active_execution ON active_execution.id = active_edit.execution_id
          AND active_execution.task_id = page.id
          AND active_execution.kind = 'IMAGE' AND active_execution.status = 'RUNNING'
        LEFT JOIN executor_nodes active_node ON active_node.id = active_execution.node_id
        WHERE active_edit.task_id = page.id AND active_edit.status = 'RUNNING'
      ) active_image_edits ON true
      LEFT JOIN app_users creator ON creator.username = page.created_by_user_id
        AND creator.created_at < page.created_at
      LEFT JOIN app_users assignee ON assignee.username = page.assigned_to_user_id
        AND assignee.created_at < page.assigned_at
      ORDER BY ${resultOrder}
    `, pageValues);
    const [result, resolvedCountResult] = lastPage
      ? [await pageRequest, knownCount]
      : await Promise.all([pageRequest, countPromise]);
    const hasExtra = !lastPage && result.rows.length > safeLimit;
    const pageRows = pageCursor?.mode === 'BEFORE' && hasExtra
      ? result.rows.slice(1)
      : result.rows.slice(0, safeLimit);
    const items = pageRows.map(taskFrom);
    if (!includeTotal) return items;
    const total = Number(resolvedCountResult.result.rows[0].total);
    const effectiveOffset = lastPage ? Math.max(0, total - pageRows.length) : safeOffset;
    const hasPrevious = pageRows.length > 0 && effectiveOffset > 0;
    const hasNext = pageRows.length > 0 && !lastPage
      && (pageCursor?.mode === 'BEFORE' || hasExtra || effectiveOffset + pageRows.length < total);
    return {
      items,
      total,
      totalComputedAt: new Date(resolvedCountResult.computedAt).toISOString(),
      totalCacheAgeMs: Math.max(0, this.now() - resolvedCountResult.computedAt),
      limit: safeLimit,
      offset: effectiveOffset,
      previousCursor: hasPrevious ? taskPageCursor(taskSort, pageRows[0], 'BEFORE', cursorScope) : null,
      nextCursor: hasNext ? taskPageCursor(taskSort, pageRows.at(-1), 'AFTER', cursorScope) : null,
    };
  }

  async listPersonalTaskCompletions({
    accountId: rawAccountId,
    username: rawUsername,
    from: rawFrom,
    to: rawTo,
    limit = 20_001,
  }) {
    const accountId = normalizeTaskId(rawAccountId);
    const username = normalizeCreatorUserId(rawUsername);
    const from = normalizedCompletionBoundary(rawFrom, 'from');
    const to = normalizedCompletionBoundary(rawTo, 'to');
    const safeLimit = Math.max(1, Math.min(20_001, Number(limit) || 20_001));
    const durationMs = Date.parse(to) - Date.parse(from);
    if (durationMs <= 0 || durationMs > 366 * 86_400_000) {
      throw new TypeError('completion range must be between 1 and 366 days');
    }
    const result = await this.pool.query(`
      WITH completion_events AS (
        SELECT approval.task_id, 'COPY'::varchar AS stage, approval.approved_at AS completed_at
        FROM copy_approval_events AS approval
        WHERE approval.approved_by_account_id = $1
          AND approval.approved_at >= $3::timestamptz
          AND approval.approved_at < $4::timestamptz
        UNION ALL
        SELECT approval.task_id, 'IMAGE'::varchar AS stage, approval.submitted_at AS completed_at
        FROM image_approval_events AS approval
        WHERE approval.submitted_by_account_id = $1
          AND approval.submitted_at >= $3::timestamptz
          AND approval.submitted_at < $4::timestamptz
      )
      SELECT task.id, task.query, task.state,
        jsonb_agg(
          jsonb_build_object('stage', completion.stage, 'completedAt', completion.completed_at)
          ORDER BY completion.completed_at, completion.stage
        ) AS completions,
        max(completion.completed_at) AS latest_completed_at
      FROM completion_events AS completion
      JOIN tasks AS task ON task.id = completion.task_id
      WHERE (
        task.assigned_to_user_id = $2
        AND EXISTS (
          SELECT 1 FROM app_users AS visible_assignee
          WHERE visible_assignee.id = $1
            AND visible_assignee.username = task.assigned_to_user_id
            AND visible_assignee.created_at < task.assigned_at
        )
      ) OR (
        task.created_by_user_id = $2
        AND EXISTS (
          SELECT 1 FROM app_users AS visible_creator
          WHERE visible_creator.id = $1
            AND visible_creator.username = task.created_by_user_id
            AND visible_creator.created_at < task.created_at
        )
      )
      GROUP BY task.id, task.query, task.state
      ORDER BY latest_completed_at DESC, task.id DESC
      LIMIT $5
    `, [accountId, username, from, to, safeLimit]);
    return result.rows.map(personalTaskCompletionFrom);
  }

  async taskCounts({ nodeId: rawNodeId }) {
    const nodeId = normalizeNodeId(rawNodeId);
    const result = await this.pool.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE copy_executor_node_id = $1 AND state IN ('COPY_QUEUED', 'COPY_RUNNING')
        ) AS local_copy,
        COUNT(*) FILTER (WHERE state IN ('COPY_QUEUED', 'COPY_RUNNING', 'COPY_FAILED')) AS all_copy,
        COUNT(*) FILTER (WHERE state = 'COPY_REVIEW_PENDING') AS copy_review,
        COUNT(*) FILTER (WHERE state IN ('IMAGE_QUEUED', 'IMAGE_RUNNING')) AS image_work,
        COUNT(*) FILTER (WHERE state = 'MANUAL_ARCHIVE') AS manual_archive
      FROM tasks
      WHERE state <> 'CANCELLED' AND task_kind = 'CONTENT'
    `, [nodeId]);
    const row = result.rows[0];
    return {
      localCopy: Number(row.local_copy),
      allCopy: Number(row.all_copy),
      copyReview: Number(row.copy_review),
      imageWork: Number(row.image_work),
      manualArchive: Number(row.manual_archive),
    };
  }

  async assertContentTaskIds(rawIds) {
    const ids=rawIds.map(normalizeTaskId);
    if(!ids.length)return;
    const result=await this.pool.query("SELECT id FROM tasks WHERE id=ANY($1::bigint[]) AND task_kind='STANDALONE_IMAGE_EDIT' LIMIT 1",[ids]);
    if(result.rows.length)throw new ControlPlaneNotFoundError('独立图片编辑仅可通过图片编辑入口操作');
  }

  async getTaskAccess(rawTaskId) {
    const result = await this.pool.query(`
      SELECT task.id, task.task_kind, task.state, task.cancelled_from_state, task.assigned_at,
        task.created_by_user_id, task.assigned_to_user_id,
        creator.id AS creator_account_id, assignee.id AS assignee_account_id,
        ${activeBlindQaSql('task')} AS active_blind_qa
      FROM tasks AS task
      LEFT JOIN app_users AS creator ON creator.username = task.created_by_user_id
        AND creator.created_at < task.created_at
      LEFT JOIN app_users AS assignee ON assignee.username = task.assigned_to_user_id
        AND assignee.created_at < task.assigned_at
      WHERE task.id = $1
    `, [normalizeTaskId(rawTaskId)]);
    const row = result.rows[0];
    return row ? {
      id: Number(row.id),
      ...(row.task_kind === 'STANDALONE_IMAGE_EDIT' ? {taskKind:row.task_kind} : {}),
      state: row.state,
      cancelledFromState: row.cancelled_from_state ?? null,
      createdByUserId: row.created_by_user_id,
      createdByAccountId: row.creator_account_id === null || row.creator_account_id === undefined
        ? null : Number(row.creator_account_id),
      assignedToUserId: row.assigned_to_user_id ?? null,
      assignedToAccountId: row.assignee_account_id === null || row.assignee_account_id === undefined
        ? null : Number(row.assignee_account_id),
      assignedAt: row.assigned_at ?? null,
      activeBlindQa: row.active_blind_qa === true,
    } : null;
  }

  async getImagePlanRegeneration(rawTaskId, rawJobId, { metadataOnly = false } = {}) {
    const taskId = normalizeTaskId(rawTaskId);
    const jobId = normalizeUuid(rawJobId, 'jobId');
    const result = await this.pool.query(`
      SELECT ${metadataOnly ? 'id,task_id,status,error,requested_by_account_id,requested_by_username,updated_at' : '*'} FROM copy_image_plan_regeneration_jobs
      WHERE id = $1 AND task_id = $2
    `, [jobId, taskId]);
    if (!result.rows[0]) throw new ControlPlaneNotFoundError('image plan regeneration job not found');
    if (metadataOnly) {
      const row=result.rows[0];
      return {id:row.id,taskId:Number(row.task_id),status:row.status,error:row.error??null,
        requestedByAccountId:Number(row.requested_by_account_id),requestedByUsername:row.requested_by_username,updatedAt:row.updated_at};
    }
    return imagePlanRegenerationFrom(result.rows[0]);
  }

  async getTask(rawTaskId, { historyMode = 'all' } = {}) {
    const taskId = normalizeTaskId(rawTaskId);
    if (!['all', 'current'].includes(historyMode)) throw new TypeError('task history mode is invalid');
    const currentOnly = historyMode === 'current';
    const currentRunIds = `SELECT current_image_run_id FROM tasks WHERE id = $1
      UNION SELECT image_rework_source_run_id FROM tasks WHERE id = $1`;
    const [task, executions, revisions, imageRuns, assets, humanQualityAssessments, secondaryAssignmentFeedback] = await Promise.all([
      this.pool.query(`
        WITH task AS (
          SELECT ${currentOnly ? `${TASK_LIST_COLUMNS_SQL}, source_query_package_item_id, image_rework_source_run_id` : '*'} FROM tasks WHERE id = $1
        )
        SELECT task.*, creator.id AS creator_account_id,
          (SELECT source.issued_query FROM query_package_items AS source
            WHERE source.id = task.source_query_package_item_id) AS issued_query,
          (SELECT jsonb_agg(jsonb_build_object(
              'id', approval.id,
              'imageRunId', approval.image_run_id,
              'copyRevisionId', approval.copy_revision_id,
              'manualModificationNote', approval.manual_modification_note,
              'submittedAt', approval.submitted_at
            ) ORDER BY approval.submitted_at DESC, approval.id DESC)
            FROM ${currentOnly ? `(SELECT * FROM image_approval_events
              WHERE task_id = task.id AND image_run_id IN (task.current_image_run_id, task.image_rework_source_run_id)
              ORDER BY submitted_at DESC, id DESC LIMIT 20) AS approval` : 'image_approval_events AS approval'}
            WHERE approval.task_id = task.id) AS image_approval_events,
          (SELECT jsonb_agg(jsonb_build_object('note', disposition.note,
            'actorUsername', disposition.actor_username, 'createdAt', disposition.created_at)
            ORDER BY disposition.id DESC) FROM ${currentOnly ? `(SELECT * FROM image_task_dispositions
              WHERE task_id = task.id ORDER BY id DESC LIMIT 20) disposition` : 'image_task_dispositions disposition'}
            WHERE disposition.task_id = task.id) AS image_discard_events,
          (SELECT jsonb_agg(jsonb_build_object('source', disposition.source,
            'reasonCode', disposition.reason_code, 'note', disposition.note,
            'actorUsername', disposition.actor_username, 'createdAt', disposition.created_at)
            ORDER BY disposition.created_at DESC, disposition.source DESC, disposition.id DESC)
            FROM (
              SELECT id, 'COPY_QA' AS source, reason_code, note, actor_username, created_at
              FROM copy_qa_dispositions_v2 WHERE task_id = task.id
              UNION ALL
              SELECT id, 'COPY_QA_RETURN' AS source, reason_code, note, actor_username, created_at
              FROM copy_return_dispositions WHERE task_id = task.id
              ${currentOnly ? 'ORDER BY created_at DESC, id DESC LIMIT 20' : ''}
            ) AS disposition) AS copy_discard_events,
          (SELECT to_jsonb(p) FROM copy_image_plan_regeneration_jobs p
            WHERE p.task_id=task.id AND p.copy_revision_id=task.current_copy_revision_id
              AND task.state='COPY_REVIEW_PENDING'
            ORDER BY p.created_at DESC,p.id DESC LIMIT 1) AS personal_image_plan_job,
          (SELECT jsonb_build_object(
              'target', COALESCE(item.rework_target, 'IMAGE'),
              'reasonCodes', to_jsonb(item.reason_codes),
              'reasonSnapshots', COALESCE(return_event.details->'reasonSnapshots', '[]'::jsonb),
              'copyFields', to_jsonb(item.copy_fields),
              'problemAssetIds', to_jsonb(item.problem_asset_ids),
              'note', item.note,
              'sourceImageRunId', item.image_run_id,
              'returnedAt', item.reviewed_at
            )
            FROM image_sampling_items AS item
            LEFT JOIN LATERAL (
              SELECT event.details
              FROM image_sampling_events AS event
              WHERE event.freeze_id = item.freeze_id
                AND (event.sampling_item_id = item.id
                  OR (event.sampling_item_id IS NULL AND event.action = 'RETURN_BATCH'))
                AND event.action IN ('RETURN_SINGLE', 'RETURN_BATCH')
              ORDER BY event.created_at DESC, event.id DESC
              LIMIT 1
            ) AS return_event ON true
            WHERE task.mandatory_image_qc = true
              AND task.image_rework_source_run_id IS NOT NULL
              AND item.task_id = task.id
              AND item.image_run_id = task.image_rework_source_run_id
              AND item.status IN ('RETURNED', 'BATCH_RETURNED')
            ORDER BY item.reviewed_at DESC NULLS LAST, item.id DESC
            LIMIT 1) AS image_qa_return,
          creator.display_name AS creator_display_name,
          creator.role AS creator_role, assignee.id AS assignee_account_id,
          assignee.display_name AS assigned_to_display_name,
          assignee.role AS assigned_to_role,
          assignee.status AS assignee_status,
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'noteId', link.note_id,
              'url', link.url,
              'title', link.title,
              'rank', link.rank
            ) ORDER BY link.rank, link.id)
            FROM xhs_query_search_jobs AS search
            JOIN xhs_query_links AS link ON link.search_job_id = search.id
            WHERE search.task_id = task.id AND search.status = 'SUCCEEDED'
          ), '[]'::jsonb) AS xiaohongshu_links,
          (
            SELECT search.status
            FROM xhs_query_search_jobs AS search
            WHERE search.task_id = task.id
          ) AS xiaohongshu_search_status,
          (
            SELECT search.blocked_reason
            FROM xhs_query_search_jobs AS search
            WHERE search.task_id = task.id
          ) AS xiaohongshu_search_blocked_reason,
          EXISTS (
            SELECT 1 FROM delivery_entries AS current_delivery
            WHERE current_delivery.task_id = task.id AND current_delivery.status = 'READY'
              AND current_delivery.copy_revision_id = task.current_copy_revision_id
              AND current_delivery.image_run_id = task.current_image_run_id
          ) AS delivery_ready
        FROM task
        LEFT JOIN app_users AS creator ON creator.username = task.created_by_user_id
          AND creator.created_at < task.created_at
        LEFT JOIN app_users AS assignee ON assignee.username = task.assigned_to_user_id
          AND assignee.created_at < task.assigned_at
      `, [taskId]),
      this.pool.query(`
        ${currentOnly ? `SELECT id, task_id, kind, node_id, image_production_chain_id, status,
          stage, progress_percent, progress_message, progress_details, error, started_at,
          last_activity_at, finished_at,
          jsonb_build_object('imageRetry', jsonb_build_object('failedAttempts',
            snapshot->'imageRetry'->'failedAttempts')) AS snapshot
        FROM` : 'SELECT * FROM'} task_executions WHERE task_id = $1 AND content_cleared_at IS NULL
          ${currentOnly ? `AND id IN (
            SELECT current_execution_id FROM tasks WHERE id = $1
            UNION (SELECT failed.id FROM task_executions failed JOIN tasks owner ON owner.id = failed.task_id
              WHERE failed.task_id = $1 AND failed.kind = 'IMAGE' AND failed.status = 'FAILED'
                AND failed.content_cleared_at IS NULL
                AND (owner.image_production_chain_id IS NULL OR failed.image_production_chain_id = owner.image_production_chain_id)
              ORDER BY failed.started_at DESC, failed.id DESC LIMIT 3)
            UNION (SELECT latest.id FROM task_executions latest WHERE latest.task_id = $1
              AND latest.content_cleared_at IS NULL ORDER BY latest.started_at DESC, latest.id DESC LIMIT 1)
          )` : ''}
        ORDER BY started_at DESC, id DESC
      `, [taskId]),
      this.pool.query(currentOnly ? `${CURRENT_COPY_CONTEXT_SQL}
        SELECT revision.id, revision.task_id, revision.execution_id, revision.revision,
          CASE WHEN revision.id IN (SELECT id FROM current_copy_payload_ids) THEN revision.content END AS content,
          revision.approved_at, revision.approval_mode, revision.approved_by_node_id,
          revision.parent_revision_id, revision.revision_origin, revision.copy_content_changed_from_machine,
          revision.copy_rework_satisfied, revision.created_at
        FROM copy_revisions revision WHERE revision.task_id = $1 AND revision.content_cleared_at IS NULL
          AND revision.id IN (SELECT id FROM current_copy_lineage UNION SELECT id FROM current_copy_payload_ids)
        ORDER BY revision.revision DESC
      ` : `
        SELECT * FROM copy_revisions WHERE task_id = $1 AND content_cleared_at IS NULL ORDER BY revision DESC
      `, [taskId]),
      this.pool.query(`
        SELECT * FROM image_runs WHERE task_id = $1 AND content_cleared_at IS NULL
          ${currentOnly ? `AND id IN (${currentRunIds})` : ''}
        ORDER BY created_at DESC, id DESC
      `, [taskId]),
      this.pool.query(`
        SELECT id, task_id, image_run_id, media_type, byte_size, sha256, original_name, created_at
        FROM image_run_asset_view WHERE task_id = $1 AND id IN (SELECT id FROM assets WHERE content_cleared_at IS NULL)
          ${currentOnly ? `AND image_run_id IN (${currentRunIds})` : ''} ORDER BY id
      `, [taskId]),
      this.pool.query(currentOnly ? `${CURRENT_COPY_CONTEXT_SQL}
        SELECT * FROM (
          SELECT DISTINCT ON (stage, copy_revision_id, image_run_id, rating_context) *
          FROM human_quality_assessments WHERE task_id = $1
            AND (copy_revision_id IN (SELECT id FROM current_copy_payload_ids) OR image_run_id IN (${currentRunIds}))
          ORDER BY stage, copy_revision_id, image_run_id, rating_context, created_at DESC, id DESC
        ) current_assessments ORDER BY created_at, id
      ` : `
        SELECT * FROM human_quality_assessments
        WHERE task_id = $1 ORDER BY created_at, id
      `, [taskId]),
      readSecondaryAssignmentFeedback(this.pool, taskId),
    ]);
    if (!task.rows[0]) return null;
    const copyRevisions = revisions.rows.map(revisionFrom);
    const executionRows = currentOnly ? executions.rows : await hydrateExecutionSnapshots(this.pool, executions.rows);
    const mappedExecutions = executionRows.map(executionFrom);
    if (task.rows[0].mandatory_copy_qc === true || task.rows[0].copy_qa_rework_pending === true) {
      const current = copyRevisions.find(item => item.id === Number(task.rows[0].current_copy_revision_id));
      const baseline = findCopyReworkBaseline(copyRevisions, task.rows[0].current_copy_revision_id);
      if (current && baseline) {
        current.copyReworkSatisfied = copyReworkChanges(baseline.content, current.content).satisfied;
        for (const key of ['reworkOrigin', 'reworkTarget', 'reworkReasonCodes', 'reworkReasonSnapshots',
          'reworkCopyFields', 'reworkProblemAssetIds', 'reworkNote', 'reworkRecommendation',
          'reworkSamplingItemId']) current[key] = baseline[key];
      }
    }
    const mappedTask = taskFrom(task.rows[0]);
    const imageRetryFailures = latestImageRetryFailures({ ...mappedTask, executions: mappedExecutions });
    return {
      ...mappedTask,
      issuedQuery: task.rows[0].issued_query ?? null,
      secondaryAssignmentFeedback: secondaryAssignmentFeedback && mappedTask.assignedAt
        && new Date(secondaryAssignmentFeedback.assignedAt).getTime() === new Date(mappedTask.assignedAt).getTime()
        ? secondaryAssignmentFeedback : null,
      imageApprovalEvents: (task.rows[0].image_approval_events ?? []).map((approval) => ({
        id: Number(approval.id),
        imageRunId: approval.imageRunId,
        copyRevisionId: Number(approval.copyRevisionId),
        manualModificationNote: approval.manualModificationNote ?? null,
        submittedAt: approval.submittedAt,
      })),
      ...(imageRetryFailures.length > 0 ? { imageRetryFailures } : {}),
      imageDiscardEvents: task.rows[0].image_discard_events ?? [],
      copyDiscardEvents: task.rows[0].copy_discard_events ?? [],
      imagePlanRegeneration: task.rows[0].personal_image_plan_job
        ? imagePlanRegenerationFrom(task.rows[0].personal_image_plan_job) : null,
      imageQaReturn: imageQaReturnFrom(task.rows[0].image_qa_return),
      xiaohongshuLinks: Array.isArray(task.rows[0].xiaohongshu_links)
        ? task.rows[0].xiaohongshu_links.map((link) => ({
          noteId: String(link.noteId),
          url: String(link.url),
          title: link.title === null || link.title === undefined ? null : String(link.title),
          rank: Number(link.rank),
        }))
        : [],
      xiaohongshuSearchStatus: task.rows[0].xiaohongshu_search_status ?? null,
      xiaohongshuSearchBlockedReason: task.rows[0].xiaohongshu_search_blocked_reason ?? null,
      ...(currentOnly ? { history: { mode: 'current', availableKinds: Object.keys(TASK_HISTORY_TYPES) } } : {}),
      executions: currentOnly ? mappedExecutions.map(({ snapshot, ...execution }) => execution) : mappedExecutions,
      copyRevisions,
      imageRuns: imageRuns.rows.map(imageRunFrom),
      assets: assets.rows.map(taskAssetFrom),
      humanQualityAssessments: humanQualityAssessments.rows.map(qualityAssessmentFrom),
    };
  }

  async listTaskHistory(rawTaskId, { kind, limit = 20, cursor = null } = {}) {
    const taskId = normalizeTaskId(rawTaskId);
    const descriptor = taskHistoryType(kind);
    const safeLimit = integerOption(limit, 20, 'history limit', 1, 100);
    const pageCursor = normalizedHistoryCursor(cursor, taskId, kind, descriptor);
    const values = [taskId];
    let cursorWhere = '';
    if (pageCursor) {
      values.push(pageCursor.time, pageCursor.id);
      cursorWhere = `AND (${descriptor.time}, id) < ($2::timestamptz, $3::${descriptor.idType})`;
    }
    values.push(safeLimit + 1);
    const result = await this.pool.query(`SELECT ${descriptor.columns}, ${descriptor.time}::text AS history_cursor_time
      FROM ${descriptor.table} WHERE task_id = $1 ${descriptor.cleared ? 'AND content_cleared_at IS NULL' : ''}
      ${cursorWhere} ORDER BY ${descriptor.time} DESC, id DESC LIMIT $${values.length}`, values);
    const rows = result.rows.slice(0, safeLimit);
    const hasMore = result.rows.length > safeLimit;
    const last = rows.at(-1);
    const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({
      v: 1, taskId, kind, id: last.id,
      time: last.history_cursor_time ?? new Date(last[descriptor.time]).toISOString(),
    })).toString('base64url') : null;
    return { kind, items: rows.map(row => taskHistoryMetadata(row, descriptor)), limit: safeLimit, hasMore, nextCursor };
  }

  async getTaskHistoryItem(rawTaskId, { kind, itemId } = {}) {
    const taskId = normalizeTaskId(rawTaskId);
    const descriptor = taskHistoryType(kind);
    const id = taskHistoryId(itemId, descriptor);
    const result = await this.pool.query(`SELECT * FROM ${descriptor.table}
      WHERE task_id = $1 AND id = $2 ${descriptor.cleared ? 'AND content_cleared_at IS NULL' : ''}`, [taskId, id]);
    if (!result.rows[0]) return null;
    const row = kind === 'executions' ? (await hydrateExecutionSnapshots(this.pool, result.rows))[0] : result.rows[0];
    const detail = { kind, item: descriptor.map(row) };
    if (kind === 'imageRuns') {
      const assets = await this.pool.query(`SELECT id, task_id, image_run_id, media_type, byte_size, sha256, original_name, created_at
        FROM image_run_asset_view WHERE task_id = $1 AND image_run_id = $2
          AND id IN (SELECT id FROM assets WHERE content_cleared_at IS NULL) ORDER BY id`, [taskId, id]);
      detail.assets = assets.rows.map(taskAssetFrom);
    }
    return detail;
  }

  async getTaskForDelivery(rawTaskId) {
    const taskId = normalizeTaskId(rawTaskId);
    const result = await this.pool.query(`
      SELECT
        task.id,
        task.query,
        (SELECT source.issued_query FROM query_package_items AS source
          WHERE source.id = task.source_query_package_item_id) AS issued_query,
        task.source_query_package_name,
        task.source_client_batch_code,
        task.state,
        task.current_copy_revision_id,
        task.current_image_run_id,
        delivery.id AS delivery_entry_id,
        revision.content AS copy_content,
        image_run.result AS image_result,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'noteId', link.note_id,
            'url', link.url,
            'title', link.title,
            'rank', link.rank
          ) ORDER BY link.rank, link.id)
          FROM xhs_query_search_jobs AS search
          JOIN xhs_query_links AS link ON link.search_job_id = search.id
          WHERE search.task_id = task.id AND search.status = 'SUCCEEDED'
        ), '[]'::jsonb) AS xiaohongshu_links,
        (
          SELECT search.status
          FROM xhs_query_search_jobs AS search
          WHERE search.task_id = task.id
        ) AS xiaohongshu_search_status,
        (
          SELECT search.blocked_reason
          FROM xhs_query_search_jobs AS search
          WHERE search.task_id = task.id
        ) AS xiaohongshu_search_blocked_reason,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'id', asset.id,
              'taskId', asset.task_id,
              'imageRunId', asset.image_run_id,
              'mediaType', asset.media_type,
              'originalName', asset.original_name
            ) ORDER BY asset.id
          ) FILTER (WHERE asset.id IS NOT NULL),
          '[]'::jsonb
        ) AS assets
      FROM tasks AS task
      JOIN copy_revisions AS revision
        ON revision.id = task.current_copy_revision_id
      JOIN image_runs AS image_run
        ON image_run.id = task.current_image_run_id
      JOIN delivery_entries AS delivery
        ON delivery.task_id = task.id AND delivery.status = 'READY'
        AND delivery.copy_revision_id = task.current_copy_revision_id
        AND delivery.image_run_id = task.current_image_run_id
      LEFT JOIN image_run_asset_view AS asset
        ON asset.task_id = task.id AND asset.image_run_id = task.current_image_run_id
        AND asset.media_type LIKE 'image/%'
      WHERE task.id = $1 AND task.state = 'REVIEWED'
        AND NOT (task.input @> '{"testRun":true}'::jsonb)
      GROUP BY task.id, task.state, task.current_copy_revision_id,
        task.current_image_run_id, revision.content, image_run.result, delivery.id
    `, [taskId]);
    const row = result.rows[0];
    if (!row) return null;
    const copyRevisionId = Number(row.current_copy_revision_id);
    const imageRunId = row.current_image_run_id;
    return {
      task: {
        id: Number(row.id),
        query: row.query,
        issuedQuery: row.issued_query ?? null,
        sourceQueryPackageName: row.source_query_package_name ?? null,
        sourceClientBatchCode: row.source_client_batch_code ?? null,
        state: row.state,
        currentCopyRevisionId: copyRevisionId,
        currentImageRunId: imageRunId,
        copyRevisions: [{ id: copyRevisionId, content: row.copy_content }],
        imageRuns: [{ id: imageRunId, result: row.image_result }],
        xiaohongshuLinks: Array.isArray(row.xiaohongshu_links)
          ? row.xiaohongshu_links.map((link) => ({
            noteId: String(link.noteId),
            url: String(link.url),
            title: link.title === null || link.title === undefined ? null : String(link.title),
            rank: Number(link.rank),
          }))
          : [],
        xiaohongshuSearchStatus: row.xiaohongshu_search_status ?? null,
        xiaohongshuSearchBlockedReason: row.xiaohongshu_search_blocked_reason ?? null,
        assets: Array.isArray(row.assets) ? row.assets.map((asset) => ({
          ...asset,
          id: Number(asset.id),
          taskId: Number(asset.taskId),
        })) : [],
      },
      binding: {
        deliveryEntryId: Number(row.delivery_entry_id),
        taskId: Number(row.id),
        copyRevisionId,
        imageRunId,
      },
    };
  }

  async getTaskActionSummary(rawTaskId) {
    const result = await this.pool.query('SELECT * FROM tasks WHERE id = $1', [normalizeTaskId(rawTaskId)]);
    return taskFrom(result.rows[0]);
  }

  async listSavedTaskViews(rawOwnerUsername) {
    const ownerUsername = normalizedUsername(rawOwnerUsername);
    const result = await this.pool.query(`
      SELECT * FROM saved_task_views
      WHERE owner_username = $1
      ORDER BY updated_at DESC, id DESC
    `, [ownerUsername]);
    return result.rows.map(savedTaskViewFrom);
  }
}
