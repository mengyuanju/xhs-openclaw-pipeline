import { ControlPlaneConflictError } from './domain.mjs';
import { restoreSecondaryAssignment } from './secondary-assignment.mjs';
import { copyQualityImageGate } from './copy-quality-flow.mjs';
import { withdrawReadyDeliveryEntries } from './final-delivery.mjs';

// The caller holds the task and current administrator account locks.
export async function restoreDiscardedTask(client, task, actor, input) {
  if (task.state !== 'CANCELLED') {
    throw new ControlPlaneConflictError('RESTORE_UNAVAILABLE', '只有已废弃任务可以恢复，请刷新列表');
  }
  if (typeof input?.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(input.expectedUpdatedAt))) {
    throw new TypeError('expectedUpdatedAt is required');
  }
  if (Date.parse(input.expectedUpdatedAt) !== new Date(task.updated_at).getTime()) {
    throw new ControlPlaneConflictError('TASK_CHANGED', '任务已变化，请刷新后重新恢复');
  }
  if (task.cancelled_from_state === 'PENDING_SECOND_ASSIGNMENT') return restoreSecondaryAssignment(client, task, actor);
  const versions = (await client.query(`
    SELECT ${copyQualityImageGate('task')} AS copy_released,
      EXISTS (SELECT 1 FROM image_runs run WHERE run.id = task.current_image_run_id
        AND run.task_id = task.id AND run.copy_revision_id = task.current_copy_revision_id
        AND run.status = 'COMPLETED') AS image_completed,
      EXISTS (SELECT 1 FROM image_approval_events approval WHERE approval.task_id = task.id
        AND approval.image_run_id = task.current_image_run_id) AS image_submitted
    FROM tasks task WHERE task.id = $1
  `, [task.id])).rows[0];
  const imageStage = /^(?:IMAGE_|MANUAL_ARCHIVE$|REVIEWED$)/u.test(task.cancelled_from_state ?? '')
    || (!task.cancelled_from_state && task.current_image_run_id);
  const restoreImages = Boolean(imageStage && versions?.copy_released);
  const completedImages = restoreImages && versions.image_completed;
  const state = completedImages
    ? versions.image_submitted || task.cancelled_from_state === 'IMAGE_REWORK_PENDING'
      ? 'IMAGE_REWORK_PENDING' : 'MANUAL_ARCHIVE'
    : restoreImages ? 'IMAGE_QUEUED'
      : task.current_copy_revision_id ? 'COPY_REVIEW_PENDING' : 'COPY_QUEUED';
  const messages = {
    COPY_QUEUED: '已从废弃池恢复，等待生成文案并重新审核',
    COPY_REVIEW_PENDING: '已从废弃池恢复，等待文案审核并提交强制复检',
    IMAGE_QUEUED: '已从废弃池恢复，等待重新生成图片',
    MANUAL_ARCHIVE: '已从废弃池恢复，等待图片初审并提交强制复检',
    IMAGE_REWORK_PENDING: '已从废弃池恢复，请修改图片后重新初审并提交强制复检',
  };
  let revisionId = task.current_copy_revision_id;
  if (!restoreImages && revisionId) {
    // A new draft keeps prior scores, approvals and discard decisions immutable.
    const revision = (await client.query(`
      INSERT INTO copy_revisions(task_id, revision, content, parent_revision_id,
        revision_origin, copy_content_changed_from_machine, copy_rework_satisfied)
      SELECT source.task_id, (SELECT COALESCE(max(revision), 0) + 1 FROM copy_revisions WHERE task_id = $1),
        source.content, source.id, 'DISCARD_RESTORE', source.copy_content_changed_from_machine, false
      FROM copy_revisions source WHERE source.task_id = $1 AND source.id = $2
      RETURNING id
    `, [task.id, revisionId])).rows[0];
    if (!revision) throw new ControlPlaneConflictError('RESTORE_SOURCE_MISSING', '文案版本缺失，无法恢复');
    revisionId = revision.id;
  }
  await withdrawReadyDeliveryEntries(client, Number(task.id), 'DISCARDED_TASK_RESTORED');
  const updated = (await client.query(`
    UPDATE tasks SET state = $2::varchar, current_stage = $2::varchar, cancelled_from_state = NULL,
      current_copy_revision_id = $3,
      current_image_run_id = CASE WHEN $4 THEN current_image_run_id ELSE NULL END,
      current_execution_id = NULL, pending_snapshot = NULL, execution_started_at = NULL,
      image_production_chain_id = CASE WHEN $4 THEN image_production_chain_id ELSE NULL END,
      image_production_started_at = CASE WHEN $4 THEN image_production_started_at ELSE NULL END,
      image_production_duration_ms = CASE WHEN $4 THEN image_production_duration_ms ELSE 0 END,
      skip_copy_review = CASE WHEN $5 THEN skip_copy_review ELSE false END,
      mandatory_copy_qc = CASE WHEN $5 THEN mandatory_copy_qc ELSE true END,
      mandatory_copy_qc_origin = CASE WHEN $5 OR mandatory_copy_qc THEN mandatory_copy_qc_origin ELSE 'DISCARD_RESTORE' END,
      copy_qc_released_revision_id = CASE WHEN $5 THEN copy_qc_released_revision_id ELSE NULL END,
      mandatory_image_qc = true,
      mandatory_image_qc_origin = COALESCE(mandatory_image_qc_origin, 'DISCARD_RESTORE'),
      image_qc_released_approval_event_id = NULL, image_qc_legacy_accepted = false,
      image_reviewed_at = NULL, image_reviewed_by_user_id = NULL,
      image_rework_source_run_id = CASE WHEN $2::varchar = 'IMAGE_REWORK_PENDING' THEN current_image_run_id ELSE NULL END,
      requeue_reason = 'MANUAL_RETRY', progress_percent = 0, progress_message = $6,
      error = NULL, finished_at = NULL, last_activity_at = now(), updated_at = now()
    WHERE id = $1 RETURNING *
  `, [task.id, state, revisionId, Boolean(completedImages), restoreImages, messages[state]])).rows[0];
  await client.query(`
    INSERT INTO task_restore_events(task_id, cancelled_from_state, restored_state,
      source_copy_revision_id, restored_copy_revision_id, source_image_run_id,
      actor_account_id, actor_username)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  `, [task.id, task.cancelled_from_state, updated.state, task.current_copy_revision_id,
    revisionId, task.current_image_run_id, actor.userId, actor.username]);
  // Duplicate cleanup is the only cancellation that also cancels acquisition.
  await client.query(`
    UPDATE xhs_query_search_jobs AS search SET status = 'PENDING', attempt_count = 0,
      claimed_by_node_id = NULL, lease_token = NULL, lease_expires_at = NULL,
      retry_after = NULL, blocked_reason = NULL, error = NULL,
      result_count = 0, searched_at = NULL, updated_at = now()
    WHERE search.task_id = $1 AND search.status = 'CANCELLED'
      AND EXISTS (SELECT 1 FROM task_duplicate_query_discard_audits audit WHERE audit.discarded_task_id = $1)
  `, [task.id]);
  return updated;
}
