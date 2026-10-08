import { ControlPlaneAuthorizationError } from './domain.mjs';
import { readTaskActivityOverview } from './task-activity-overview.mjs';
import { readCachedReportAggregate, runLimitedReportExport, readReportFactVersion, TASK_REPORT_SOURCES } from './report-query-cache.mjs';

const TIME_FIELDS = new Set([
  'FIRST_MANUAL_COPY_ASSIGNMENT', 'FIRST_COPY_ASSIGNMENT', 'FIRST_COPY_REVIEW_ACTION', 'CREATED_AT',
  'COPY_REVIEW_PASSED_AT', 'COPY_QA_RELEASED_AT',
  'IMAGE_REVIEW_PASSED_AT', 'IMAGE_QA_RELEASED_AT',
]);
const PERSON_FIELDS = new Set([
  'ANNOTATOR', 'COPY_QA_REVIEWER', 'IMAGE_QA_REVIEWER',
  'LAST_COPY_REVIEWER', 'LAST_IMAGE_REVIEWER',
]);
const STATUS_VALUES = new Set(['PENDING', 'REVIEW_PASSED', 'QA_PENDING', 'QA_RELEASED', 'RETURNED']);
const SORT_FIELDS = new Set(['FIRST_MANUAL_COPY_ASSIGNMENT', 'FIRST_COPY_ASSIGNMENT', 'FIRST_COPY_REVIEW_ACTION', 'CREATED_AT', 'TASK_ID']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const CLOCK_RE = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u;
const MAX_CONDITIONS = 20;

const REPORT_TASK_SQL = `t.task_kind='CONTENT' AND NOT (t.input @> '{"testRun":true}'::jsonb)`;
const ASSIGNED_COPY_REVIEW_SQL = `t.state='COPY_REVIEW_PENDING' AND t.assigned_to_user_id IS NOT NULL`;
// Both delivery groups share current-version eligibility and apply their own date filters.
const CURRENT_DELIVERY_SQL = `${REPORT_TASK_SQL} AND t.state='REVIEWED' AND delivery.status='READY'
  AND t.current_copy_revision_id=delivery.copy_revision_id AND t.current_image_run_id=delivery.image_run_id
  AND (t.image_qc_legacy_accepted OR t.image_qc_released_approval_event_id IS NOT NULL)`;
const HAS_CURRENT_DELIVERY_SQL = `EXISTS(SELECT 1 FROM delivery_entries delivery
  WHERE delivery.task_id=t.id AND ${CURRENT_DELIVERY_SQL})`;

const FIRST_MANUAL_SQL = `(SELECT min(e.created_at) FROM task_assignment_events e
  WHERE e.task_id=t.id AND e.source='MANUAL' AND e.assignee_user_id IS NOT NULL)`;
const FIRST_COPY_SQL = `LEAST((SELECT min(e.created_at) FROM task_assignment_events e
  WHERE e.task_id=t.id AND e.assignee_user_id IS NOT NULL),
  (SELECT min(a.assigned_at) FROM task_assignment_records a WHERE a.task_id=t.id))`;
// Scoreless direct discards have no dedicated decision row; their task message identifies that review outcome.
const FIRST_COPY_REVIEW_SQL = `(SELECT min(reviewed_at) FROM (
  SELECT a.created_at AS reviewed_at FROM human_quality_assessments a
    WHERE a.task_id=t.id AND a.stage='COPY' AND a.action IN ('APPROVE','RETRY','DISCARD')
  UNION ALL
  SELECT a.created_at FROM task_reassignment_assessment_records a
    WHERE a.task_id=t.id AND a.stage='COPY' AND a.action IN ('APPROVE','RETRY','DISCARD')
  UNION ALL
  SELECT a.approved_at FROM copy_approval_events a
    WHERE a.task_id=t.id AND a.approval_mode='MANUAL'
  UNION ALL
  SELECT r.approved_at FROM copy_revisions r
    WHERE r.task_id=t.id AND r.approved_at IS NOT NULL
      AND r.approval_mode IS DISTINCT FROM 'ADMIN_BYPASS'
      AND NOT EXISTS(SELECT 1 FROM copy_approval_events a WHERE a.copy_revision_id=r.id)
  UNION ALL
  SELECT t.finished_at WHERE t.state='CANCELLED'
    AND t.cancelled_from_state='COPY_REVIEW_PENDING'
    AND t.progress_message='文案已被质检废弃'
) first_review_actions)`;
// A reassigned task starts a new review round; historical returns alone do not make it pending rework.
const COPY_QA_REWORK_SQL = `COALESCE(t.copy_qa_rework_pending
  OR (t.mandatory_copy_qc AND t.mandatory_copy_qc_origin='QA_RETURN'),false)`;
const COPY_INITIAL_REVIEW_PENDING_SQL = `${ASSIGNED_COPY_REVIEW_SQL} AND NOT ${COPY_QA_REWORK_SQL}`;
const COPY_REWORK_PENDING_SQL = `${ASSIGNED_COPY_REVIEW_SQL} AND ${COPY_QA_REWORK_SQL}
  AND ${FIRST_COPY_REVIEW_SQL} IS NOT NULL`;
// Tasks without a manual copy decision enter the report on their bypass or current discard date.
const FIRST_REPORT_EVENT_SQL = `LEAST(
  ${FIRST_COPY_REVIEW_SQL},
  (SELECT min(a.approved_at) FROM copy_approval_events a
    WHERE a.task_id=t.id AND a.approval_mode='ADMIN_BYPASS'),
  (SELECT min(r.approved_at) FROM copy_revisions r
    WHERE r.task_id=t.id AND r.approval_mode='ADMIN_BYPASS'
      AND r.approved_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM copy_approval_events a WHERE a.copy_revision_id=r.id)),
  CASE WHEN t.state='CANCELLED' THEN t.finished_at END
)`;
const COPY_REVIEW_SQL = `COALESCE((SELECT a.approved_at FROM copy_approval_events a
  WHERE a.task_id=t.id AND a.copy_revision_id=t.current_copy_revision_id
  ORDER BY a.approved_at DESC,a.id DESC LIMIT 1),
  (SELECT r.approved_at FROM copy_revisions r WHERE r.id=t.current_copy_revision_id))`;
const IMAGE_REVIEW_SQL = `(SELECT a.submitted_at FROM image_approval_events a
  WHERE a.task_id=t.id AND a.image_run_id=t.current_image_run_id
  ORDER BY a.submitted_at DESC,a.id DESC LIMIT 1)`;
const COPY_QA_RELEASE_SQL = `CASE WHEN t.current_copy_revision_id IS NOT NULL
    AND t.copy_qc_released_revision_id=t.current_copy_revision_id THEN COALESCE(
      (SELECT CASE WHEN m.status='RELEASED' THEN b.completed_at ELSE m.decided_at END
       FROM copy_qa_batch_members_v2 m JOIN copy_qa_batches_v2 b ON b.id=m.batch_id
       WHERE m.task_id=t.id AND m.copy_revision_id=t.current_copy_revision_id
         AND m.status IN ('PASSED','RELEASED') ORDER BY m.id DESC LIMIT 1),
      (SELECT CASE WHEN i.status='RELEASED' THEN COALESCE(f.resolved_at,i.updated_at)
                   ELSE COALESCE(f.resolved_at,i.reviewed_at) END
       FROM copy_sampling_items i JOIN copy_sampling_freezes f ON f.id=i.freeze_id
       WHERE i.task_id=t.id AND i.copy_revision_id=t.current_copy_revision_id
         AND i.status IN ('PASSED','RELEASED') ORDER BY i.id DESC LIMIT 1),
      (SELECT d.created_at FROM copy_qa_admin_direct_approvals d
       WHERE d.task_id=t.id AND d.copy_revision_id=t.current_copy_revision_id LIMIT 1),
      ${COPY_REVIEW_SQL}) END`;
const IMAGE_QA_RELEASE_SQL = `CASE WHEN t.image_qc_released_approval_event_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM image_approval_events approval
      WHERE approval.id=t.image_qc_released_approval_event_id
        AND approval.image_run_id=t.current_image_run_id) THEN COALESCE(
      (SELECT CASE WHEN i.status='RELEASED' THEN COALESCE(f.resolved_at,i.updated_at)
                   ELSE COALESCE(t.image_reviewed_at,f.resolved_at,i.reviewed_at) END
       FROM image_sampling_items i JOIN image_sampling_freezes f ON f.id=i.freeze_id
       WHERE i.task_id=t.id AND i.approval_event_id=t.image_qc_released_approval_event_id
         AND i.status IN ('PASSED','RELEASED') ORDER BY i.id DESC LIMIT 1),
      t.image_reviewed_at) END`;
const COPY_STATUS_SQL = `CASE
  WHEN t.current_copy_revision_id IS NOT NULL
    AND t.copy_qc_released_revision_id=t.current_copy_revision_id THEN 'QA_RELEASED'
  WHEN ${COPY_QA_REWORK_SQL} OR t.state='PENDING_SECOND_ASSIGNMENT' THEN 'RETURNED'
  WHEN t.state='COPY_QC_PENDING' THEN 'QA_PENDING'
  WHEN ${COPY_REVIEW_SQL} IS NOT NULL THEN 'REVIEW_PASSED'
  ELSE 'PENDING' END`;
const IMAGE_STATUS_SQL = `CASE
  WHEN t.image_qc_released_approval_event_id IS NOT NULL AND EXISTS(
    SELECT 1 FROM image_approval_events a WHERE a.id=t.image_qc_released_approval_event_id
      AND a.image_run_id=t.current_image_run_id) THEN 'QA_RELEASED'
  WHEN t.state='IMAGE_REWORK_PENDING' THEN 'RETURNED'
  WHEN t.state='IMAGE_QC_PENDING' THEN 'QA_PENDING'
  WHEN ${IMAGE_REVIEW_SQL} IS NOT NULL THEN 'REVIEW_PASSED'
  ELSE 'PENDING' END`;
const COPY_REJECTION_SQL = `((SELECT count(*) FROM human_quality_assessments a
  WHERE a.task_id=t.id AND a.stage='COPY' AND a.action='RETRY') +
  (SELECT count(*) FROM copy_qa_return_events_v2 e WHERE e.task_id=t.id))`;
const IMAGE_REJECTION_SQL = `((SELECT count(*) FROM human_quality_assessments a
  WHERE a.task_id=t.id AND a.stage='IMAGE' AND a.action='RETRY') +
  (SELECT count(DISTINCT e.id) FROM image_sampling_events e JOIN image_sampling_items i
    ON i.freeze_id=e.freeze_id AND (e.sampling_item_id IS NULL OR e.sampling_item_id=i.id)
   WHERE i.task_id=t.id AND e.action IN ('RETURN_SINGLE','RETURN_BATCH')))`;
const REJECTION_SQL = `(${COPY_REJECTION_SQL}+${IMAGE_REJECTION_SQL})`;
const REASSIGNMENT_SQL = `((SELECT count(*) FROM task_assignment_events e
  WHERE e.task_id=t.id AND e.previous_assignee_user_id IS NOT NULL
    AND e.assignee_user_id IS NOT NULL AND e.previous_assignee_user_id<>e.assignee_user_id) +
  (SELECT count(*) FROM task_reassignment_cases c WHERE c.task_id=t.id AND c.status='REASSIGNED'))`;
const TIME_SQL = Object.freeze({
  FIRST_MANUAL_COPY_ASSIGNMENT: FIRST_MANUAL_SQL,
  FIRST_COPY_ASSIGNMENT: FIRST_COPY_SQL,
  FIRST_COPY_REVIEW_ACTION: FIRST_REPORT_EVENT_SQL,
  CREATED_AT: 't.created_at',
  COPY_REVIEW_PASSED_AT: COPY_REVIEW_SQL,
  COPY_QA_RELEASED_AT: COPY_QA_RELEASE_SQL,
  IMAGE_REVIEW_PASSED_AT: IMAGE_REVIEW_SQL,
  IMAGE_QA_RELEASED_AT: IMAGE_QA_RELEASE_SQL,
});

function dateFromBeijingDay(day) {
  if (!DATE_RE.test(day)) throw new TypeError('日期格式应为 YYYY-MM-DD');
  const date = new Date(`${day}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime()) || date.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) !== day) {
    throw new TypeError('日期无效');
  }
  return date;
}

function beijingDay(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function beijingTime(day, clock, label) {
  dateFromBeijingDay(day);
  if (typeof clock !== 'string' || !CLOCK_RE.test(clock)) {
    throw new TypeError(`${label}应为 HH:mm:ss`);
  }
  return new Date(`${day}T${clock}+08:00`);
}

function positiveInteger(value, name, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new TypeError(`${name} 必须是有效正整数`);
  return number;
}

function conditionOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('查询条件无效');
  const { field, op = 'EQ' } = raw;
  const value = raw.value;
  if (PERSON_FIELDS.has(field)) {
    if (op !== 'EQ') throw new TypeError(`${field} 仅支持等于`);
    return { field, op, value: positiveInteger(value, field) };
  }
  if (field === 'TASK_ID') {
    if (op !== 'EQ') throw new TypeError('任务编号仅支持等于');
    return { field, op, value: positiveInteger(value, field) };
  }
  if (field === 'TASK_NAME') {
    if (!['EQ', 'CONTAINS'].includes(op) || typeof value !== 'string' || !value.trim() || value.length > 200) {
      throw new TypeError('任务名条件无效');
    }
    return { field, op, value: value.trim() };
  }
  if (field === 'TASK_ID_OR_NAME') {
    if (op !== 'CONTAINS' || typeof value !== 'string' || !value.trim() || [...value].length > 200) {
      throw new TypeError('任务ID或任务名条件无效');
    }
    return { field, op, value: value.trim() };
  }
  if (field === 'STATE') {
    if (op !== 'EQ' || typeof value !== 'string' || !/^[A-Z_]{2,40}$/u.test(value)) throw new TypeError('任务状态无效');
    return { field, op, value };
  }
  if (field === 'COPY_STATUS' || field === 'IMAGE_STATUS') {
    if (op !== 'EQ' || !STATUS_VALUES.has(value)) throw new TypeError('阶段状态无效');
    return { field, op, value };
  }
  if (field === 'REJECTION_COUNT' || field === 'REASSIGNMENT_COUNT') {
    if (!['EQ', 'GTE', 'LTE'].includes(op)) throw new TypeError('次数条件操作符无效');
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0 || number > 100_000) throw new TypeError('次数必须是非负整数');
    return { field, op, value: number };
  }
  throw new TypeError(`不支持的查询字段: ${String(field)}`);
}

export function normalizeTaskDataReportQuery(input = {}, now = new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('报表查询无效');
  const timeInput = input.time ?? { field: 'FIRST_COPY_REVIEW_ACTION', mode: 'RELATIVE', days: 1 };
  if (!timeInput || typeof timeInput !== 'object' || !TIME_FIELDS.has(timeInput.field)) throw new TypeError('时间字段无效');
  const mode = timeInput.mode ?? (timeInput.from || timeInput.to ? 'ABSOLUTE' : 'RELATIVE');
  let from, to;
  if (mode === 'RELATIVE') {
    const days = positiveInteger(timeInput.days ?? 30, '最近天数', 366);
    to = beijingDay(now);
    from = beijingDay(new Date(dateFromBeijingDay(to).getTime() - (days - 1) * 86_400_000));
  } else if (mode === 'ABSOLUTE') {
    from = timeInput.from;
    to = timeInput.to;
    dateFromBeijingDay(from);
    dateFromBeijingDay(to);
  } else throw new TypeError('时间模式无效');
  const fromTime = timeInput.fromTime ?? '00:00:00';
  const toTime = timeInput.toTime ?? '23:59:59';
  const start = beijingTime(from, fromTime, '开始时间');
  const lastSecond = beijingTime(to, toTime, '结束时间');
  if (start > lastSecond) throw new RangeError('结束时间不得早于开始时间');
  const end = new Date(lastSecond.getTime() + 1_000);
  const match = input.match ?? 'ALL';
  if (!['ALL', 'ANY'].includes(match)) throw new TypeError('条件组合方式无效');
  const rawConditions = input.conditions ?? [];
  if (!Array.isArray(rawConditions) || rawConditions.length > MAX_CONDITIONS) throw new TypeError('查询条件最多 20 个');
  const page = positiveInteger(input.page ?? 1, '页码', 1_000_000);
  const pageSize = positiveInteger(input.pageSize ?? 20, '每页条数', 200);
  const sort = input.sort ?? 'FIRST_COPY_REVIEW_ACTION';
  const order = input.order ?? 'DESC';
  if (!SORT_FIELDS.has(sort) || !['ASC', 'DESC'].includes(order)) throw new TypeError('排序方式无效');
  return {
    time: { field: timeInput.field, mode, from, to, fromTime, toTime, start: start.toISOString(), end: end.toISOString() },
    match, conditions: rawConditions.map(conditionOf), page, pageSize, sort, order,
  };
}

function escapedLike(value) {
  return value.replace(/[\\%_]/gu, '\\$&');
}

export function buildTaskDataReportFilter(query) {
  const params = [query.time.start, query.time.end];
  const where = [REPORT_TASK_SQL, `${TIME_SQL[query.time.field]} >= $1::timestamptz`, `${TIME_SQL[query.time.field]} < $2::timestamptz`];
  const fragments = query.conditions.map(({ field, op, value }) => {
    params.push(field === 'TASK_NAME' && op === 'CONTAINS' ? `%${escapedLike(value)}%` : value);
    const p = `$${params.length}`;
    if (field === 'ANNOTATOR') return `(EXISTS(SELECT 1 FROM task_assignment_records a WHERE a.task_id=t.id AND a.assignee_account_id=${p}::bigint)
      OR EXISTS(SELECT 1 FROM task_assignment_events e JOIN app_users u ON u.username=e.assignee_user_id
        AND u.created_at<=e.created_at WHERE e.task_id=t.id AND u.id=${p}::bigint))`;
    if (field === 'COPY_QA_REVIEWER') return `(EXISTS(SELECT 1 FROM copy_qa_batch_members_v2 m
        WHERE m.task_id=t.id AND m.status IN ('PASSED','DISCARDED') AND m.reviewed_by_account_id=${p}::bigint)
      OR EXISTS(SELECT 1 FROM copy_qa_return_events_v2 e
        LEFT JOIN copy_qa_batch_members_v2 m ON m.id=e.member_id
        LEFT JOIN copy_sampling_items legacy ON legacy.id=e.legacy_item_id
        WHERE e.task_id=t.id
          AND COALESCE(m.reviewed_by_account_id,legacy.reviewed_by_account_id)=${p}::bigint)
      OR EXISTS(SELECT 1 FROM copy_sampling_events e JOIN copy_sampling_items i ON i.id=e.sampling_item_id
        WHERE i.task_id=t.id AND e.action IN ('PASS','RETURN_SINGLE') AND e.actor_account_id=${p}::bigint)
      OR EXISTS(SELECT 1 FROM copy_sampling_items i WHERE i.task_id=t.id AND i.selected
        AND i.status IN ('PASSED','RETURNED') AND i.reviewed_at IS NOT NULL
        AND i.reviewed_by_account_id=${p}::bigint))`;
    if (field === 'IMAGE_QA_REVIEWER') return `(EXISTS(SELECT 1 FROM image_sampling_events e
      JOIN image_sampling_items i ON i.id=e.sampling_item_id
      WHERE i.task_id=t.id AND e.action IN ('PASS','RETURN_SINGLE')
        AND e.actor_account_id=${p}::bigint)
      OR EXISTS(SELECT 1 FROM image_sampling_events e JOIN image_sampling_items i ON i.freeze_id=e.freeze_id
        WHERE i.task_id=t.id AND e.action='RETURN_BATCH'
          AND (e.details->'affectedTaskIds') @> jsonb_build_array(i.task_id)
          AND e.actor_account_id=${p}::bigint)
      OR EXISTS(SELECT 1 FROM image_sampling_items i WHERE i.task_id=t.id
        AND ((i.selected AND i.status IN ('PASSED','RETURNED') AND i.reviewed_at IS NOT NULL)
          OR i.status='BATCH_RETURNED')
        AND i.reviewed_by_account_id=${p}::bigint))`;
    if (field === 'LAST_COPY_REVIEWER') return `(SELECT CASE WHEN a.approval_mode='MANUAL'
      THEN a.approved_by_account_id END FROM copy_approval_events a WHERE a.task_id=t.id
      AND a.copy_revision_id=t.current_copy_revision_id
      ORDER BY a.approved_at DESC,a.id DESC LIMIT 1)=${p}::bigint`;
    if (field === 'LAST_IMAGE_REVIEWER') return `(SELECT a.submitted_by_account_id
      FROM image_approval_events a WHERE a.task_id=t.id AND a.image_run_id=t.current_image_run_id
      ORDER BY a.submitted_at DESC,a.id DESC LIMIT 1)=${p}::bigint`;
    if (field === 'TASK_ID') return `t.id=${p}::bigint`;
    if (field === 'TASK_NAME') return op === 'CONTAINS' ? `t.query ILIKE ${p} ESCAPE '\\'` : `t.query=${p}`;
    if (field === 'TASK_ID_OR_NAME') {
      const idMatch = value.match(/^#(\d+)$/u);
      const taskId = idMatch ? Number(idMatch[1]) : null;
      if (Number.isSafeInteger(taskId) && taskId > 0) {
        params[params.length - 1] = taskId;
        return `t.id=${p}::bigint`;
      }
      return `position(lower(${p}) in lower(t.query))>0`;
    }
    if (field === 'STATE') return `t.state=${p}`;
    if (field === 'COPY_STATUS') return `${COPY_STATUS_SQL}=${p}`;
    if (field === 'IMAGE_STATUS') return `${IMAGE_STATUS_SQL}=${p}`;
    const left = field === 'REJECTION_COUNT' ? REJECTION_SQL : REASSIGNMENT_SQL;
    return `${left} ${op === 'EQ' ? '=' : op === 'GTE' ? '>=' : '<='} ${p}::bigint`;
  });
  if (fragments.length) where.push(`(${fragments.join(query.match === 'ANY' ? ' OR ' : ' AND ')})`);
  return { sql: where.join(' AND '), params };
}

const DETAIL_SQL = `SELECT t.id,t.query,t.state,t.created_at,t.production_batch_id,t.source_query_package_name,
  t.assigned_to_user_id,t.copy_qc_released_revision_id,t.current_copy_revision_id,
  qa_record.qa_method AS copy_qa_record_method,qa_record.passed AS copy_qa_record_passed,
  t.image_qc_released_approval_event_id,t.current_image_run_id,t.image_reviewed_at,
  t.copy_qa_rework_pending,t.updated_at,
  ${FIRST_MANUAL_SQL} AS first_manual_copy_assignment_at,
  ${FIRST_COPY_SQL} AS first_copy_assignment_at,
  ${FIRST_COPY_REVIEW_SQL} AS first_copy_review_at,
  ${FIRST_REPORT_EVENT_SQL} AS report_at,
  ${COPY_REVIEW_SQL} AS copy_review_passed_at,
  ${IMAGE_REVIEW_SQL} AS image_review_passed_at,
  ${COPY_QA_RELEASE_SQL} AS copy_qa_released_at,
  ${IMAGE_QA_RELEASE_SQL} AS image_qa_released_at,
  ${COPY_STATUS_SQL} AS copy_status,
  ${IMAGE_STATUS_SQL} AS image_status,
  ${COPY_REJECTION_SQL} AS copy_rejection_count,
  ${IMAGE_REJECTION_SQL} AS image_rejection_count,
  ${REASSIGNMENT_SQL} AS reassignment_count,
  ca.approval_mode AS copy_approval_mode,ca.approved_by_account_id AS copy_reviewer_account_id,
  ca.approved_by_username AS copy_reviewer_username,
  ia.id AS image_approval_id,ia.submitted_by_account_id AS image_reviewer_account_id,
  ia.submitted_by_username AS image_reviewer_username,
  cv2.status AS copy_v2_status,cv2.decided_at AS copy_v2_decided_at,
  cv2.reviewed_by_account_id AS copy_v2_reviewer_id,
  cl.status AS copy_legacy_status,cl.reviewed_at AS copy_legacy_reviewed_at,
  cl.reviewed_by_account_id AS copy_legacy_reviewer_id,
  il.status AS image_qa_status,il.reviewed_at AS image_qa_reviewed_at,
  il.reviewed_by_account_id AS image_qa_reviewer_id,
  direct.id AS copy_admin_direct_id,
  delivery.confirmed_at AS delivered_at,
  assignee_user.id AS current_annotator_id,assignee_user.display_name AS current_annotator_name,
  copy_user.display_name AS copy_reviewer_name,image_user.display_name AS image_reviewer_name
FROM tasks t
LEFT JOIN LATERAL(SELECT qa_method,passed FROM copy_qa_inspection_records
  WHERE task_id=t.id AND copy_revision_id=t.current_copy_revision_id
  ORDER BY recorded_at DESC,id DESC LIMIT 1) qa_record ON true
LEFT JOIN LATERAL(SELECT a.* FROM copy_approval_events a WHERE a.task_id=t.id
  AND a.copy_revision_id=t.current_copy_revision_id ORDER BY a.approved_at DESC,a.id DESC LIMIT 1) ca ON true
LEFT JOIN LATERAL(SELECT a.* FROM image_approval_events a WHERE a.task_id=t.id
  AND a.image_run_id=t.current_image_run_id ORDER BY a.submitted_at DESC,a.id DESC LIMIT 1) ia ON true
LEFT JOIN LATERAL(SELECT m.* FROM copy_qa_batch_members_v2 m WHERE m.task_id=t.id
  AND m.copy_revision_id=t.current_copy_revision_id ORDER BY m.id DESC LIMIT 1) cv2 ON true
LEFT JOIN LATERAL(SELECT i.* FROM copy_sampling_items i WHERE i.task_id=t.id
  AND i.copy_revision_id=t.current_copy_revision_id ORDER BY i.id DESC LIMIT 1) cl ON true
LEFT JOIN LATERAL(SELECT i.* FROM image_sampling_items i WHERE i.task_id=t.id
  AND i.image_run_id=t.current_image_run_id ORDER BY i.id DESC LIMIT 1) il ON true
LEFT JOIN LATERAL(SELECT d.* FROM copy_qa_admin_direct_approvals d WHERE d.task_id=t.id
  AND d.copy_revision_id=t.current_copy_revision_id LIMIT 1) direct ON true
LEFT JOIN LATERAL(SELECT max(c.confirmed_at) AS confirmed_at FROM delivery_batch_items i
  JOIN delivery_item_confirmations c ON c.item_id=i.id WHERE i.task_id=t.id) delivery ON true
LEFT JOIN app_users assignee_user ON assignee_user.username=t.assigned_to_user_id
LEFT JOIN app_users copy_user ON copy_user.id=ca.approved_by_account_id
LEFT JOIN app_users image_user ON image_user.id=ia.submitted_by_account_id
WHERE t.id=ANY($1::bigint[])`;

const ASSIGNMENTS_SQL = `SELECT history.task_id,history.assignee_account_id,
  history.assignee_username_snapshot,history.assignee_display_name_snapshot,
  history.source,history.assigned_at,history.baseline,history.historical_event
FROM (
  SELECT a.task_id,a.assignee_account_id,a.assignee_username_snapshot,
    a.assignee_display_name_snapshot,a.source,a.assigned_at,a.baseline,
    false AS historical_event,a.id AS ordinal
  FROM task_assignment_records a WHERE a.task_id=ANY($1::bigint[])
  UNION ALL
  SELECT e.task_id,u.id,e.assignee_user_id,u.display_name,e.source,e.created_at,
    false,true,e.id
  FROM task_assignment_events e LEFT JOIN app_users u
    ON u.username=e.assignee_user_id AND u.created_at<=e.created_at
  WHERE e.task_id=ANY($1::bigint[]) AND e.assignee_user_id IS NOT NULL
    AND (e.created_at < (SELECT min(a.assigned_at) FROM task_assignment_records a WHERE a.task_id=e.task_id)
      OR NOT EXISTS(SELECT 1 FROM task_assignment_records a WHERE a.task_id=e.task_id))
) history ORDER BY history.task_id,history.assigned_at,history.historical_event,history.ordinal`;
const QA_PEOPLE_SQL = `SELECT p.task_id,p.stage,p.account_id,u.username,u.display_name
FROM (SELECT m.task_id,'COPY'::text AS stage,m.reviewed_by_account_id AS account_id
  FROM copy_qa_batch_members_v2 m WHERE m.task_id=ANY($1::bigint[])
    AND m.status IN ('PASSED','DISCARDED') AND m.reviewed_by_account_id IS NOT NULL
  UNION SELECT e.task_id,'COPY',COALESCE(m.reviewed_by_account_id,legacy.reviewed_by_account_id)
    FROM copy_qa_return_events_v2 e
    LEFT JOIN copy_qa_batch_members_v2 m ON m.id=e.member_id
    LEFT JOIN copy_sampling_items legacy ON legacy.id=e.legacy_item_id
    WHERE e.task_id=ANY($1::bigint[])
      AND COALESCE(m.reviewed_by_account_id,legacy.reviewed_by_account_id) IS NOT NULL
  UNION SELECT i.task_id,'COPY',e.actor_account_id
    FROM copy_sampling_events e JOIN copy_sampling_items i ON i.id=e.sampling_item_id
    WHERE i.task_id=ANY($1::bigint[]) AND e.action IN ('PASS','RETURN_SINGLE')
      AND e.actor_account_id IS NOT NULL
  UNION SELECT i.task_id,'COPY',i.reviewed_by_account_id FROM copy_sampling_items i
    WHERE i.task_id=ANY($1::bigint[]) AND i.selected AND i.status IN ('PASSED','RETURNED')
      AND i.reviewed_at IS NOT NULL AND i.reviewed_by_account_id IS NOT NULL
  UNION SELECT i.task_id,'IMAGE',e.actor_account_id
    FROM image_sampling_events e JOIN image_sampling_items i ON i.id=e.sampling_item_id
    WHERE i.task_id=ANY($1::bigint[]) AND e.action IN ('PASS','RETURN_SINGLE')
      AND e.actor_account_id IS NOT NULL
  UNION SELECT i.task_id,'IMAGE',e.actor_account_id
    FROM image_sampling_events e JOIN image_sampling_items i ON i.freeze_id=e.freeze_id
    WHERE i.task_id=ANY($1::bigint[]) AND e.action='RETURN_BATCH'
      AND (e.details->'affectedTaskIds') @> jsonb_build_array(i.task_id)
      AND e.actor_account_id IS NOT NULL
  UNION SELECT i.task_id,'IMAGE',i.reviewed_by_account_id FROM image_sampling_items i
    WHERE i.task_id=ANY($1::bigint[])
      AND ((i.selected AND i.status IN ('PASSED','RETURNED') AND i.reviewed_at IS NOT NULL)
        OR i.status='BATCH_RETURNED')
      AND i.reviewed_by_account_id IS NOT NULL) p
LEFT JOIN app_users u ON u.id=p.account_id ORDER BY p.task_id,p.stage,p.account_id`;

function iso(value) { return value == null ? null : new Date(value).toISOString(); }
function number(value) { return value == null ? null : Number(value); }
function person(accountId, username, displayName) {
  return accountId == null && !username ? null : {
    accountId: number(accountId), username: username ?? null,
    displayName: displayName ?? username ?? '历史账号',
  };
}

function rowFrom(row) {
  const copyReleased = row.copy_qa_released_at != null;
  const imageReleased = row.image_qa_released_at != null;
  const systemPassed = copyReleased && row.copy_qa_record_method === 'SYSTEM'
    && row.copy_qa_record_passed === true;
  const copyQaStatus = systemPassed ? 'SYSTEM_PASSED' : row.copy_v2_status ?? row.copy_legacy_status
    ?? (copyReleased ? 'NOT_REQUIRED_OR_LEGACY' : null);
  const imageQaStatus = row.image_qa_status
    ?? (imageReleased ? 'NOT_REQUIRED_OR_LEGACY' : null);
  const copyQaHumanPassedAt = row.copy_v2_status === 'PASSED' ? row.copy_v2_decided_at
    : row.copy_legacy_status === 'PASSED' ? row.copy_legacy_reviewed_at : null;
  const imageQaHumanPassedAt = row.image_qa_status === 'PASSED' ? row.image_qa_reviewed_at : null;
  const copyQaReleaseMode = !copyReleased ? null
    : systemPassed ? 'ACCOUNT_AUTO_PASS'
    : row.copy_v2_status === 'RELEASED' || row.copy_legacy_status === 'RELEASED'
    ? 'BATCH_RELEASE' : row.copy_admin_direct_id ? 'ADMIN_DIRECT'
      : copyQaHumanPassedAt ? 'HUMAN_PASS' : 'NO_QA_REQUIRED_OR_LEGACY';
  const imageQaReleaseMode = !imageReleased ? null : row.image_qa_status === 'RELEASED'
    ? 'BATCH_RELEASE' : imageQaHumanPassedAt ? 'HUMAN_PASS' : 'NO_QA_REQUIRED_OR_LEGACY';
  const copyRejectionCount = Number(row.copy_rejection_count);
  const imageRejectionCount = Number(row.image_rejection_count);
  return {
    taskId: Number(row.id), taskName: row.query, state: row.state,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    productionBatchId: number(row.production_batch_id), queryPackageName: row.source_query_package_name ?? null,
    firstManualCopyAssignmentAt: iso(row.first_manual_copy_assignment_at),
    firstCopyAssignmentAt: iso(row.first_copy_assignment_at),
    firstCopyReviewAt: iso(row.first_copy_review_at),
    reportAt: iso(row.report_at),
    annotationPeople: [],
    currentAnnotator: person(row.current_annotator_id, row.assigned_to_user_id, row.current_annotator_name),
    copyQaPeople: [], imageQaPeople: [],
    lastCopyReviewer: row.copy_approval_mode === 'MANUAL'
      ? person(row.copy_reviewer_account_id, row.copy_reviewer_username, row.copy_reviewer_name) : null,
    lastImageReviewer: person(row.image_reviewer_account_id, row.image_reviewer_username, row.image_reviewer_name),
    copyStatus: row.copy_status, imageStatus: row.image_status,
    copyQaStatus, imageQaStatus,
    copyRejectionCount, imageRejectionCount, rejectionCount: copyRejectionCount + imageRejectionCount,
    reassignmentCount: Number(row.reassignment_count),
    copyReviewPassedAt: iso(row.copy_review_passed_at),
    copyQaReleasedAt: iso(row.copy_qa_released_at),
    copyQaHumanPassedAt: iso(copyQaHumanPassedAt), copyQaReleaseMode,
    imageReviewPassedAt: iso(row.image_review_passed_at),
    imageQaReleasedAt: iso(row.image_qa_released_at),
    imageQaHumanPassedAt: iso(imageQaHumanPassedAt), imageQaReleaseMode,
    deliveredAt: iso(row.delivered_at),
    dataQuality: { assignmentHistoryIncomplete: false,
      copyApprovalHistoryIncomplete: row.copy_review_passed_at != null && !row.copy_approval_mode,
      imageApprovalHistoryIncomplete: row.current_image_run_id != null && row.image_approval_id == null },
  };
}

async function readDetailRows(client, ids) {
  if (!ids.length) return [];
  const details = await client.query(DETAIL_SQL, [ids]);
  const assignments = await client.query(ASSIGNMENTS_SQL, [ids]);
  const qaPeople = await client.query(QA_PEOPLE_SQL, [ids]);
  const byId = new Map(details.rows.map(row => [Number(row.id), rowFrom(row)]));
  for (const assignment of assignments.rows) {
    const item = byId.get(Number(assignment.task_id));
    if (!item) continue;
    item.annotationPeople.push({ ...person(assignment.assignee_account_id,
      assignment.assignee_username_snapshot, assignment.assignee_display_name_snapshot),
          assignedAt: iso(assignment.assigned_at), source: assignment.source,
          historyBaseline: assignment.baseline === true,
          historicalEvent: assignment.historical_event === true });
    if (assignment.baseline || assignment.historical_event) item.dataQuality.assignmentHistoryIncomplete = true;
  }
  for (const reviewer of qaPeople.rows) {
    const item = byId.get(Number(reviewer.task_id));
    if (!item) continue;
    item[reviewer.stage === 'COPY' ? 'copyQaPeople' : 'imageQaPeople'].push(
      person(reviewer.account_id, reviewer.username, reviewer.display_name));
  }
  return ids.map(id => byId.get(id)).filter(Boolean);
}

async function readTaskPoolOverview(client, asOf) {
  const row = (await client.query(`SELECT
    count(*) FILTER(WHERE ${COPY_INITIAL_REVIEW_PENDING_SQL})::integer AS copy_review_pending,
    count(*) FILTER(WHERE ${COPY_REWORK_PENDING_SQL})::integer AS copy_rework_pending,
    count(*) FILTER(WHERE state='PENDING_SECOND_ASSIGNMENT')::integer AS second_assignment_pending,
    count(*) FILTER(WHERE state='COPY_QC_PENDING')::integer AS copy_qa_pending,
    count(*) FILTER(WHERE state IN ('IMAGE_QUEUED','IMAGE_RUNNING'))::integer AS image_generating,
    count(*) FILTER(WHERE state IN ('MANUAL_ARCHIVE','IMAGE_REWORK_PENDING'))::integer AS image_review_pending,
    count(*) FILTER(WHERE state='IMAGE_QC_PENDING')::integer AS image_qa_pending,
    count(*) FILTER(WHERE ${HAS_CURRENT_DELIVERY_SQL})::integer AS delivery_total
    FROM tasks t WHERE ${REPORT_TASK_SQL} AND t.created_at <= $1::timestamptz`, [asOf])).rows[0] ?? {};
  return {
    copyReviewPending: Number(row.copy_review_pending ?? 0),
    copyReworkPending: Number(row.copy_rework_pending ?? 0),
    secondAssignmentPending: Number(row.second_assignment_pending ?? 0),
    copyQaPending: Number(row.copy_qa_pending ?? 0),
    imageGenerating: Number(row.image_generating ?? 0),
    imageReviewPending: Number(row.image_review_pending ?? 0),
    imageQaPending: Number(row.image_qa_pending ?? 0),
    deliveryTotal: Number(row.delivery_total ?? 0),
  };
}

async function readTaskDeliveryOverview(client,query) {
  const annotators=query.conditions.filter(condition=>condition.field==='ANNOTATOR');
  const params=[query.time.start,query.time.end,...annotators.map(condition=>condition.value)];
  const peopleFilter=annotators.length
    ? ` AND (${annotators.map((_,index)=>`operation.account_id=$${index+3}::bigint`)
      .join(query.match==='ANY'?' OR ':' AND ')})` : '';
  const rows=(await client.query(`WITH delivery_records AS (
    SELECT delivery.task_id,
      CASE WHEN confirmation.item_id IS NOT NULL THEN 'DELIVERED'
        WHEN item.id IS NOT NULL THEN 'PACKED' ELSE 'UNPACKED' END AS phase,
      delivery.approved_at AS ready_at,
      CASE WHEN item.id IS NOT NULL THEN owner.account_id ELSE ready_owner.account_id END AS account_id
    FROM tasks t JOIN delivery_entries delivery ON delivery.task_id=t.id
    LEFT JOIN delivery_batch_items item ON item.task_id=delivery.task_id
      AND item.copy_revision_id=delivery.copy_revision_id AND item.image_run_id=delivery.image_run_id
    LEFT JOIN delivery_batches batch ON batch.id=item.delivery_batch_id
    LEFT JOIN delivery_item_owners owner ON owner.item_id=item.id
    LEFT JOIN delivery_item_confirmations confirmation ON confirmation.item_id=item.id
    LEFT JOIN LATERAL (
      SELECT history.account_id FROM (
        SELECT assignment.id,assignment.assigned_at,assignment.assignee_account_id AS account_id,0 AS source_order
        FROM task_assignment_records assignment WHERE assignment.task_id=t.id
          AND assignment.assigned_at<=delivery.approved_at
          AND (assignment.ended_at IS NULL OR assignment.ended_at>delivery.approved_at)
        UNION ALL
        SELECT event.id,event.created_at,account.id,1
        FROM task_assignment_events event LEFT JOIN app_users account
          ON account.username=event.assignee_user_id AND account.created_at<=event.created_at
        WHERE event.task_id=t.id AND event.created_at<=delivery.approved_at
      ) history ORDER BY history.assigned_at DESC,history.source_order,history.id DESC LIMIT 1
    ) ready_owner ON item.id IS NULL
    WHERE ${CURRENT_DELIVERY_SQL}
  ) SELECT
    GROUPING(operation.account_id) AS all_people, operation.account_id,
    count(DISTINCT task_id) FILTER(WHERE phase='UNPACKED')::integer AS unpacked,
    count(DISTINCT task_id) FILTER(WHERE phase='PACKED')::integer AS packed,
    count(DISTINCT task_id) FILTER(WHERE phase='DELIVERED')::integer AS delivered
  FROM delivery_records operation WHERE ready_at >= $1::timestamptz
    AND ready_at < $2::timestamptz${peopleFilter}
  GROUP BY GROUPING SETS ((operation.account_id), ())`,params)).rows;
  const counts=row=>({unpacked:Number(row.unpacked ?? 0),packed:Number(row.packed ?? 0),delivered:Number(row.delivered ?? 0)});
  return {overview:counts(rows.find(row=>Number(row.all_people)===1)??{}),
    people:rows.filter(row=>Number(row.all_people)===0).map(row=>({
      accountId:row.account_id==null?null:Number(row.account_id),
      deliveryTotal:counts(row).unpacked+counts(row).packed+counts(row).delivered,
    }))};
}

async function readTaskImageReleaseOverview(client, query) {
  const annotators = query.conditions.filter(condition => condition.field === 'ANNOTATOR');
  const params = [query.time.start, query.time.end, ...annotators.map(condition => condition.value)];
  const peopleFilter = annotators.length
    ? ` AND (${annotators.map((_, index) => `owner.account_id=$${index + 3}::bigint`)
      .join(query.match === 'ANY' ? ' OR ' : ' AND ')})` : '';
  // A delivery entry is the durable record that an image version was finally
  // released, whether by sampled QA, batch release, exemption or legacy acceptance.
  // Keep withdrawn entries: they still passed at the time, even if later superseded.
  const rows = (await client.query(`SELECT GROUPING(owner.account_id) AS all_people,
    owner.account_id,count(DISTINCT delivery.id)::integer AS image_passed
    FROM tasks t JOIN delivery_entries delivery ON delivery.task_id=t.id
    LEFT JOIN LATERAL (
      SELECT history.account_id FROM (
        SELECT assignment.id,assignment.assigned_at,assignment.assignee_account_id AS account_id,0 AS source_order
        FROM task_assignment_records assignment WHERE assignment.task_id=t.id
          AND assignment.assigned_at<=delivery.approved_at
          AND (assignment.ended_at IS NULL OR assignment.ended_at>delivery.approved_at)
        UNION ALL
        SELECT event.id,event.created_at,account.id,1
        FROM task_assignment_events event LEFT JOIN app_users account
          ON account.username=event.assignee_user_id AND account.created_at<=event.created_at
        WHERE event.task_id=t.id AND event.created_at<=delivery.approved_at
      ) history ORDER BY history.assigned_at DESC,history.source_order,history.id DESC LIMIT 1
    ) owner ON true
    WHERE ${REPORT_TASK_SQL} AND delivery.approved_at >= $1::timestamptz
      AND delivery.approved_at < $2::timestamptz${peopleFilter}
    GROUP BY GROUPING SETS ((owner.account_id), ())`, params)).rows;
  return {
    total: Number(rows.find(row => Number(row.all_people) === 1)?.image_passed ?? 0),
    people: rows.filter(row => Number(row.all_people) === 0).map(row => ({
      accountId: row.account_id == null ? null : Number(row.account_id),
      imagePassed: Number(row.image_passed ?? 0),
    })),
  };
}

function assertAdmin(actor) {
  if (actor?.role !== 'ADMIN' || !Number.isSafeInteger(actor.userId) || actor.userId < 1) {
    throw new ControlPlaneAuthorizationError('仅管理员可以查看任务数据报表');
  }
}

export async function readTaskDataReport(pool, actor, input = {}, { now = new Date(), exportAll = false } = {}) {
  assertAdmin(actor);
  const query = normalizeTaskDataReportQuery(exportAll ? { ...input, page: 1, pageSize: 200 } : input, now);
  const filter = buildTaskDataReportFilter(query);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(exportAll ? "SET LOCAL statement_timeout='60s'" : "SET LOCAL statement_timeout='20s'");
    const snapshot = (await client.query('SELECT clock_timestamp() AS at')).rows[0];
    const snapshotVersion = await readReportFactVersion(client,TASK_REPORT_SOURCES);
    let asOf = iso(snapshot.at);
    const { page, pageSize, sort, order, ...aggregateFilters } = query;
    const aggregates = await readCachedReportAggregate(pool, 'task-data', actor, aggregateFilters,
      snapshotVersion, async () => {
    const poolOverview = await readTaskPoolOverview(client, asOf);
    const delivery = await readTaskDeliveryOverview(client,query);
    const releases = await readTaskImageReleaseOverview(client,query);
    const activity = await readTaskActivityOverview(client, query, asOf);
    const overview = delivery.overview;
    const activityOverview = activity.overview;
    const workByPerson = new Map();
    for (const row of [...activity.people, ...delivery.people, ...releases.people]) {
      const counts = workByPerson.get(row.accountId) ?? {
        accountId: row.accountId, copyReview: 0, copyRework: 0, imageReview: 0,
        imageFirstReview: 0, imageRework: 0, imagePassed: 0, deliveryTotal: 0,
      };
      for (const metric of ['copyReview', 'copyRework', 'imageReview',
        'imageFirstReview', 'imageRework', 'imagePassed', 'deliveryTotal']) {
        counts[metric] += row[metric] ?? 0;
      }
      workByPerson.set(row.accountId, counts);
    }
    const accountIds = [...workByPerson.keys()].filter(id => id !== null);
    const accountRows = accountIds.length ? (await client.query(
      'SELECT id,username,display_name FROM app_users WHERE id=ANY($1::bigint[])', [accountIds],
    )).rows : [];
    const accountById = new Map(accountRows.map(row => [Number(row.id), row]));
    const activityPeople = [...workByPerson.values()].map(row => ({
      ...row, username: accountById.get(row.accountId)?.username ?? null,
      displayName: accountById.get(row.accountId)?.display_name ?? null,
    })).sort((left, right) => (left.displayName || left.username || '')
      .localeCompare(right.displayName || right.username || '', 'zh-CN')
      || (left.accountId ?? 0) - (right.accountId ?? 0));
    const summaryRows = (await client.query(`WITH filtered AS MATERIALIZED (
      SELECT t.id,t.state,t.current_copy_revision_id,t.copy_qc_released_revision_id,
        t.current_image_run_id,t.image_qc_released_approval_event_id,t.image_qc_legacy_accepted,
        ${HAS_CURRENT_DELIVERY_SQL} AS delivery_eligible,
        ${ASSIGNED_COPY_REVIEW_SQL} AS copy_review_pending_eligible,
        ${COPY_INITIAL_REVIEW_PENDING_SQL} AS copy_initial_review_pending_eligible,
        ${COPY_REWORK_PENDING_SQL} AS copy_rework_pending_eligible
      FROM tasks t WHERE ${filter.sql})
      SELECT count(*)::integer AS total,
        count(*) FILTER(WHERE copy_review_pending_eligible)::integer AS copy_review_pending,
        count(*) FILTER(WHERE copy_initial_review_pending_eligible)::integer AS copy_initial_review_pending,
        count(*) FILTER(WHERE copy_rework_pending_eligible)::integer AS copy_rework_pending,
        count(*) FILTER(WHERE state IN ('MANUAL_ARCHIVE','IMAGE_REWORK_PENDING'))::integer AS image_review_pending,
        count(*) FILTER(WHERE state='COPY_QC_PENDING')::integer AS copy_qa_pending,
        count(*) FILTER(WHERE state='IMAGE_QC_PENDING')::integer AS image_qa_pending,
        count(*) FILTER(WHERE state='CANCELLED')::integer AS discarded,
        count(*) FILTER(WHERE delivery_eligible)::integer AS packing_delivery,
        -- The current QA release includes human passes, batch releases and legacy
        -- delivery-ready tasks whose acceptance predates the current QA records.
        count(*) FILTER(WHERE state='REVIEWED' OR
          (current_copy_revision_id IS NOT NULL
            AND copy_qc_released_revision_id=current_copy_revision_id))::integer AS copy_qa_passed,
        -- Completed unsampled releases pass QA too; any earlier task return
        -- still prevents a reworked or reassigned version from passing once.
        count(*) FILTER(WHERE current_copy_revision_id IS NOT NULL AND EXISTS(
          SELECT 1 FROM copy_qa_batch_members_v2 m JOIN copy_qa_batches_v2 b ON b.id=m.batch_id
          WHERE m.task_id=filtered.id AND m.copy_revision_id=filtered.current_copy_revision_id
            AND (m.status='PASSED' OR NOT m.selected AND m.status='RELEASED'
              AND b.status='COMPLETED' AND b.completed_at IS NOT NULL)
          UNION ALL SELECT 1 FROM copy_sampling_items i JOIN copy_sampling_freezes f ON f.id=i.freeze_id
          WHERE i.task_id=filtered.id AND i.copy_revision_id=filtered.current_copy_revision_id
            AND (i.status='PASSED' OR NOT i.selected AND i.status='RELEASED'
              AND f.status IN ('RELEASED','RELEASED_WITH_EXCEPTIONS'))
        ) AND NOT EXISTS(SELECT 1 FROM copy_qa_return_events_v2 e WHERE e.task_id=filtered.id)
          AND NOT EXISTS(SELECT 1 FROM copy_sampling_items i WHERE i.task_id=filtered.id AND i.status='RETURNED')
          AND NOT EXISTS(SELECT 1 FROM copy_sampling_items i JOIN copy_sampling_events e
            ON e.freeze_id=i.freeze_id AND (e.sampling_item_id IS NULL OR e.sampling_item_id=i.id)
            WHERE i.task_id=filtered.id AND e.action IN ('RETURN_SINGLE','RETURN_BATCH')))::integer AS copy_qa_first_passed,
        count(*) FILTER(WHERE state='REVIEWED' OR image_qc_legacy_accepted OR
          (image_qc_released_approval_event_id IS NOT NULL AND EXISTS(
            SELECT 1 FROM image_approval_events approval
            WHERE approval.id=filtered.image_qc_released_approval_event_id
              AND approval.image_run_id=filtered.current_image_run_id)))::integer AS image_qa_passed,
        count(*) FILTER(WHERE current_copy_revision_id IS NOT NULL
          AND copy_qc_released_revision_id=current_copy_revision_id)::integer AS copy_qa_released,
        count(*) FILTER(WHERE image_qc_released_approval_event_id IS NOT NULL
          AND EXISTS(SELECT 1 FROM image_approval_events approval
            WHERE approval.id=filtered.image_qc_released_approval_event_id
              AND approval.image_run_id=filtered.current_image_run_id))::integer AS image_qa_released,
        (SELECT coalesce(jsonb_object_agg(state,n),'{}'::jsonb) FROM
          (SELECT state,count(*)::integer AS n FROM filtered GROUP BY state) grouped) AS by_state,
        (SELECT count(DISTINCT f.id)::integer FROM filtered f JOIN delivery_batch_items i ON i.task_id=f.id
          AND i.copy_revision_id=f.current_copy_revision_id AND i.image_run_id=f.current_image_run_id
          JOIN delivery_item_confirmations c ON c.item_id=i.id WHERE f.delivery_eligible) AS delivered,
        (SELECT count(*)::integer FROM filtered f JOIN tasks t ON t.id=f.id
          WHERE ${REJECTION_SQL}>0) AS with_rejection,
        (SELECT count(*)::integer FROM filtered f JOIN tasks t ON t.id=f.id
          WHERE ${REASSIGNMENT_SQL}>0) AS with_reassignment,
        (SELECT count(*)::integer FROM filtered f WHERE EXISTS(SELECT 1 FROM task_assignment_records a
          WHERE a.task_id=f.id AND a.baseline)) AS legacy_assignment_count,
        (SELECT count(*)::integer FROM filtered f WHERE NOT EXISTS(SELECT 1 FROM task_assignment_events e
          WHERE e.task_id=f.id AND e.source='MANUAL' AND e.assignee_user_id IS NOT NULL)) AS missing_first_manual_assignment_count
      FROM filtered`, filter.params)).rows[0];
    return { poolOverview, overview, activityOverview, activityPeople, summaryRows, asOf };
    });
    const { poolOverview, overview, activityOverview, activityPeople, summaryRows } = aggregates;
    asOf = aggregates.asOf;
    if (exportAll && Number(summaryRows.total) > 10_000) {
      throw new RangeError('导出任务超过 10,000 条，请缩小时间区间或增加筛选条件');
    }
    const sortSql = query.sort === 'TASK_ID' ? 't.id' : TIME_SQL[query.sort];
    const limit = exportAll ? Math.max(1, Number(summaryRows.total)) : query.pageSize;
    const pageParams = [...filter.params, limit, exportAll ? 0 : (query.page - 1) * query.pageSize];
    const ids = (await client.query(`SELECT t.id FROM tasks t WHERE ${filter.sql}
      ORDER BY ${sortSql} ${query.order} NULLS LAST,t.id ${query.order}
      LIMIT $${pageParams.length - 1}::integer OFFSET $${pageParams.length}::integer`, pageParams))
      .rows.map(row => Number(row.id));
    const items = await readDetailRows(client, ids);
    await client.query('COMMIT');
    const total = Number(summaryRows.total);
    return {
      poolOverview, overview, activityOverview, activityPeople,
      summary: {
        total, byState: summaryRows.by_state ?? {},
        reviewPending: Number(summaryRows.copy_review_pending) + Number(summaryRows.image_review_pending),
        copyReviewPending: Number(summaryRows.copy_review_pending),
        copyInitialReviewPending: Number(summaryRows.copy_initial_review_pending),
        copyReworkPending: Number(summaryRows.copy_rework_pending),
        imageReviewPending: Number(summaryRows.image_review_pending),
        qaPending: Number(summaryRows.copy_qa_pending) + Number(summaryRows.image_qa_pending),
        copyQaPending: Number(summaryRows.copy_qa_pending),
        imageQaPending: Number(summaryRows.image_qa_pending),
        discarded: Number(summaryRows.discarded),
        packingDelivery: Number(summaryRows.packing_delivery),
        copyQaPassed: Number(summaryRows.copy_qa_passed),
        copyQaFirstPassed: Number(summaryRows.copy_qa_first_passed),
        imageQaPassed: Number(summaryRows.image_qa_passed),
        copyQaReleased: Number(summaryRows.copy_qa_released),
        imageQaReleased: Number(summaryRows.image_qa_released),
        delivered: Number(summaryRows.delivered),
        withRejection: Number(summaryRows.with_rejection),
        withReassignment: Number(summaryRows.with_reassignment),
      },
      items, total, page: query.page, pageSize: query.pageSize, asOf,
      range: { field: query.time.field, from: query.time.from, to: query.time.to,
        fromTime: query.time.fromTime, toTime: query.time.toTime, timeZone: 'Asia/Shanghai' },
      dataQuality: {
        legacyAssignmentCount: Number(summaryRows.legacy_assignment_count),
        missingFirstManualAssignmentCount: Number(summaryRows.missing_first_manual_assignment_count),
      },
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const TIMELINE_SQL = `SELECT event_at,kind,stage,actor,details FROM (
  SELECT t.created_at AS event_at,'TASK_CREATED'::text AS kind,NULL::text AS stage,
    NULL::text AS actor,'{}'::jsonb AS details,0 AS priority
  FROM tasks t WHERE t.id=$1
  UNION ALL
  SELECT e.created_at,'ASSIGNMENT', 'COPY',e.actor_username,
    jsonb_build_object('from',e.previous_assignee_user_id,'to',e.assignee_user_id,
      'source',e.source,'reason',e.reason),1
  FROM task_assignment_events e WHERE e.task_id=$1
  UNION ALL
  SELECT a.created_at,'COPY_REVIEW_DECISION','COPY',a.reviewer_username,
    jsonb_build_object('action',a.action,'score',a.score_x10,'reasonCodes',a.reason_codes),2
  FROM human_quality_assessments a WHERE a.task_id=$1 AND a.stage='COPY'
    AND a.action IN ('RETRY','DISCARD')
  UNION ALL
  SELECT a.approved_at,'COPY_REVIEW_PASSED','COPY',a.approved_by_username,
    jsonb_build_object('revisionId',a.copy_revision_id,'mode',a.approval_mode),3
  FROM copy_approval_events a WHERE a.task_id=$1
  UNION ALL
  SELECT m.decided_at,'COPY_QA_HUMAN_PASSED','COPY',u.username,
    jsonb_build_object('revisionId',m.copy_revision_id,'memberId',m.id),4
  FROM copy_qa_batch_members_v2 m LEFT JOIN app_users u ON u.id=m.reviewed_by_account_id
  WHERE m.task_id=$1 AND m.status='PASSED' AND m.decided_at IS NOT NULL
  UNION ALL
  SELECT e.created_at,'COPY_QA_RETURNED','COPY',u.username,
    jsonb_build_object('kind',e.kind,'qualityCycle',e.quality_cycle,'memberId',e.member_id),5
  FROM copy_qa_return_events_v2 e
  LEFT JOIN copy_qa_batch_members_v2 m ON m.id=e.member_id
  LEFT JOIN app_users u ON u.id=m.reviewed_by_account_id
  WHERE e.task_id=$1
  UNION ALL
  SELECT b.completed_at,'COPY_QA_BATCH_RELEASED','COPY',NULL::text,
    jsonb_build_object('revisionId',m.copy_revision_id,'memberId',m.id),6
  FROM copy_qa_batch_members_v2 m JOIN copy_qa_batches_v2 b ON b.id=m.batch_id
  WHERE m.task_id=$1 AND m.status='RELEASED' AND b.completed_at IS NOT NULL
  UNION ALL
  SELECT i.reviewed_at,'COPY_QA_HUMAN_PASSED','COPY',i.reviewed_by_username,
    jsonb_build_object('revisionId',i.copy_revision_id,'legacyItemId',i.id),4
  FROM copy_sampling_items i WHERE i.task_id=$1 AND i.status='PASSED' AND i.reviewed_at IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM copy_qa_batch_members_v2 m
      WHERE m.task_id=i.task_id AND m.copy_revision_id=i.copy_revision_id)
  UNION ALL
  SELECT COALESCE(f.resolved_at,i.updated_at),'COPY_QA_BATCH_RELEASED','COPY',NULL::text,
    jsonb_build_object('revisionId',i.copy_revision_id,'legacyItemId',i.id),6
  FROM copy_sampling_items i JOIN copy_sampling_freezes f ON f.id=i.freeze_id
  WHERE i.task_id=$1 AND i.status='RELEASED'
    AND NOT EXISTS(SELECT 1 FROM copy_qa_batch_members_v2 m
      WHERE m.task_id=i.task_id AND m.copy_revision_id=i.copy_revision_id)
  UNION ALL
  SELECT a.created_at,'IMAGE_REVIEW_DECISION','IMAGE',a.reviewer_username,
    jsonb_build_object('action',a.action,'score',a.score_x10,'reasonCodes',a.reason_codes),7
  FROM human_quality_assessments a WHERE a.task_id=$1 AND a.stage='IMAGE'
    AND a.action IN ('RETRY','DISCARD')
  UNION ALL
  SELECT a.submitted_at,'IMAGE_REVIEW_PASSED','IMAGE',a.submitted_by_username,
    jsonb_build_object('imageRunId',a.image_run_id,'mode',a.submission_mode),8
  FROM image_approval_events a WHERE a.task_id=$1
  UNION ALL
  SELECT e.created_at,CASE WHEN e.action='PASS' THEN 'IMAGE_QA_HUMAN_PASSED'
    ELSE 'IMAGE_QA_RETURNED' END,'IMAGE',e.actor_username,
    jsonb_build_object('action',e.action,'itemId',i.id,'imageRunId',i.image_run_id),9
  FROM image_sampling_events e JOIN image_sampling_items i ON i.freeze_id=e.freeze_id
    AND (e.sampling_item_id IS NULL OR e.sampling_item_id=i.id)
  WHERE i.task_id=$1 AND e.action IN ('PASS','RETURN_SINGLE','RETURN_BATCH')
  UNION ALL
  SELECT f.resolved_at,'IMAGE_QA_BATCH_RELEASED','IMAGE',NULL::text,
    jsonb_build_object('itemId',i.id,'imageRunId',i.image_run_id),10
  FROM image_sampling_items i JOIN image_sampling_freezes f ON f.id=i.freeze_id
  WHERE i.task_id=$1 AND i.status='RELEASED' AND f.resolved_at IS NOT NULL
  UNION ALL
  SELECT c.created_at,'REASSIGNMENT_CASE_OPENED',c.stage,NULL::text,
    jsonb_build_object('caseId',c.id,'status',c.status),11
  FROM task_reassignment_cases c WHERE c.task_id=$1
  UNION ALL
  SELECT c.disposed_at,'REASSIGNMENT_CASE_CLOSED',c.stage,u.username,
    jsonb_build_object('caseId',c.id,'status',c.status,'targetAccountId',c.target_account_id),12
  FROM task_reassignment_cases c LEFT JOIN app_users u ON u.id=c.disposed_by_account_id
  WHERE c.task_id=$1 AND c.disposed_at IS NOT NULL
  UNION ALL
  SELECT c.confirmed_at,'DELIVERY_CONFIRMED',NULL::text,c.actor_username,
    jsonb_build_object('itemId',i.id,'source',c.source),13
  FROM delivery_batch_items i JOIN delivery_item_confirmations c ON c.item_id=i.id
  WHERE i.task_id=$1
) events WHERE event_at IS NOT NULL ORDER BY event_at,priority LIMIT 501`;

export async function readTaskDataReportTask(pool, actor, rawTaskId) {
  assertAdmin(actor);
  const taskId = positiveInteger(rawTaskId, '任务编号');
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='20s'");
    const asOf = iso((await client.query('SELECT clock_timestamp() AS at')).rows[0].at);
    const [item] = await readDetailRows(client, [taskId]);
    if (!item) {
      await client.query('COMMIT');
      return null;
    }
    const rows = (await client.query(TIMELINE_SQL, [taskId])).rows;
    await client.query('COMMIT');
    return { item, events: rows.slice(0, 500).map(row => ({
      at: iso(row.event_at), kind: row.kind, stage: row.stage,
      actor: row.actor, details: row.details,
    })), eventsTruncated: rows.length > 500, asOf };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const CSV_COLUMNS = [
  ['taskId', '任务编号'], ['taskName', '任务名'], ['state', '当前状态'],
  ['createdAt', '创建时间'], ['firstManualCopyAssignmentAt', '首次管理员文案分配时间'],
  ['firstCopyAssignmentAt', '首次文案分配时间'],
  ['firstCopyReviewAt', '首次文案审核时间'], ['reportAt', '报表归属时间'],
  ['annotationPeople', '历任标注人'], ['currentAnnotator', '当前标注人'],
  ['copyQaPeople', '文案质检人'], ['imageQaPeople', '图片质检人'],
  ['lastCopyReviewer', '最后文案审核人'], ['lastImageReviewer', '最后图片审核人'],
  ['copyStatus', '文案状态'], ['imageStatus', '图片状态'],
  ['copyQaStatus', '文案质检状态'], ['imageQaStatus', '图片质检状态'],
  ['copyRejectionCount', '文案驳回次数'], ['imageRejectionCount', '图片驳回次数'],
  ['rejectionCount', '总驳回次数'], ['reassignmentCount', '改派次数'],
  ['copyReviewPassedAt', '文案审核通过时间'], ['copyQaHumanPassedAt', '文案人工质检通过时间'],
  ['copyQaReleasedAt', '文案质检放行时间'], ['copyQaReleaseMode', '文案质检放行方式'],
  ['imageReviewPassedAt', '图片审核通过时间'], ['imageQaHumanPassedAt', '图片人工质检通过时间'],
  ['imageQaReleasedAt', '图片质检放行时间'], ['imageQaReleaseMode', '图片质检放行方式'],
  ['deliveredAt', '交付确认时间'],
];
const CSV_DATE_COLUMNS = new Set([
  'createdAt', 'firstManualCopyAssignmentAt', 'firstCopyAssignmentAt', 'firstCopyReviewAt',
  'reportAt', 'copyReviewPassedAt', 'copyQaHumanPassedAt', 'copyQaReleasedAt',
  'imageReviewPassedAt', 'imageQaHumanPassedAt', 'imageQaReleasedAt', 'deliveredAt',
]);
const BEIJING_CSV_TIME = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const CSV_RELEASE_MODE_LABELS = Object.freeze({
  BATCH_RELEASE: '免检放行', HUMAN_PASS: '抽检通过',
  ADMIN_DIRECT: '管理员直放', ACCOUNT_AUTO_PASS: '用户默认通过质检',
  NO_QA_REQUIRED_OR_LEGACY: '未启用或历史放行',
});

function csvValue(value) {
  if (Array.isArray(value)) value = value.map(item => item?.displayName ?? item?.username ?? '').join('、');
  else if (value && typeof value === 'object') value = value.displayName ?? value.username ?? '';
  const text = String(value ?? '');
  // Spreadsheet software can interpret values beginning with these characters as formulas.
  const safe = /^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

function taskReportCsvHeader() {
  return CSV_COLUMNS.map(([key,label])=>csvValue(CSV_DATE_COLUMNS.has(key)
    ? `${label}（北京时间）` : label)).join(',');
}

function taskReportCsvLine(item) {
  return CSV_COLUMNS.map(([key])=>{
    const value=CSV_DATE_COLUMNS.has(key) && item[key]
      ? BEIJING_CSV_TIME.format(new Date(item[key]))
      : key.endsWith('ReleaseMode') ? CSV_RELEASE_MODE_LABELS[item[key]] ?? item[key] : item[key];
    return csvValue(value);
  }).join(',');
}

// The async export worker supplies its own small pool. A server-side cursor
// keeps memory proportional to one batch, regardless of the report's total.
export async function* streamTaskDataReportCsv(pool,actor,input={},{signal}={}) {
  signal?.throwIfAborted();
  assertAdmin(actor);
  const query=normalizeTaskDataReportQuery({...input,page:1,pageSize:200});
  const filter=buildTaskDataReportFilter(query);
  const sortSql=query.sort==='TASK_ID' ? 't.id' : TIME_SQL[query.sort];
  const client=await pool.connect();
  let transaction=false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transaction=true;
    await client.query("SET LOCAL statement_timeout='60s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='60s'");
    await client.query('SELECT clock_timestamp() AS at');
    await client.query(`DECLARE task_report_export NO SCROLL CURSOR FOR
      SELECT t.id FROM tasks t WHERE ${filter.sql}
      ORDER BY ${sortSql} ${query.order} NULLS LAST,t.id ${query.order}`,filter.params);
    yield {csv:`\uFEFF${taskReportCsvHeader()}\r\n`,rows:0};
    while(true) {
      signal?.throwIfAborted();
      const ids=(await client.query('FETCH FORWARD 250 FROM task_report_export')).rows.map(row=>Number(row.id));
      signal?.throwIfAborted();
      if(!ids.length)break;
      const items=await readDetailRows(client,ids);
      signal?.throwIfAborted();
      yield {csv:`${items.map(taskReportCsvLine).join('\r\n')}\r\n`,rows:items.length};
    }
    await client.query('CLOSE task_report_export');
    await client.query('COMMIT');
    transaction=false;
  } finally {
    // for-await cancellation also reaches this path; no idle transaction or
    // database connection survives an aborted download/job.
    if(transaction)await client.query('ROLLBACK').catch(()=>{});
    client.release();
  }
}

export async function exportTaskDataReportCsv(pool, actor, input = {}) {
  assertAdmin(actor);
  return runLimitedReportExport(pool, async () => {
  const query = normalizeTaskDataReportQuery({ ...input, page:1, pageSize:200 });
  const filter = buildTaskDataReportFilter(query);
  const sortSql = query.sort === 'TASK_ID' ? 't.id' : TIME_SQL[query.sort];
  const lines = [taskReportCsvHeader()];
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='60s'");
    const total = Number((await client.query(`WITH filtered AS MATERIALIZED (
      SELECT t.id FROM tasks t WHERE ${filter.sql} LIMIT 10001
    ) SELECT count(*)::integer AS total FROM filtered`,filter.params)).rows[0].total);
    if (total > 10_000) throw new RangeError('导出任务超过 10,000 条，请缩小时间区间或增加筛选条件');
    // All chunks belong to one source snapshot; pages cannot drift while a
    // worker advances or reassigns a task. Only one chunk of details is retained.
    for (let offset = 0; offset < total; offset += 250) {
      const values = [...filter.params,250,offset];
      const ids = (await client.query(`SELECT t.id FROM tasks t WHERE ${filter.sql}
        ORDER BY ${sortSql} ${query.order} NULLS LAST,t.id ${query.order}
        LIMIT $${values.length-1}::integer OFFSET $${values.length}::integer`,values)).rows.map(row=>Number(row.id));
      for (const item of await readDetailRows(client,ids)) lines.push(taskReportCsvLine(item));
    }
    await client.query('COMMIT');
    return `\uFEFF${lines.join('\r\n')}\r\n`;
  } catch(error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
  finally { client.release(); }
  });
}
