import { COPY_QA_REASON_GROUPS, copyQaReasonDefinition } from '../../src/copy-qa-reasons.mjs';
import { DEFAULT_IMAGE_REASONS } from '../../src/human-quality-settings.mjs';
import { normalizeTaskId } from './domain.mjs';

const GROUP_LABELS = new Map(COPY_QA_REASON_GROUPS.map(group => [group.code, group.label]));
const IMAGE_LABELS = new Map(DEFAULT_IMAGE_REASONS.map(reason => [reason.code, reason.label]));

// The active assignment identifies its own reset case. Timestamps on disposition
// may follow the assignment by a few milliseconds, so they are not a join key.
const FEEDBACK_SQL = `
  WITH active_assignment AS (
    SELECT assignment.* FROM task_assignment_records AS assignment
    JOIN tasks AS task ON task.id=assignment.task_id
      AND task.assigned_to_user_id=assignment.assignee_username_snapshot
      AND task.assigned_at=assignment.assigned_at
    WHERE assignment.task_id=$1 AND assignment.ended_at IS NULL
      AND assignment.source='SECOND_ASSIGNMENT'
  ), current_case AS (
    SELECT reassignment.*, assignment.assigned_at AS current_assigned_at,
      source_member.reason_snapshots AS source_reason_snapshots,
      source_member.decided_at AS source_decided_at,
      source_legacy.id AS validated_copy_item_id,
      source_legacy.reviewed_at AS source_legacy_reviewed_at,
      source_image.id AS validated_image_item_id,
      source_image.reviewed_at AS source_image_reviewed_at,
      COALESCE(source_member.quality_cycle, (
        SELECT count(*)::integer FROM task_reassignment_cases AS previous
        WHERE previous.task_id=reassignment.task_id AND previous.status='REASSIGNED'
          AND previous.disposed_at <= reassignment.created_at
          AND previous.id<>reassignment.id
      )) AS previous_quality_cycle
    FROM active_assignment AS assignment
    JOIN task_reassignment_cases AS reassignment ON reassignment.task_id=assignment.task_id
      AND reassignment.assignment_record_id=assignment.previous_record_id
      AND reassignment.target_account_id=assignment.assignee_account_id
      AND reassignment.status='REASSIGNED' AND reassignment.reset_status='READY'
      AND reassignment.created_at <= assignment.assigned_at
    LEFT JOIN copy_qa_batch_members_v2 AS source_member
      ON reassignment.stage='COPY' AND source_member.id=reassignment.source_copy_qa_member_v2_id
      AND source_member.task_id=reassignment.task_id
    LEFT JOIN copy_sampling_items AS source_legacy
      ON reassignment.stage='COPY' AND source_legacy.id=reassignment.source_item_id
      AND source_legacy.task_id=reassignment.task_id
    LEFT JOIN image_sampling_items AS source_image
      ON reassignment.stage='IMAGE' AND source_image.id=reassignment.source_item_id
      AND source_image.task_id=reassignment.task_id
    ORDER BY reassignment.id DESC LIMIT 1
  ), feedback AS (
    SELECT 0 AS priority, current_case.id AS order_id, current_case.stage,
      current_case.reason_codes,
      COALESCE(current_case.source_reason_snapshots, source_event.details->'reasonSnapshots', '[]'::jsonb) AS reason_snapshots,
      current_case.note,
      COALESCE(current_case.source_decided_at, current_case.source_legacy_reviewed_at,
        current_case.source_image_reviewed_at, current_case.created_at) AS reviewed_at
    FROM current_case
    LEFT JOIN LATERAL (
      SELECT source.details FROM (
        SELECT event.details,event.created_at,event.id FROM copy_sampling_events AS event
        WHERE current_case.stage='COPY' AND event.sampling_item_id=current_case.validated_copy_item_id
          AND event.action='ESCALATE_ADMIN' AND event.details->>'caseId'=current_case.id::text
        UNION ALL
        SELECT event.details,event.created_at,event.id FROM image_sampling_events AS event
        WHERE current_case.stage='IMAGE' AND event.sampling_item_id=current_case.validated_image_item_id
          AND event.action='ESCALATE_ADMIN' AND event.details->>'caseId'=current_case.id::text
      ) AS source ORDER BY source.created_at DESC,source.id DESC LIMIT 1
    ) AS source_event ON true
    UNION ALL
    SELECT 1, event.id, 'COPY',
      COALESCE(member.reason_codes, legacy_event.reason_codes, legacy.reason_codes),
      COALESCE(member.reason_snapshots, legacy_event.details->'reasonSnapshots', '[]'::jsonb),
      COALESCE(member.note, legacy_event.note, legacy.note),
      COALESCE(member.decided_at, legacy_event.created_at, legacy.reviewed_at, event.created_at)
    FROM current_case
    JOIN copy_qa_return_events_v2 AS event ON event.task_id=current_case.task_id
      AND event.quality_cycle=current_case.previous_quality_cycle
      AND event.created_at <= current_case.created_at
      AND (current_case.source_copy_qa_member_v2_id IS NULL
        OR event.member_id IS DISTINCT FROM current_case.source_copy_qa_member_v2_id)
      AND (current_case.stage<>'COPY' OR current_case.source_item_id IS NULL
        OR event.legacy_item_id IS DISTINCT FROM current_case.source_item_id)
    LEFT JOIN copy_qa_batch_members_v2 AS member ON member.id=event.member_id
      AND member.task_id=event.task_id AND member.quality_cycle=event.quality_cycle
    LEFT JOIN copy_sampling_items AS legacy ON legacy.id=event.legacy_item_id
      AND legacy.task_id=event.task_id
    LEFT JOIN LATERAL (
      SELECT verdict.reason_codes,verdict.note,verdict.details,verdict.created_at
      FROM copy_sampling_events AS verdict
      WHERE legacy.id IS NOT NULL AND verdict.freeze_id=legacy.freeze_id
        AND verdict.created_at <= current_case.created_at
        AND ((verdict.action='RETURN_SINGLE' AND verdict.sampling_item_id=legacy.id)
          OR (verdict.action='RETURN_BATCH' AND (verdict.sampling_item_id=legacy.id
            OR verdict.details->'affectedItemIds' ? legacy.public_id::text)))
      ORDER BY verdict.created_at DESC,verdict.id DESC LIMIT 1
    ) AS legacy_event ON true
    WHERE member.id IS NOT NULL OR legacy.id IS NOT NULL
  ), limited_feedback AS (
    SELECT * FROM feedback
    ORDER BY priority,reviewed_at DESC NULLS LAST,order_id DESC LIMIT 50
  )
  SELECT current_case.current_assigned_at AS assigned_at,
    (SELECT jsonb_agg(jsonb_build_object(
      'stage',feedback.stage,'reasonCodes',feedback.reason_codes,
      'reasonSnapshots',feedback.reason_snapshots,'note',feedback.note,
      'reviewedAt',feedback.reviewed_at
    ) ORDER BY feedback.priority,feedback.reviewed_at DESC NULLS LAST,feedback.order_id DESC)
      FROM limited_feedback AS feedback) AS entries
  FROM current_case`;

