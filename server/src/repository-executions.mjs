import { hydrateExecutionSnapshots, storeExecutionSnapshotBatch } from './execution-snapshot-storage.mjs';
import {
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  IMAGE_FORMATS,
  MAX_IMAGE_ATTEMPTS,
  assertImageResultSettings,
  assertLayoutCapability,
  assertLockedImageText,
  claimRequestExpiry,
  configurationSnapshots,
  copyQualityImageGate,
  executionFrom,
  finishReassignmentBaseline,
  hasImageControls,
  hasLayoutCatalog,
  imagePlanRegenerationFrom,
  imageTextHash,
  isDeepStrictEqual,
  lockedExecution,
  normalizeConcurrency,
  normalizeCopyReviewEdits,
  normalizeCopyReviewImagePlan,
  normalizeJson,
  normalizeNodeId,
  normalizeProgress,
  normalizeTaskId,
  normalizeUuid,
  normalizedArtifactKey,
  parseVisualPlanOutput,
  priorityOrderSql,
  queueApprovedCopy,
  randomUUID,
  readWorkflowQualitySettings,
  redactExecutionError,
  revisionFrom,
  taskFrom,
  transaction,
  visualPlanPost,
  withSavedVisualPlan
} from './repository-context.mjs';
import { TaskWriteRepository } from './repository-task-writes.mjs';

/** Execution operations; inherited methods preserve the public repository API. */
export class ExecutionRepository extends TaskWriteRepository {
  async claimCopy(rawNodeId) {
    return (await this.#claim({ kind: 'COPY', nodeId: rawNodeId, limit: 1 })).claims[0] ?? null;
  }

  async claimImage(rawNodeId, imageControlsVersion = 0, layoutCatalogVersion = 0, imageEditExecutorVersion = 0) {
    return (await this.#claim({ kind: 'IMAGE', nodeId: rawNodeId, limit: 1, imageControlsVersion, layoutCatalogVersion, imageEditExecutorVersion })).claims[0] ?? null;
  }

  async claimCopyBatch({ nodeId, limit, requestId }) {
    return this.#claim({ kind: 'COPY', nodeId, limit, requestId: normalizeUuid(requestId, 'requestId') });
  }

  async claimImageBatch({ nodeId, limit, requestId, imageControlsVersion = 0, layoutCatalogVersion = 0, imageEditExecutorVersion = 0 }) {
    return this.#claim({ kind: 'IMAGE', nodeId, limit, requestId: normalizeUuid(requestId, 'requestId'), imageControlsVersion, layoutCatalogVersion, imageEditExecutorVersion });
  }

  async #claim({ kind, nodeId: rawNodeId, limit, requestId, imageControlsVersion = 0, layoutCatalogVersion = 0, imageEditExecutorVersion = 0 }) {
    const nodeId = normalizeNodeId(rawNodeId);
    normalizeConcurrency(limit, 'limit');
    return transaction(this.pool, async (client) => {
      const node = await client.query(`
        SELECT n.*,
          pool.total_concurrency AS codex_total_concurrency,
          pool.image_concurrency AS codex_image_concurrency
        FROM executor_nodes n
        JOIN codex_concurrency_pools pool ON pool.id = n.codex_pool_id
        WHERE n.id = $1 AND n.retired_at IS NULL
        FOR UPDATE OF n, pool
      `, [nodeId]);
      if (!node.rows[0]) throw new ControlPlaneNotFoundError('executor node is not registered');
      await client.query(`UPDATE executor_nodes SET last_seen_at = now() WHERE id = $1`, [nodeId]);
      // Reconcile an uncertain request even after image work has been disabled.
      if (requestId) {
        const receipt = (await client.query(`SELECT * FROM execution_claim_requests
          WHERE node_id = $1 AND kind = $2 AND request_id = $3`, [nodeId, kind, requestId])).rows[0];
        if (receipt) {
          if (receipt.requested_limit !== limit) {
            throw new ControlPlaneConflictError('CLAIM_REQUEST_MISMATCH', 'requestId was already used with another limit');
          }
          const storedRecords = receipt.execution_ids.length ? (await client.query(`
            SELECT e.*, row_to_json(t) AS task, row_to_json(edit) AS image_edit,
              row_to_json(regeneration) AS image_plan_regeneration
            FROM task_executions e
            JOIN tasks t ON t.id = e.task_id
            LEFT JOIN image_edit_requests edit ON edit.id = (e.snapshot->>'imageEditRequestId')::uuid
            LEFT JOIN copy_image_plan_regeneration_jobs regeneration
              ON regeneration.execution_id = e.id
            WHERE e.id = ANY($1::uuid[])
            ORDER BY array_position($1::uuid[], e.id)
          `, [receipt.execution_ids])).rows : [];
          const records = await hydrateExecutionSnapshots(client, storedRecords);
          if (kind === 'IMAGE') for (const row of records) {
            if (!row.image_edit) assertLayoutCapability(row.snapshot, layoutCatalogVersion);
          }
          return { requestId, claims: records.map(row => ({
            task: taskFrom(row.task), execution: executionFrom(row),
            ...(row.image_edit ? { imageEdit: row.image_edit } : {}),
            ...(row.image_plan_regeneration
              ? { imagePlanRegeneration: imagePlanRegenerationFrom(row.image_plan_regeneration) }
              : {}),
          })) };
        }
      }
      const expiresAt = requestId ? claimRequestExpiry(requestId) : null;
      if (requestId) {
        // The node lock serializes claims/GC. Terminal executions never return to RUNNING.
        // A bounded batch avoids extending the claim transaction after long downtime.
        await client.query(`DELETE FROM execution_claim_requests r USING (
          SELECT request_id FROM execution_claim_requests old
          WHERE node_id = $1 AND kind = $2 AND expires_at <= $3
            AND NOT EXISTS (SELECT 1 FROM task_executions e
              WHERE e.id = ANY(old.execution_ids) AND e.status = 'RUNNING')
          ORDER BY expires_at LIMIT 100
        ) expired WHERE r.node_id = $1 AND r.kind = $2 AND r.request_id = expired.request_id`, [nodeId, kind, new Date()]);
      }
      if (kind === 'IMAGE' && !node.rows[0].image_worker_enabled) {
        throw new ControlPlaneConflictError(
          'IMAGE_WORKER_DISABLED',
          'this executor node is not enabled for image work',
        );
      }
      const active = await client.query(`
        SELECT COUNT(*) AS total_count,
          COUNT(*) FILTER (WHERE execution.kind = 'IMAGE') AS image_count
        FROM task_executions execution
        JOIN executor_nodes owner ON owner.id = execution.node_id
        WHERE owner.codex_pool_id = $1 AND execution.status = 'RUNNING'
      `, [node.rows[0].codex_pool_id]);
      const totalAvailable = Number(node.rows[0].codex_total_concurrency)
        - Number(active.rows[0]?.total_count ?? 0);
      const kindAvailable = kind === 'IMAGE'
        ? Number(node.rows[0].codex_image_concurrency) - Number(active.rows[0]?.image_count ?? 0)
        : totalAvailable;
      const available = Math.min(limit, Math.max(0, totalAvailable), Math.max(0, kindAvailable));
      const queuedState = kind === 'COPY' ? 'COPY_QUEUED' : 'IMAGE_QUEUED';
      const runningState = kind === 'COPY' ? 'COPY_RUNNING' : 'IMAGE_RUNNING';
      let cursor = null;
      if (available && kind === 'IMAGE') {
        const cursorResult = await client.query(`
          SELECT last_assignee_user_id FROM execution_claim_cursors
          WHERE kind = $1
          FOR UPDATE
        `, [kind]);
        if (!cursorResult.rows[0]) {
          throw new Error(`execution claim cursor is missing for ${kind}`);
        }
        cursor = cursorResult.rows[0];
      }
      let candidate = { rows: [] };
      if (available && kind === 'COPY') {
        let regenerationRows = [];
        if (Number(node.rows[0].copy_image_plan_regeneration_version ?? 0) >= 1) {
          await client.query(`
            UPDATE copy_image_plan_regeneration_jobs regeneration SET
              status = 'STALE',
              error = '文案版本或任务状态已变化，本次生成请求已失效',
              finished_at = now(), updated_at = now()
            FROM tasks task
            WHERE regeneration.task_id = task.id
              AND regeneration.status = 'QUEUED'
              AND (task.state <> 'COPY_REVIEW_PENDING'
                OR task.current_copy_revision_id <> regeneration.copy_revision_id)
          `);
          regenerationRows = (await client.query(`
            SELECT task.*,
              regeneration.id AS image_plan_regeneration_id,
              regeneration.request_id AS image_plan_regeneration_request_id,
              regeneration.copy_revision_id AS image_plan_regeneration_copy_revision_id,
              regeneration.copy_payload AS image_plan_regeneration_copy
            FROM copy_image_plan_regeneration_jobs regeneration
            JOIN tasks task ON task.id = regeneration.task_id
            WHERE regeneration.status = 'QUEUED'
              AND task.state = 'COPY_REVIEW_PENDING'
              AND task.current_copy_revision_id = regeneration.copy_revision_id
              AND task.priority_paused = false
            ORDER BY regeneration.created_at, regeneration.id
            FOR UPDATE OF regeneration, task SKIP LOCKED
            LIMIT $1
          `, [available])).rows;
        }
        const ordinary = await client.query(`
          SELECT task.*
          FROM tasks AS task
          WHERE task.state = $1 AND task.priority_paused = false
          ORDER BY ${priorityOrderSql('task.')}
          FOR UPDATE OF task SKIP LOCKED
          LIMIT $2
        `, [queuedState, Math.max(0, available - regenerationRows.length)]);
        candidate = { rows: [...regenerationRows, ...ordinary.rows] };
      } else if (available) {
        candidate = await client.query(`
          WITH earliest_edits AS MATERIALIZED (
            SELECT DISTINCT ON (edit.task_id) edit.task_id, edit.id AS edit_id
            FROM image_edit_requests edit
            JOIN tasks edit_task ON edit_task.id = edit.task_id
            WHERE edit.operation <> 'SVG_DISCLOSURE'
              AND $5::integer >= CASE
                WHEN edit_task.task_kind = 'STANDALONE_IMAGE_EDIT' THEN 13
                WHEN edit.operation = 'AI_FUSION' THEN 12
                WHEN edit.operation = 'AI_LOCAL' THEN 9
                WHEN edit.operation = 'TEXT' OR edit.operation LIKE 'AI_%' THEN 7
                ELSE 3
              END
              AND edit.status = 'QUEUED'
              AND edit_task.priority_paused = false
              AND edit_task.assigned_to_user_id IS NOT NULL
            ORDER BY edit.task_id, edit.created_at, edit.id
          ), work_candidates AS MATERIALIZED (
            SELECT
              queued.id AS task_id,
              NULL::uuid AS edit_id,
              queued.assigned_to_user_id,
              queued.last_activity_at,
              queued.priority_paused,
              queued.priority_sort_at,
              queued.assigned_to_user_id AS claim_owner
            FROM tasks AS queued
            WHERE queued.state = $1
              AND queued.priority_paused = false
              AND ${copyQualityImageGate('queued')}
              AND queued.assigned_to_user_id IS NOT NULL
              AND (queued.pending_snapshot->'imageRetry'->>'nodeId' IS NULL
                OR queued.pending_snapshot->'imageRetry'->>'nodeId' = $2)
              AND (queued.pending_snapshot->'imageRecovery'->>'nodeId' IS NULL
                OR queued.pending_snapshot->'imageRecovery'->>'nodeId' = $2)
              AND (queued.error IS NULL OR queued.last_activity_at <= now() - interval '5 seconds')
            UNION ALL
            SELECT queued.id, edit.edit_id, queued.assigned_to_user_id,
              queued.last_activity_at, queued.priority_paused, queued.priority_sort_at,
              queued.assigned_to_user_id
            FROM earliest_edits edit
            JOIN tasks queued ON queued.id = edit.task_id
          ), ranked_candidates AS MATERIALIZED (
            SELECT work.*,
              row_number() OVER (
                PARTITION BY work.assigned_to_user_id
                ORDER BY work.priority_paused, work.priority_sort_at, work.task_id,
                  work.edit_id NULLS FIRST
              ) AS owner_row_number
            FROM work_candidates work
          )
          SELECT task.*, ranked.edit_id AS image_edit_request_id
          FROM ranked_candidates AS ranked
          JOIN tasks AS task ON task.id = ranked.task_id
          WHERE task.priority_paused = false
            AND task.assigned_to_user_id IS NOT NULL
            AND task.assigned_to_user_id IS NOT DISTINCT FROM ranked.assigned_to_user_id
            AND ((ranked.edit_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM image_edit_requests current_edit
                WHERE current_edit.id = ranked.edit_id AND current_edit.status = 'QUEUED'
              )) OR (ranked.edit_id IS NULL
                AND task.state = $1
                AND ${copyQualityImageGate('task')}
                AND (task.pending_snapshot->'imageRetry'->>'nodeId' IS NULL
                  OR task.pending_snapshot->'imageRetry'->>'nodeId' = $2)
                AND (task.pending_snapshot->'imageRecovery'->>'nodeId' IS NULL
                  OR task.pending_snapshot->'imageRecovery'->>'nodeId' = $2)
                AND (task.error IS NULL OR task.last_activity_at <= now() - interval '5 seconds')))
          ORDER BY
            ranked.owner_row_number,
            CASE WHEN $3::varchar IS NULL
                OR ranked.claim_owner > $3::varchar THEN 0 ELSE 1 END,
            ranked.claim_owner,
            ranked.last_activity_at NULLS FIRST, ranked.task_id
          FOR UPDATE OF task SKIP LOCKED
          LIMIT $4
        `, [queuedState, nodeId, cursor?.last_assignee_user_id ?? null, available,
          imageEditExecutorVersion]);
      }
      const snapshots = await configurationSnapshots(client, candidate.rows.filter(task =>
        task.image_plan_regeneration_id
          || (!task.image_edit_request_id && task.pending_snapshot == null)), kind);
      const prepared = candidate.rows.map(task => {
        const executionId = randomUUID();
        const imageEditRequestId = task.image_edit_request_id ?? null;
        const imagePlanRegenerationId = task.image_plan_regeneration_id ?? null;
        const baseSnapshot = imagePlanRegenerationId
          ? {
              ...snapshots.get(task.id),
              imagePlanRegeneration: {
                id: imagePlanRegenerationId,
                requestId: task.image_plan_regeneration_request_id,
                copyRevisionId: Number(task.image_plan_regeneration_copy_revision_id),
                copy: task.image_plan_regeneration_copy,
              },
            }
          : imageEditRequestId
          ? { imageEditRequestId, imageEditExecutorVersion,
            task: { id: Number(task.id), query: task.query, ...(task.task_kind === 'STANDALONE_IMAGE_EDIT' ? {kind:task.task_kind} : {}) } }
          : task.pending_snapshot ?? snapshots.get(task.id);
        const imageProductionChainId = kind === 'IMAGE' && !imageEditRequestId
          ? task.image_production_chain_id ?? baseSnapshot?.imageProductionChainId ?? randomUUID()
          : null;
        const snapshot = kind === 'IMAGE' && !imageEditRequestId
          ? { ...baseSnapshot, imageProductionChainId }
          : baseSnapshot;
        if (kind === 'IMAGE' && !imageEditRequestId) assertLayoutCapability(snapshot, layoutCatalogVersion);
        if (kind === 'IMAGE' && !imageEditRequestId
            && hasImageControls(snapshot?.copyRevision?.content) && imageControlsVersion !== 1) {
          throw new ControlPlaneConflictError('IMAGE_CONTROLS_UPGRADE_REQUIRED', '当前任务使用新版图片配置，请更新图片执行机后再领取');
        }
        const stage = imagePlanRegenerationId ? 'COPY_IMAGE_PLAN_REGENERATION'
          : imageEditRequestId ? 'IMAGE_EDIT' : kind === 'COPY' ? 'STARTING_COPY' : 'STARTING_IMAGE';
        const progressMessage = imagePlanRegenerationId ? '执行机已领取图文规划重生成'
          : imageEditRequestId ? '执行机已领取图片修改' : '执行机已领取任务';
        return { task, executionId, imageEditRequestId, imagePlanRegenerationId,
          imageProductionChainId, snapshot, stage, progressMessage };
      });
      const storedSnapshots = this.executionSnapshotStorageEnabled
        ? await storeExecutionSnapshotBatch(client, prepared.map(item => item.snapshot)) : [];
      const claims = [];
      for (let index = 0; index < prepared.length; index++) {
        const { task, executionId, imageEditRequestId, imagePlanRegenerationId,
          imageProductionChainId, snapshot, stage, progressMessage } = prepared[index];
        if (this.executionSnapshotStorageEnabled) {
          const stored = storedSnapshots[index];
          await client.query(`INSERT INTO task_executions(
            id,task_id,kind,node_id,stage,progress_message,snapshot,image_production_chain_id,
            snapshot_prompts_hash,snapshot_knowledge_hash,snapshot_production_settings_hash
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [executionId, task.id, kind, nodeId, stage, progressMessage, stored.snapshot,
            imageProductionChainId, stored.promptsHash, stored.knowledgeHash, stored.productionSettingsHash]);
        } else await client.query(`
          INSERT INTO task_executions(
            id, task_id, kind, node_id, stage, progress_message, snapshot,
            image_production_chain_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [executionId, task.id, kind, nodeId, stage, progressMessage, snapshot,
          imageProductionChainId]);
        let imageEdit = null;
        let imagePlanRegeneration = null;
        if (imagePlanRegenerationId) {
          imagePlanRegeneration = (await client.query(`
            UPDATE copy_image_plan_regeneration_jobs SET
              status = 'RUNNING', attempts = attempts + 1,
              execution_id = $2, claimed_by_node_id = $3,
              started_at = now(), error = NULL, updated_at = now()
            WHERE id = $1 AND status = 'QUEUED'
            RETURNING *
          `, [imagePlanRegenerationId, executionId, nodeId])).rows[0];
          if (!imagePlanRegeneration) {
            await client.query('DELETE FROM task_executions WHERE id = $1', [executionId]);
            continue;
          }
        } else if (imageEditRequestId) {
          imageEdit = (await client.query(`UPDATE image_edit_requests SET
              status='RUNNING', attempts=attempts+1, version=version+1,
              claimed_by=$2, execution_id=$3, lease_token=$4,
              lease_expires_at=now()+interval '15 minutes', validation=NULL,
              error=NULL, updated_at=now()
            WHERE id=$1 AND status='QUEUED'
            RETURNING *`, [imageEditRequestId, nodeId, executionId, randomUUID()])).rows[0];
          if (!imageEdit) {
            await client.query('DELETE FROM task_executions WHERE id=$1', [executionId]);
            continue;
          }
          await client.query(`INSERT INTO image_edit_events(
              task_id,edit_id,action,actor,reason,detail)
            VALUES($1,$2,'EXECUTE',$3,$4,$5)`, [task.id, imageEdit.id, nodeId,
            `attempt ${imageEdit.attempts}`, { executionId }]);
        } else if (kind === 'IMAGE') {
          await client.query(`
            INSERT INTO image_runs(id, task_id, execution_id, copy_revision_id,
              image_production_chain_id)
            VALUES ($1, $2, $1, $3, $4)
          `, [executionId, task.id, task.current_copy_revision_id, imageProductionChainId]);
        }
        const updated = imageEdit || imagePlanRegeneration ? { rows: [task] } : await client.query(`
          UPDATE tasks SET
            state = $1,
            current_execution_id = $2,
            copy_executor_node_id = CASE WHEN $3 = 'COPY' THEN $7 ELSE copy_executor_node_id END,
            current_image_run_id = CASE WHEN $3 = 'IMAGE' THEN $2 ELSE current_image_run_id END,
            image_production_chain_id = CASE WHEN $3 = 'IMAGE' THEN $8 ELSE image_production_chain_id END,
            image_production_started_at = CASE WHEN $3 = 'IMAGE'
              THEN COALESCE(image_production_started_at, now()) ELSE image_production_started_at END,
            current_stage = $4,
            progress_percent = 0,
            progress_message = '执行机已领取任务',
            execution_started_at = now(),
            last_activity_at = now(),
            finished_at = NULL,
            error = NULL,
            pending_snapshot = NULL,
            updated_at = now()
          WHERE id = $5 AND state = $6
          RETURNING *
        `, [runningState, executionId, kind, stage, task.id, queuedState, nodeId,
          imageProductionChainId]);
        const executionRecord = (await client.query('SELECT * FROM task_executions WHERE id = $1', [executionId])).rows[0];
        claims.push({
          task: taskFrom(updated.rows[0]),
          execution: executionFrom(executionRecord && { ...executionRecord, snapshot }),
          ...(imageEdit ? { imageEdit } : {}),
          ...(imagePlanRegeneration
            ? { imagePlanRegeneration: imagePlanRegenerationFrom(imagePlanRegeneration) }
            : {}),
        });
      }
      if (kind === 'IMAGE' && claims.length) {
        const lastClaimedAssignee = claims.at(-1).task?.assignedToUserId;
        if (!lastClaimedAssignee) {
          throw new Error(`claimed ${kind.toLowerCase()} task is missing its assignee`);
        }
        const cursorUpdate = await client.query(`
          UPDATE execution_claim_cursors
          SET last_assignee_user_id = $2, updated_at = now()
          WHERE kind = $1
          RETURNING kind
        `, [kind, lastClaimedAssignee]);
        if (cursorUpdate.rows.length !== 1 || cursorUpdate.rows[0].kind !== kind
            || (cursorUpdate.rowCount !== undefined && cursorUpdate.rowCount !== 1)) {
          throw new Error(`execution claim cursor could not be advanced for ${kind}`);
        }
      }
      if (requestId) {
        await client.query(`INSERT INTO execution_claim_requests(node_id, kind, request_id, requested_limit, execution_ids, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6)`, [nodeId, kind, requestId, limit, claims.map(claim => claim.execution.id), expiresAt]);
      }
      return { requestId, claims };
    });
  }

  async saveVisualPlan(rawExecutionId, input) {
    const executionId = normalizeUuid(rawExecutionId, 'executionId');
    const data = normalizeJson(input, 'visual plan', 1_000_000);
    return transaction(this.pool, async client => {
      const execution = await lockedExecution(client, executionId);
      if (execution.kind !== 'IMAGE') throw new TypeError('execution is not an image execution');
      const post = visualPlanPost(execution.snapshot);
      const value = parseVisualPlanOutput(JSON.stringify(data.value), { post, layoutCatalog: execution.snapshot?.productionSettings?.production?.value?.layoutCatalog ?? null });
      assertLockedImageText(value, post);
      value.textContractSha256 = imageTextHash(post);
      const checkpoint = execution.snapshot?.visualPlanCheckpoint?.value;
      if (checkpoint && !isDeepStrictEqual(checkpoint, value)) {
        throw new ControlPlaneConflictError('VISUAL_PLAN_CONFLICT', '恢复运行必须复用中心已冻结的视觉规划');
      }
      const visualPlan = { value, model: typeof data.model === 'string' ? data.model.slice(0, 200) : null, degraded: data.degraded === true, warning: data.warning ?? null,
        planningMode: value.planningMode ?? 'MODEL', savedAt: new Date().toISOString() };
      const existing = await client.query('SELECT result FROM image_runs WHERE execution_id = $1 FOR UPDATE', [executionId]);
      if (!existing.rows[0]) throw new ControlPlaneNotFoundError('image run not found');
      if (existing.rows[0]?.result?.visualPlan?.value && !isDeepStrictEqual(existing.rows[0].result.visualPlan.value, value)) {
        throw new ControlPlaneConflictError('VISUAL_PLAN_CONFLICT', '本次运行已保存不同的规划，请创建新的图片运行');
      }
      if (!existing.rows[0]?.result?.visualPlan?.value) await client.query("UPDATE image_runs SET result = COALESCE(result, '{}'::jsonb) || $2::jsonb WHERE execution_id = $1", [executionId, { visualPlan }]);
      return { saved: true, textContractSha256: value.textContractSha256 };
    });
  }

  async updateProgress(rawExecutionId, rawProgress) {
    const executionId = normalizeUuid(rawExecutionId, 'executionId');
    const progress = normalizeProgress(rawProgress);
    return transaction(this.pool, async (client) => {
      const activeExecution = await lockedExecution(client, executionId);
      const updated = await client.query(`
        UPDATE task_executions SET
          stage = $2,
          progress_percent = $3,
          progress_message = $4,
          progress_details = $5,
          last_activity_at = now()
        WHERE id = $1
        RETURNING *
      `, [
        executionId,
        progress.stage,
        progress.progressPercent,
        progress.message,
        progress.details,
      ]);
      await client.query(`
        UPDATE tasks SET
          current_stage = $2,
          progress_percent = $3,
          progress_message = $4,
          last_activity_at = now(),
          updated_at = now()
        WHERE id = $5 AND current_execution_id = $1
      `, [executionId, progress.stage, progress.progressPercent, progress.message, activeExecution.task_id]);
      await client.query(`UPDATE executor_nodes SET last_seen_at = now() WHERE id = $1`, [activeExecution.node_id]);
      return executionFrom(updated.rows[0] && { ...updated.rows[0], snapshot: activeExecution.snapshot });
    });
  }

  async completeImagePlanRegeneration(rawExecutionId, rawResult) {
    const executionId = normalizeUuid(rawExecutionId, 'executionId');
    if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)) {
      throw new TypeError('image plan regeneration result must be an object');
    }
    const imagePlan = normalizeCopyReviewImagePlan(rawResult.imagePlan);
    if (rawResult.model != null && typeof rawResult.model !== 'string') {
      throw new TypeError('image plan regeneration model is invalid');
    }
    const model = rawResult.model == null ? null : rawResult.model.trim();
    if (model !== null && (!model || [...model].length > 200)) {
      throw new TypeError('image plan regeneration model is invalid');
    }
    const result = { imagePlan, model };
    return transaction(this.pool, async (client) => {
      const taskLock = await client.query(`
        SELECT task.* FROM tasks task
        WHERE task.id = (SELECT execution.task_id FROM task_executions execution WHERE execution.id = $1)
        FOR UPDATE OF task
      `, [executionId]);
      if (!taskLock.rows[0]) throw new ControlPlaneNotFoundError('execution not found');
      const record = (await client.query(`
        SELECT execution.status AS execution_status, execution.kind AS execution_kind,
          regeneration.*
        FROM task_executions execution
        JOIN copy_image_plan_regeneration_jobs regeneration
          ON regeneration.execution_id = execution.id
        WHERE execution.id = $1
        FOR UPDATE OF execution, regeneration
      `, [executionId])).rows[0];
      if (!record) throw new ControlPlaneNotFoundError('image plan regeneration execution not found');
      if (record.execution_status === 'SUCCEEDED' && record.status === 'SUCCEEDED') {
        return imagePlanRegenerationFrom(record);
      }
      if (record.execution_status === 'ABANDONED' && record.status === 'STALE') {
        return imagePlanRegenerationFrom(record);
      }
      if (record.execution_kind !== 'COPY'
          || record.execution_status !== 'RUNNING' || record.status !== 'RUNNING') {
        throw new ControlPlaneConflictError(
          'STALE_EXECUTION',
          'execution is no longer current and cannot complete this image plan regeneration',
        );
      }
      const task = taskLock.rows[0];
      if (task.state !== 'COPY_REVIEW_PENDING'
          || Number(task.current_copy_revision_id) !== Number(record.copy_revision_id)) {
        const message = '文案版本或任务状态已变化，本次生成结果未应用';
        await client.query(`
          UPDATE task_executions SET status = 'ABANDONED', stage = 'STALE',
            progress_percent = 100, progress_message = $2, error = $2,
            last_activity_at = now(), finished_at = now()
          WHERE id = $1
        `, [executionId, message]);
        const stale = await client.query(`
          UPDATE copy_image_plan_regeneration_jobs SET status = 'STALE',
            result = NULL, error = $2, finished_at = now(), updated_at = now()
          WHERE execution_id = $1 RETURNING *
        `, [executionId, message]);
        return imagePlanRegenerationFrom(stale.rows[0]);
      }
      await client.query(`
        UPDATE task_executions SET status = 'SUCCEEDED', stage = 'COMPLETED',
          progress_percent = 100, progress_message = '图文规划重新生成完成',
          last_activity_at = now(), finished_at = now()
        WHERE id = $1
      `, [executionId]);
      const completed = await client.query(`
        UPDATE copy_image_plan_regeneration_jobs SET status = 'SUCCEEDED',
          result = $2, error = NULL, finished_at = now(), updated_at = now()
        WHERE execution_id = $1 RETURNING *
      `, [executionId, result]);
      return imagePlanRegenerationFrom(completed.rows[0]);
    });
  }

  async failImagePlanRegeneration(rawExecutionId, rawError) {
    const executionId = normalizeUuid(rawExecutionId, 'executionId');
    const message = redactExecutionError(rawError);
    const progressMessage = [...message].slice(0, 500).join('');
    return transaction(this.pool, async (client) => {
      const taskLock = await client.query(`
        SELECT task.id FROM tasks task
        WHERE task.id = (SELECT execution.task_id FROM task_executions execution WHERE execution.id = $1)
        FOR UPDATE OF task
      `, [executionId]);
      if (!taskLock.rows[0]) throw new ControlPlaneNotFoundError('execution not found');
      const record = (await client.query(`
        SELECT execution.status AS execution_status, execution.kind AS execution_kind,
          regeneration.*
        FROM task_executions execution
        JOIN copy_image_plan_regeneration_jobs regeneration
          ON regeneration.execution_id = execution.id
        WHERE execution.id = $1
        FOR UPDATE OF execution, regeneration
      `, [executionId])).rows[0];
      if (!record) throw new ControlPlaneNotFoundError('image plan regeneration execution not found');
      if (record.execution_status !== 'RUNNING' || record.status !== 'RUNNING') {
        if (record.execution_status === 'FAILED' && record.status === 'FAILED') {
          return imagePlanRegenerationFrom(record);
        }
        throw new ControlPlaneConflictError(
          'STALE_EXECUTION',
          'execution is no longer current and cannot fail this image plan regeneration',
        );
      }
      await client.query(`
        UPDATE task_executions SET status = 'FAILED', stage = 'FAILED',
          progress_message = $2, error = $3,
          last_activity_at = now(), finished_at = now()
        WHERE id = $1
      `, [executionId, progressMessage, message]);
      const failed = await client.query(`
        UPDATE copy_image_plan_regeneration_jobs SET status = 'FAILED',
          result = NULL, error = $2, finished_at = now(), updated_at = now()
        WHERE execution_id = $1 RETURNING *
      `, [executionId, message]);
      return imagePlanRegenerationFrom(failed.rows[0]);
    });
  }

  async completeCopy(rawExecutionId, rawResult) {
    const executionId = normalizeUuid(rawExecutionId, 'executionId');
    const result = normalizeJson(rawResult, 'copy result', 5_000_000);
    return transaction(this.pool, async (client) => {
      const execution = await lockedExecution(client, executionId);
      if (execution.kind !== 'COPY') throw new TypeError('execution is not a copy execution');
      let bypass = execution.skip_copy_review === true && execution.assigned_to_user_id != null;
      if (bypass && (await readWorkflowQualitySettings(client)).copySampling.enabled) bypass = false;
      let message = execution.assigned_to_user_id == null
        ? '文案生成完成，等待分配负责人后审核'
        : '文案生成完成，等待人工审核';
      if (bypass) {
        try {
          normalizeCopyReviewEdits({
            copy: result?.copy ?? result?.reviewed?.copy ?? result?.post,
            imagePlan: result?.imagePlan ?? result?.reviewed?.imagePlan ?? result?.post?.imagePlan,
          });
          message = '管理员免审核，等待图片执行机领取';
        } catch (error) {
          if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
          bypass = false;
          message = '文案格式校验未通过，等待人工审核';
        }
      }
      const revisionNumber = Number((await client.query(`
        SELECT COALESCE(MAX(revision), 0) + 1 AS revision
        FROM copy_revisions WHERE task_id = $1
      `, [execution.task_id])).rows[0].revision);
      const revision = await client.query(`
        INSERT INTO copy_revisions(task_id, execution_id, revision, content, approved_at, approved_by_node_id,
          approval_mode, revision_origin, copy_content_changed_from_machine, copy_rework_satisfied)
        VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() ELSE NULL END,
          CASE WHEN $5 THEN $6 ELSE NULL END, CASE WHEN $5 THEN 'ADMIN_BYPASS' ELSE NULL END,
          'GENERATION', false, false)
        RETURNING *
      `, [execution.task_id, executionId, revisionNumber, result, bypass, execution.created_by_node_id]);
      await client.query(`
        UPDATE task_executions SET
          status = 'SUCCEEDED', stage = 'COMPLETED', progress_percent = 100,
          progress_message = $2, last_activity_at = now(), finished_at = now()
        WHERE id = $1
      `, [executionId, message]);
      if (execution.mandatory_copy_qc_origin === 'SECOND_ASSIGNMENT' && execution.assigned_to_user_id == null) {
        const resetTask = await finishReassignmentBaseline(client, execution.task_id);
        if (resetTask) return { task: taskFrom(resetTask), revision: revisionFrom((await client.query(
          'SELECT * FROM copy_revisions WHERE id=$1', [resetTask.current_copy_revision_id],
        )).rows[0]) };
      }
      if (bypass) {
        const task = await queueApprovedCopy(client, execution.task_id, revision.rows[0].id,
          execution.ai_disclosure_enabled ?? true, message);
        return { task, revision: revisionFrom(revision.rows[0]) };
      }
      const task = await client.query(`
        UPDATE tasks SET
          state = 'COPY_REVIEW_PENDING', current_copy_revision_id = $2,
          current_execution_id = NULL, current_stage = 'COPY_REVIEW_PENDING',
          progress_percent = 100, progress_message = $4,
          last_activity_at = now(), finished_at = now(), updated_at = now()
        WHERE id = $1 AND current_execution_id = $3
        RETURNING *
      `, [execution.task_id, revision.rows[0].id, executionId, message]);
      return { task: taskFrom(task.rows[0]), revision: revisionFrom(revision.rows[0]) };
    });
  }

  async completeImage(rawExecutionId, rawResult) {
    const executionId = normalizeUuid(rawExecutionId, 'executionId');
    const result = normalizeJson(rawResult, 'image result', 10_000_000);
    return transaction(this.pool, async (client) => {
      const execution = await lockedExecution(client, executionId);
      if (execution.kind !== 'IMAGE') throw new TypeError('execution is not an image execution');
      assertImageResultSettings(execution.snapshot?.copyRevision?.content, result);
      // Local reprocessing reuses the source run and does not create a new visual plan.
      if (hasLayoutCatalog(execution.snapshot) && !execution.snapshot.copyRevision?.content?.imageReprocess) {
        const run = await client.query('SELECT result FROM image_runs WHERE execution_id = $1 FOR UPDATE', [executionId]);
        if (!run.rows[0]?.result?.visualPlan?.value) {
          throw new ControlPlaneConflictError('VISUAL_PLAN_REQUIRED', '视觉规划尚未校验入库，无法完成本次图片运行');
        }
      }
      await client.query(`
        UPDATE image_runs SET status = 'COMPLETED', result = COALESCE(result, '{}'::jsonb) || $2::jsonb
          || CASE WHEN result ? 'visualPlan' THEN jsonb_build_object('visualPlan', result->'visualPlan') ELSE '{}'::jsonb END, finished_at = now()
        WHERE id = $1
      `, [executionId, result]);
      await client.query(`
        UPDATE task_executions SET
          status = 'SUCCEEDED', stage = 'COMPLETED', progress_percent = 100,
          progress_message = '图片生成完成，等待人工归档', last_activity_at = now(), finished_at = now()
        WHERE id = $1
      `, [executionId]);
      const referencedAssetIds = [...new Set((Array.isArray(result.images) ? result.images : [])
        .flatMap((image) => [image?.assetId, image?.sourceAssetId, image?.deliveryAssetId])
        .map(Number)
        .filter((id) => Number.isSafeInteger(id) && id > 0))];
      await client.query(`
        UPDATE assets SET active = id = ANY($3::bigint[])
        WHERE task_id = $1 AND image_production_chain_id = $2
      `, [execution.task_id, execution.image_production_chain_id, referencedAssetIds]);
      const task = await client.query(`
        UPDATE tasks SET
          state = 'MANUAL_ARCHIVE', current_execution_id = NULL,
          current_stage = 'MANUAL_ARCHIVE', progress_percent = 100,
          progress_message = '图片生成完成，等待人工归档',
          image_production_duration_ms = image_production_duration_ms
            + GREATEST(0, EXTRACT(EPOCH FROM (now() - $3::timestamptz)) * 1000)::bigint,
          last_activity_at = now(), finished_at = now(), updated_at = now()
        WHERE id = $1 AND current_execution_id = $2
        RETURNING *
      `, [execution.task_id, executionId, execution.started_at]);
      return taskFrom(task.rows[0]);
    });
  }

  async failExecution(rawExecutionId, rawError, { autoRetry = true } = {}) {
    if (typeof autoRetry !== 'boolean') throw new TypeError('autoRetry must be a boolean');
    const executionId = normalizeUuid(rawExecutionId, 'executionId');
    const message = redactExecutionError(rawError);
    // Both progress columns are varchar(500); keep longer diagnostics in error (text).
    const progressMessage = [...message].slice(0, 500).join('');
    return transaction(this.pool, async (client) => {
      const execution = await lockedExecution(client, executionId);
      const isImage = execution.kind === 'IMAGE';
      const manual = isImage && !autoRetry;
      // The executor reports only after its entire run (including internal retries) fails.
      // Persist the budget in the next execution's snapshot, not in process-local memory.
      const failedAttempts = isImage ? (execution.snapshot?.imageRetry?.failedAttempts ?? 0) + 1 : 0;
      const exhausted = isImage && failedAttempts >= MAX_IMAGE_ATTEMPTS;
      const nextState = isImage ? (manual ? 'IMAGE_FAILED' : exhausted ? 'COPY_REVIEW_PENDING' : 'IMAGE_QUEUED') : 'COPY_FAILED';
      const retrySnapshot = isImage && !exhausted && !manual ? {
        ...await withSavedVisualPlan(client, executionId, execution.snapshot),
        imageRetry: { failedAttempts, nodeId: execution.node_id },
        ...(hasLayoutCatalog(execution.snapshot) ? { imageRecovery: { nodeId: execution.node_id,
          runIds: [...new Set([executionId, ...(execution.snapshot.imageRecovery?.runIds ?? [])])] } } : {}),
      } : null;
      const taskMessage = isImage
        ? manual ? '执行失败，已停止自动重试；请检查错误详情与检查点后人工续跑'
          : exhausted ? '生图3次失败，自动重试已停止；可人工重试，或修订后提交强制复检'
          : `生图第${failedAttempts}次失败，等待原执行机重试（最多${MAX_IMAGE_ATTEMPTS}次）`
        : progressMessage;
      await client.query(`
        UPDATE task_executions SET
          status = 'FAILED', progress_message = $2,
          error = $3, last_activity_at = now(), finished_at = now()
        WHERE id = $1
      `, [executionId, progressMessage, message]);
      if (isImage) {
        await client.query(`
          UPDATE image_runs SET status = 'FAILED', finished_at = now() WHERE id = $1
        `, [executionId]);
        await client.query('UPDATE assets SET active = false WHERE image_run_id = $1', [executionId]);
      }
      const lifecycle = isImage
        ? `current_stage = $7, progress_percent = $8,
           current_image_run_id = ${exhausted || manual ? 'current_image_run_id' : 'NULL'}, pending_snapshot = $6,
           mandatory_copy_qc = CASE WHEN ${exhausted && !manual} THEN true ELSE mandatory_copy_qc END,
           mandatory_copy_qc_origin = CASE WHEN ${exhausted && !manual} THEN 'IMAGE_RETRY_REVIEW' ELSE mandatory_copy_qc_origin END,
           requeue_reason = 'AUTO_RECOVERY',
           execution_started_at = $9, finished_at = ${exhausted || manual ? 'now()' : 'NULL'},`
        : 'current_stage = $6, finished_at = now(),';
      const values = [execution.task_id, nextState, taskMessage, message, executionId];
      // Terminal failures retain the last actual stage, progress and start time.
      // A queued retry starts a new lifecycle and therefore resets only those fields.
      if (isImage) values.push(retrySnapshot,
        manual ? execution.stage ?? 'FAILED' : exhausted ? 'IMAGE_RETRY_EXHAUSTED' : 'IMAGE_QUEUED',
        manual || exhausted ? Number(execution.progress_percent ?? 0) : 0,
        manual || exhausted ? execution.started_at ?? null : null,
        execution.started_at ?? null);
      else values.push(execution.stage ?? 'FAILED');
      const task = await client.query(`
        UPDATE tasks SET
          state = $2, current_execution_id = NULL, ${lifecycle}
          ${isImage ? `image_production_duration_ms = image_production_duration_ms
            + GREATEST(0, EXTRACT(EPOCH FROM (now() - $10::timestamptz)) * 1000)::bigint,` : ''}
          progress_message = $3, error = $4, last_activity_at = now(),
          updated_at = now()
        WHERE id = $1 AND current_execution_id = $5
        RETURNING *
      `, values);
      return taskFrom(task.rows[0]);
    });
  }

  async activeImageUploadContext(rawExecutionId, queryable = this.pool) {
    const executionId = normalizeUuid(rawExecutionId, 'executionId');
    const result = await queryable.query(`
      SELECT e.id, e.task_id, e.image_production_chain_id, r.id AS image_run_id
      FROM task_executions e
      JOIN tasks t ON t.current_execution_id = e.id
      JOIN image_runs r ON r.execution_id = e.id
      WHERE e.id = $1 AND e.kind = 'IMAGE' AND e.status = 'RUNNING'
    `, [executionId]);
    if (!result.rows[0]) {
      throw new ControlPlaneConflictError(
        'STALE_EXECUTION',
        'execution is no longer current and cannot upload assets',
      );
    }
    return {
      executionId,
      taskId: Number(result.rows[0].task_id),
      imageRunId: result.rows[0].image_run_id,
      imageProductionChainId: result.rows[0].image_production_chain_id,
    };
  }

  async recordAsset({
    executionId: rawExecutionId,
    mediaType,
    byteSize,
    sha256,
    storagePath,
    originalName = null,
  }) {
    const executionId = normalizeUuid(rawExecutionId, 'executionId');
    if (![...Object.values(IMAGE_FORMATS).map(format => format.mediaType), 'application/json'].includes(mediaType)) {
      throw new TypeError('asset mediaType is invalid');
    }
    if (!Number.isSafeInteger(byteSize) || byteSize < 0) throw new TypeError('asset byteSize is invalid');
    if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new TypeError('asset sha256 is invalid');
    const artifactKey = normalizedArtifactKey(originalName, mediaType, sha256);
    return transaction(this.pool, async client => {
      // Serialize validation and insertion with completion/recovery. An earlier
      // HTTP upload check alone cannot fence a late write after recovery commits.
      await lockedExecution(client, executionId);
      const context = await this.activeImageUploadContext(executionId, client);
      const existing = await client.query(`
        SELECT * FROM assets
        WHERE image_production_chain_id = $1 AND artifact_key = $2
        FOR UPDATE
      `, [context.imageProductionChainId, artifactKey]);
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (row.sha256 !== sha256 || row.media_type !== mediaType
          || Number(row.byte_size) !== byteSize || Number(row.task_id) !== context.taskId) {
          throw new ControlPlaneConflictError(
            'ASSET_IDEMPOTENCY_CONFLICT',
            '同一图片生产链中的同名产物内容不一致，请停止执行并检查恢复文件',
          );
        }
        const reused = (await client.query(`
          UPDATE assets SET image_run_id = $2, active = true
          WHERE id = $1 RETURNING *
        `, [row.id, context.imageRunId])).rows[0];
        return {
          id: Number(reused.id), taskId: Number(reused.task_id),
          imageRunId: reused.image_run_id, mediaType: reused.media_type,
          byteSize: Number(reused.byte_size), sha256: reused.sha256,
          createdAt: reused.created_at, reused: true,
        };
      }
      const result = await client.query(`
        INSERT INTO assets(
          task_id, image_run_id, media_type, byte_size, sha256, storage_path, original_name,
          image_production_chain_id, artifact_key, origin_image_run_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $2)
        RETURNING *
      `, [
        context.taskId,
        context.imageRunId,
        mediaType,
        byteSize,
        sha256,
        storagePath,
        originalName === null ? null : String(originalName).slice(0, 255),
        context.imageProductionChainId,
        artifactKey,
      ]);
      const row = result.rows[0];
      return {
        id: Number(row.id),
        taskId: Number(row.task_id),
        imageRunId: row.image_run_id,
        mediaType: row.media_type,
        byteSize: Number(row.byte_size),
        sha256: row.sha256,
        createdAt: row.created_at,
        reused: false,
      };
    });
  }