function isoDate(value) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function reasonLabels(codes, snapshots, stage) {
  const saved = Array.isArray(snapshots) ? snapshots : [];
  const entries = Array.isArray(codes) && codes.length
    ? codes.map(code => ({ code, snapshot: saved.find(entry => entry?.code === code) }))
    : saved.map(snapshot => ({ code: snapshot?.code, snapshot }));
  return [...new Set(entries.flatMap(({ code, snapshot }) => {
    const definition = stage === 'COPY' ? copyQaReasonDefinition(code) : null;
    const normalizedCode = typeof code === 'string' ? code.trim() : '';
    let label = typeof snapshot?.label === 'string' && snapshot.label.trim()
      ? snapshot.label.trim() : definition?.label
        ?? (stage === 'IMAGE' ? IMAGE_LABELS.get(normalizedCode) : null) ?? normalizedCode;
    if (/^CUSTOM:/iu.test(normalizedCode) && label === normalizedCode) label = '历史自定义问题标签';
    if (!label) return [];
    const group = GROUP_LABELS.get(snapshot?.group) ?? GROUP_LABELS.get(definition?.group);
    return [group && !label.startsWith(`${group} · `) ? `${group} · ${label}` : label];
  }))];
}

// Expose only verdict text. Source IDs, operator identities, cleared content and
// blind-review metadata remain in the database.
export function secondaryAssignmentFeedbackFrom(row) {
  if (!row) return null;
  const entries = (Array.isArray(row.entries) ? row.entries : []).flatMap(entry => {
    if (!entry || !['COPY', 'IMAGE'].includes(entry.stage)) return [];
    const labels = reasonLabels(entry.reasonCodes, entry.reasonSnapshots, entry.stage);
    const note = typeof entry.note === 'string' && entry.note.trim() ? entry.note.trim() : null;
    if (labels.length === 0 && !note) return [];
    return [{ stage: entry.stage, reasonLabels: labels, note, reviewedAt: isoDate(entry.reviewedAt) }];
  });
  return entries.length ? { assignedAt: isoDate(row.assigned_at), entries } : null;
}

export async function readSecondaryAssignmentFeedback(pool, taskId) {
  const result = await pool.query(FEEDBACK_SQL, [normalizeTaskId(taskId)]);
  return secondaryAssignmentFeedbackFrom(result.rows[0]);
}