  async imageReprocessAsset(rawExecutionId, rawAssetId) {
    const executionId = normalizeUuid(rawExecutionId, 'executionId');
    const assetId = normalizeTaskId(rawAssetId);
    return transaction(this.pool, async client => {
      const execution = await lockedExecution(client, executionId);
      const local = execution.snapshot?.copyRevision?.content?.imageReprocess;
      const pinned = local?.sources?.find(item => item.assetId === assetId);
      if (execution.kind !== 'IMAGE' || !pinned) throw new ControlPlaneNotFoundError('source asset not found');
      const asset = await this.getAsset(assetId, client);
      if (!asset || asset.taskId !== Number(execution.task_id) || asset.imageRunId !== local.sourceRunId || asset.sha256 !== pinned.sha256) throw new ControlPlaneNotFoundError('source asset not found');
      return asset;
    });
  }

  async getAsset(rawAssetId, queryable = this.pool) {
    const assetId = normalizeTaskId(rawAssetId);
    const result = await queryable.query('SELECT * FROM assets WHERE id = $1 AND content_cleared_at IS NULL', [assetId]);
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return {
      id: Number(row.id),
      taskId: Number(row.task_id),
      imageRunId: row.image_run_id,
      mediaType: row.media_type,
      byteSize: Number(row.byte_size),
      sha256: row.sha256,
      storagePath: row.storage_path,
      originalName: row.original_name,
      createdAt: row.created_at,
    };
  }
}
