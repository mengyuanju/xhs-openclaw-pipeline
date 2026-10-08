import { readAccountQualityFacts } from './account-quality-statistics.mjs';
import { summarizeAccountQuality } from '../../src/account-quality-statistics.mjs';
import { classifyPersonalTask, normalizePersonalFilters, selectPersonalTasks, summarizePersonalWorkspace } from '../../src/personal-workspace.mjs';
import { normalizeRange } from '../../src/web-statistics/summary.mjs';
import { ControlPlaneAuthenticationError } from './domain.mjs';
import { createHash } from 'node:crypto';
import { readQaFacts } from './quality-review-statistics.mjs';
import { readInspectionRounds } from './quality-rounds.mjs';
import { qaMetricRows, summarizeQa, uniqueTaskCount } from '../../src/quality-review-statistics.mjs';
import { deliveryLedgerQuery } from './delivery-ledger.mjs';
import { invalidatePersonalWorkspaceCounts, readPersonalCurrentPage } from './personal-workspace-query.mjs';
import { personalHistoryFactsSql, readPersonalHistoryPageEvents } from './personal-workspace-history-query.mjs';
import { readPersonalPassTotals, readPersonalPeriodSummary, readPersonalReceipts } from './personal-statistics-query.mjs';

const MAX_FACTS = 50_000;
const iso = value => value instanceof Date ? value.toISOString() : value ?? null;

// All report/list classification is performed against the same small, read-only
// facts. Generated copy, prompts, credentials and execution snapshots never leave this query.
export function personalFactsSql(blindSql, { unbounded = false, classificationOnly = false, idsOnly = false,
  historicalCandidateSql = '', repeated = false, additionalWhere = '', personalScope } = {}) {
  // Only the CURRENT classifier consumes this projection. Its ASSIGNED scope
  // needs the immutable assignee relationship; creator access is still resolved
  // by the original full facts when hydrating the selected page's task IDs.
  const assignedClassification = classificationOnly && personalScope === 'ASSIGNED' && !historicalCandidateSql;
  const creatorMatch = assignedClassification ? 'false' : 'creator.id=$1';
  const creatorJoin = assignedClassification ? ''
    : 'LEFT JOIN app_users creator ON creator.username=task.created_by_user_id AND creator.created_at<task.created_at';
  const currentRelation = assignedClassification
    ? "($4::varchar='ASSIGNED' AND assignee.id=$1)"
    : "(($4::varchar='ASSIGNED' AND assignee.id=$1) OR ($4::varchar='CREATED' AND creator.id=$1) OR ($4::varchar='ALL' AND (creator.id=$1 OR assignee.id=$1)))";
  const reworkGuard = `(task.state='COPY_REVIEW_PENDING' AND COALESCE(task.current_stage,'')<>'IMAGE_RETRY_EXHAUSTED'
    AND CASE WHEN task.mandatory_copy_qc_origin IN ('QA_RETURN','FINAL_REWORK') THEN task.mandatory_copy_qc_origin
      ELSE revision.revision_origin END IN ('QA_RETURN','FINAL_REWORK')
    OR task.state='IMAGE_REWORK_PENDING' OR task.state='MANUAL_ARCHIVE' AND task.mandatory_image_qc)`;
  const returnGuard = classificationOnly && !repeated ? `AND ${reworkGuard}` : '';
  const revisionGuard = "(task.state IN ('COPY_REVIEW_PENDING','IMAGE_REWORK_PENDING') OR task.state='MANUAL_ARCHIVE' AND task.mandatory_image_qc)";
  // Keep ordinary classification on the small revision origin index. Fetch the
  // JSON fallback only when a rework category actually needs its final target.
  const reworkTarget = classificationOnly
    ? `CASE WHEN ${reworkGuard} THEN COALESCE(returns.target,
      (SELECT target_revision.content->'finalRework'->>'target' FROM copy_revisions target_revision
        WHERE target_revision.id=task.current_copy_revision_id),'COPY') ELSE 'COPY' END`
    : "COALESCE(returns.target,revision.content->'finalRework'->>'target','COPY')";
  // An ownership scope with no current, non-draft edits cannot have an edit
  // counter. This uncorrelated check runs once, rather than starting an empty
  // aggregate for every one of a person's historical or pending tasks.
  const editCandidateExists = assignedClassification ? `EXISTS (
    SELECT 1 FROM image_edit_requests candidate
    JOIN tasks candidate_task ON candidate_task.id=candidate.task_id
      AND candidate_task.current_copy_revision_id=candidate.copy_revision_id
    JOIN app_users candidate_owner ON candidate_owner.username=candidate_task.assigned_to_user_id
      AND candidate_owner.created_at<candidate_task.assigned_at
    WHERE candidate_owner.id=$1 AND candidate_task.task_kind='CONTENT'
      AND candidate_task.state NOT IN ('REVIEWED','CANCELLED') AND candidate.status<>'DRAFT'
  )` : 'true';
  if (idsOnly) return `SELECT task.id,task.query,task.state,task.created_at,task.priority_sort_at,task.priority_mode,
      task.priority_paused
    FROM tasks task
    LEFT JOIN app_users creator ON creator.username=task.created_by_user_id AND creator.created_at<task.created_at
    LEFT JOIN app_users assignee ON assignee.username=task.assigned_to_user_id AND assignee.created_at<task.assigned_at
    WHERE (($4::varchar='ASSIGNED' AND assignee.id=$1)
      OR ($4::varchar='CREATED' AND creator.id=$1)
      OR ($4::varchar='ALL' AND (creator.id=$1 OR assignee.id=$1)))
      AND task.task_kind='CONTENT' AND NOT ($3::varchar='REVIEWER' AND ${blindSql})
      AND ($2::bigint[] IS NOT NULL AND $5::boolean)
      ${additionalWhere}`;
  return `SELECT task.id, task.query, task.state, task.current_stage,
      task.created_at, task.personal_stage_entered_at AS queue_entered_at, task.priority_sort_at, task.priority_mode,
      task.source_query_package_name, task.mandatory_copy_qc, task.mandatory_image_qc,
      task.mandatory_copy_qc_origin, revision.revision_origin,
      ${creatorMatch} AS is_created, assignee.id = $1 AS is_assigned,
      (($3::varchar = 'ADMIN' OR ${creatorMatch} OR assignee.id = $1)
        AND NOT ($3::varchar = 'REVIEWER' AND ${blindSql})) AS has_access,
      ${reworkTarget} AS rework_target,
      returns.source AS rework_source, returns.at AS returned_at, returns.note AS return_note,
      returns.reasons AS return_reasons,
      returns.rounds AS rework_rounds, plan.status AS plan_status, plan.finished_at AS plan_ready_at,
      edits.queued, edits.running, edits.ready, edits.failed, edits.preview_ready_at,
      ${classificationOnly ? "task.state='REVIEWED' AND" : ''} EXISTS (SELECT 1 FROM delivery_entries d WHERE d.task_id=task.id AND d.status='READY'
        AND d.copy_revision_id=task.current_copy_revision_id AND d.image_run_id=task.current_image_run_id
        AND NOT EXISTS (SELECT 1 FROM delivery_batch_items packed JOIN delivery_item_confirmations confirmation ON confirmation.item_id=packed.id
          WHERE packed.task_id=task.id AND packed.copy_revision_id=task.current_copy_revision_id AND packed.image_run_id=task.current_image_run_id)) AS delivery_ready
    FROM tasks task
    ${creatorJoin}
    LEFT JOIN app_users assignee ON assignee.username=task.assigned_to_user_id AND assignee.created_at<task.assigned_at
    LEFT JOIN copy_revisions revision ON revision.id=${classificationOnly
      ? `CASE WHEN ${revisionGuard} THEN task.current_copy_revision_id END`
      : 'task.current_copy_revision_id'}
    LEFT JOIN LATERAL (
      SELECT status,finished_at FROM copy_image_plan_regeneration_jobs p
      WHERE p.task_id=task.id AND p.copy_revision_id=task.current_copy_revision_id
        AND task.state='COPY_REVIEW_PENDING' ORDER BY p.created_at DESC,p.id DESC
        LIMIT ${classificationOnly ? "CASE WHEN task.state='COPY_REVIEW_PENDING' THEN 1 ELSE 0 END" : '1'}
    ) plan ON true
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE e.status='QUEUED') AS queued,
        count(*) FILTER (WHERE e.status='RUNNING') AS running,
        count(*) FILTER (WHERE e.status='PREVIEW_READY') AS ready,
        count(*) FILTER (WHERE e.status='FAILED') AS failed,
        min(e.updated_at) FILTER (WHERE e.status='PREVIEW_READY') AS preview_ready_at
      FROM (SELECT DISTINCT ON (target_page) * FROM image_edit_requests e
        WHERE e.task_id=task.id AND e.copy_revision_id=task.current_copy_revision_id
          ${classificationOnly ? "AND task.state NOT IN ('REVIEWED','CANCELLED')" : ''}
          AND e.status<>'DRAFT' ORDER BY target_page,created_at DESC,id DESC) e
      ${classificationOnly ? `LIMIT CASE WHEN task.state NOT IN ('REVIEWED','CANCELLED')
        AND task.current_copy_revision_id IS NOT NULL AND ${editCandidateExists} THEN 1 ELSE 0 END` : ''}
    ) edits ON true
    LEFT JOIN LATERAL (
      SELECT latest.*, count(*) OVER () AS rounds FROM (
        SELECT r.created_at AS at,'COPY_QA' AS source,'COPY' AS target,
          r.content->'qualityReturn'->>'note' AS note,
          r.content->'qualityReturn'->'reasonSnapshots' AS reasons
          FROM copy_revisions r WHERE r.task_id=task.id AND r.revision_origin='QA_RETURN'
            ${returnGuard}
        UNION ALL
        SELECT i.reviewed_at,'IMAGE_QA',COALESCE(i.rework_target,'IMAGE'),i.note,NULL::jsonb
          FROM image_sampling_items i WHERE i.task_id=task.id AND i.rework_target IS NOT NULL AND i.reviewed_at IS NOT NULL
            ${returnGuard}
        UNION ALL
        SELECT a.created_at,'FINAL_REWORK',a.rework_target,a.note,NULL::jsonb FROM human_quality_assessments a
          WHERE a.task_id=task.id AND a.rework_target IS NOT NULL
            ${returnGuard}
      ) latest ORDER BY at DESC
        LIMIT ${classificationOnly && !repeated ? `CASE WHEN ${reworkGuard} THEN 1 ELSE 0 END` : '1'}
    ) returns ON true
    WHERE ${historicalCandidateSql ? `task.id IN (${historicalCandidateSql}) AND $2::bigint[] IS NOT NULL
      AND $4::varchar IS NOT NULL AND $5::boolean IS NOT NULL` : `(($5::boolean AND ${currentRelation})
      OR task.id=ANY($2::bigint[]))`}
      AND task.task_kind='CONTENT'
      AND NOT ($3::varchar='REVIEWER' AND ${blindSql})
      ${additionalWhere}
    ${unbounded ? '' : `ORDER BY task.id LIMIT ${MAX_FACTS + 1}`}`;
}

function factFrom(row) {
  return { id: Number(row.id), query: row.query, state: row.state, currentStage: row.current_stage,
    createdAt: iso(row.created_at), queueEnteredAt: iso(row.queue_entered_at), prioritySortAt: iso(row.priority_sort_at),
    priorityMode: row.priority_mode, sourceQueryPackageName: row.source_query_package_name,
    isAssigned: row.is_assigned === true, isCreated: row.is_created === true, canOpen: row.has_access === true,
    mandatoryCopyQc: row.mandatory_copy_qc === true, mandatoryImageQc: row.mandatory_image_qc === true,
    copyReworkOrigin: ['QA_RETURN','FINAL_REWORK'].includes(row.mandatory_copy_qc_origin)
      ? row.mandatory_copy_qc_origin : row.revision_origin,
    reworkTarget: row.rework_target, reworkSource: row.rework_source, returnedAt: iso(row.returned_at), returnNote: row.return_note,
    returnReasons: Array.isArray(row.return_reasons)
      ? row.return_reasons.map((reason) => String(reason?.label ?? '')).filter(Boolean)
      : [],
    reworkCount: Number(row.rework_rounds ?? 0), planStatus: row.plan_status, planReadyAt: iso(row.plan_ready_at),
    imageEdits: { queued: Number(row.queued ?? 0), running: Number(row.running ?? 0), ready: Number(row.ready ?? 0), failed: Number(row.failed ?? 0) },
    previewReadyAt: iso(row.preview_ready_at), deliveryReady: row.delivery_ready === true };
}
export { factFrom as personalFactFromRow };

// Event identity is the original submitter account, never the current owner.
// Reassignments therefore affect pending work but not historical contributions.
export const PERSONAL_EVENTS_SQL = `WITH personal_events AS (
    SELECT e.event_key AS id,e.task_id,e.stage,e.occurred_at AS at,e.data,
      CASE WHEN e.kind='SUBMIT' THEN 'COMPLETE' ELSE e.kind END AS kind,
      (SELECT max(r.occurred_at) FROM operator_performance_events r WHERE r.task_id=e.task_id
        AND r.occurred_at<e.occurred_at AND (r.kind IN ('RETURN','BATCH_RETURN') OR r.kind='QUALITY' AND r.data->>'outcome'='RETURN')
        AND COALESCE(r.data->>'target',r.stage) IN (e.stage,'BOTH')) AS returned_at
    FROM operator_performance_events e WHERE e.account_id=$1 AND e.occurred_at >= $2 AND e.occurred_at < $3
      AND e.kind IN ('SUBMIT','QUALITY','RETURN') AND e.data->>'exclusion' IS NULL
  ), events AS (
    SELECT * FROM personal_events
    UNION ALL
    SELECT id||':return',task_id,stage,at,data,'RETURN',returned_at FROM personal_events
      WHERE kind='QUALITY' AND data->>'outcome'='RETURN'
  ) SELECT id,task_id,kind,stage,at,data,COALESCE((data->>'rework')::boolean,false) AS rework,returned_at,
    data->>'outcome'='PASS' AS passed,COALESCE((data->>'first')::boolean,false) AS first,
    COALESCE(data->'reasons','[]'::jsonb) AS reasons,NULL::bigint AS round
  FROM events ORDER BY at,id LIMIT ${MAX_FACTS + 1}`;

// One row is one valid manual submission. The account on the event is the
// original submitter, so a later reassignment never moves their contribution.
export const PERSONAL_SUBMISSIONS_SQL = `SELECT e.event_key AS id,e.task_id,e.stage,e.occurred_at AS at,
    NOT EXISTS (SELECT 1 FROM operator_performance_events previous
      WHERE previous.task_id=e.task_id AND previous.stage=e.stage
        AND previous.kind='SUBMIT' AND previous.data->>'exclusion' IS NULL
        AND (previous.occurred_at,previous.sequence_id)<(e.occurred_at,e.sequence_id)) AS first_submission,
    e.data->>'rework'='true' AS rework
  FROM operator_performance_events e
  WHERE e.account_id=$1 AND e.occurred_at >= $2 AND e.occurred_at < $3
    AND e.kind='SUBMIT' AND e.data->>'exclusion' IS NULL
  ORDER BY e.occurred_at,e.event_key LIMIT ${MAX_FACTS + 1}`;

// Copy QA v2 and some older receipts do not store sampleKind. Infer a repeat
// review from an earlier valid verdict; the event with the same key is this decision.
export const PERSONAL_QA_EVENTS_SQL = `SELECT e.*,
    CASE WHEN e.data->>'sampleKind' IS NOT NULL THEN e.data->>'sampleKind'
      WHEN e.kind='QA_REVIEW' THEN
        CASE WHEN EXISTS (SELECT 1 FROM account_quality_events previous
          WHERE previous.task_id=e.task_id AND previous.stage=e.stage
            AND previous.event_key<>e.event_key AND previous.action IN ('PASS','RETURN')
            AND previous.data->>'exclusion' IS NULL AND previous.occurred_at<e.occurred_at)
        THEN 'MANDATORY_RECHECK' ELSE 'RANDOM' END
      ELSE NULL END AS effective_sample_kind
  FROM quality_review_activity_events e
  WHERE e.account_id=$1 AND e.occurred_at >= $2 AND e.occurred_at < $3
  ORDER BY e.occurred_at,e.event_key LIMIT ${MAX_FACTS + 1}`;

const BATCH_SQL = `SELECT b.id AS batch_id,
    CASE WHEN confirmation.item_id IS NOT NULL THEN 'DELIVERED' ELSE 'DOWNLOADED' END AS status,
    confirmation.confirmed_at AS delivered_at,confirmation.actor_account_id=$1 AS confirmed_by_me,
    ARRAY[i.task_id] AS task_ids FROM delivery_batches b
    JOIN delivery_batch_items i ON i.delivery_batch_id=b.id
    LEFT JOIN delivery_item_confirmations confirmation ON confirmation.item_id=i.id
    LEFT JOIN delivery_item_owners owner ON owner.item_id=i.id
    LEFT JOIN tasks task ON task.id=i.task_id
    LEFT JOIN app_users assignee ON assignee.username=task.assigned_to_user_id AND assignee.created_at<task.assigned_at
    WHERE (owner.account_id=$1 OR assignee.id=$1 OR b.created_by_account_id=$1 OR confirmation.actor_account_id=$1)
      AND $2::varchar<>'' AND $3::varchar IN ('ADMIN','USER','REVIEWER')
    ORDER BY b.created_at DESC,i.id DESC LIMIT ${MAX_FACTS + 1}`;

async function readPersonalOverview(client, actor, now) {
  const range = normalizeRange({ period: 'today' }, now);
  // This is a personal aggregate for every role, including admins and reviewers.
  // Reuse the CURRENT delivery pool's permissions, version and quality gate;
  // a privileged role must never turn this card into a global delivery count.
  const deliveryQuery = deliveryLedgerQuery({ view: 'CURRENT', state: 'PENDING' }, { ...actor, role: 'USER' });
  const ready = Number((await client.query(
    `SELECT count(DISTINCT task_id)::integer AS ready FROM (${deliveryQuery.sql}) personal_delivery`,
    deliveryQuery.values,
  )).rows[0].ready);
  const passed = await readPersonalPassTotals(client, actor, range);
  return { section: 'overview', updatedAt: new Date(now).toISOString(), timezone: 'Asia/Shanghai',
    range: { from: range.from, to: range.to }, delivery: { ready,
      href: ['ADMIN', 'USER'].includes(actor.role)
        ? `/delivery-pool?dl_view=CURRENT&dl_state=PENDING&dl_assigneeId=${actor.userId}` : null },
    passed,
  };
}

export async function readPersonalWorkspace(pool, actor, input, { report = false, blindSql, loadTasks } = {}) {
  if (!Number.isSafeInteger(actor.userId) || actor.userId <= 0) throw new ControlPlaneAuthenticationError();
  const now = Date.now();
  const section=report ? input?.section??'' : '';
  if(section && !['overview','personal','jobs'].includes(section))throw new TypeError('个人数据板块无效');
  const filters = normalizePersonalFilters(section === 'overview' ? {} : input, now);
  if (filters.createdFrom || filters.createdTo) {
    const date = filters.createdFrom || filters.createdTo;
    normalizeRange({ period:'custom',from:filters.createdFrom||date,to:filters.createdTo||date });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='15s'");
    // Modern cards aggregate fresh facts independently; polling one card must
    // not invalidate every other person's page counts. The legacy combined
    // report retains its historical forced-refresh behavior.
    if (report && !section) invalidatePersonalWorkspaceCounts(pool);
    if (!report) {
      const historical = filters.mode !== 'CURRENT';
      const page = await readPersonalCurrentPage(client, pool, {
        actor, filters, historical,
        factsSql: options => historical
          ? personalHistoryFactsSql(baseOptions => personalFactsSql(blindSql, baseOptions), filters, options)
          : personalFactsSql(blindSql, options),
      }, { now });
      const rows = page.ids.length ? (await client.query(personalFactsSql(blindSql),
        [actor.userId, page.ids, actor.role, filters.personalScope, false])).rows : [];
      const byId = new Map(rows.map(row => [Number(row.id), factFrom(row)]));
      const facts = page.ids.map(id => byId.get(id) ?? (historical ? {
        id, query: `历史内容 #${id}`, state: 'HISTORY_ONLY', createdAt: null, isAssigned: false, isCreated: false, canOpen: false,
      } : null)).filter(Boolean);
      const history = historical ? await readPersonalHistoryPageEvents(client, actor, filters, page.ids, now) : [];
      const histories = new Map();
      for (const event of history) {
        if (!histories.has(event.taskId)) histories.set(event.taskId, []);
        histories.get(event.taskId).push(event);
      }
      const ids = facts.filter(fact => fact.canOpen).map(fact => fact.id);
      const items = ids.length ? await loadTasks(client, ids) : [];
      const hydrated = new Map(items.map(task => [task.id, task]));
      const { ids: _ids, workSummary: _workSummary, ...output } = page;
      output.items = facts.map(fact => ({ ...(hydrated.get(fact.id) ?? {
        id: fact.id, query: fact.query, state: fact.state, createdAt: fact.createdAt,
        assignedToUserId: null, assignedToAccountId: null, createdByUserId: null, createdByAccountId: null,
        currentCopyRevisionId: null, currentImageRunId: null, progressMessage: '历史完成记录；当前无权查看作业详情', progressPercent: 0,
      }), canOpen: fact.canOpen, personalWork: fact.canOpen ? classifyPersonalTask(fact, now) : null,
      personalHistory: histories.get(fact.id) ?? [] }));
      output.updatedAt = new Date(now).toISOString();
      await client.query('COMMIT');
      return output;
    }
    if (section === 'overview') {
      const output = await readPersonalOverview(client, actor, now);
      await client.query('COMMIT'); return output;
    }
    if(section==='personal') {
      const output=await readPersonalPeriodSummary(client,actor,filters.range,now);
      await client.query('COMMIT');return output;
    }
    if(section==='jobs') {
      const { counts, workSummary } = await readPersonalCurrentPage(client, pool, {
        actor, filters: normalizePersonalFilters({ personalScope: filters.personalScope }, now),
        factsSql: options => personalFactsSql(blindSql, { ...options, classificationOnly: false }),
      }, { now, countsOnly: true, ttlMs: 0 });
      await client.query('COMMIT');
      return {section:'jobs',updatedAt:new Date(now).toISOString(),scope:filters.personalScope,counts,...workSummary};
    }
    let events = [], historyAvailable = true, deliveryAvailable = true, batches = [];
    if (report || filters.mode !== 'CURRENT') {
      await client.query('SAVEPOINT personal_history');
      try {
        const result = await client.query(PERSONAL_EVENTS_SQL, [actor.userId,new Date(filters.range.startMs).toISOString(),new Date(filters.range.endMs).toISOString()]);
        if (result.rows.length > MAX_FACTS) throw new RangeError('个人历史记录超出统计上限，请缩小日期范围');
        events = result.rows.map(row => ({accountId:actor.userId,id:row.id,taskId:Number(row.task_id),kind:row.kind,stage:row.stage,at:iso(row.at),
          samplingItemId:row.data?.samplingItemId,sampleKind:row.data?.sampleKind,approvalId:row.data?.approvalId,
          firstSubmission:row.data?.firstSubmission,firstRecheck:row.data?.firstRecheck,outcome:row.data?.outcome,
          rework:row.rework===true,returnedAt:iso(row.returned_at),passed:row.passed===true,first:row.first===true,reasons:row.reasons,round:null }));
        events=(await readInspectionRounds(client,events,new Date(now).toISOString())).map(event=>({...event,round:event.returnRound??null}));
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT personal_history');
        if (!report) throw error;
        historyAvailable = false;
      }
      await client.query('RELEASE SAVEPOINT personal_history');
    }
    const rows = (await client.query(personalFactsSql(blindSql), [actor.userId,
      report ? [] : [...new Set(events.map(event=>event.taskId))],actor.role,filters.personalScope,report || filters.mode==='CURRENT'])).rows;
    if (rows.length > MAX_FACTS) throw new RangeError('个人作业超出统计上限，暂时无法完整汇总');
    const facts = rows.map(factFrom);
    let output;
    if (report) {
      await client.query('SAVEPOINT personal_delivery');
      try {
        const result = await client.query(BATCH_SQL,[actor.userId,actor.username,actor.role]);
        if (result.rows.length > MAX_FACTS) throw new RangeError('交付记录超出统计上限');
        batches = result.rows.map(row=>({batchId:Number(row.batch_id),status:row.status,deliveredAt:iso(row.delivered_at),taskIds:row.task_ids.map(Number),confirmedByMe:row.confirmed_by_me===true}));
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT personal_delivery'); deliveryAvailable = false;
      }
      await client.query('RELEASE SAVEPOINT personal_delivery');
      output = summarizePersonalWorkspace(facts,events,batches,filters,now);
      const judged=await readAccountQualityFacts(client,{start:new Date(filters.range.startMs).toISOString(),end:new Date(filters.range.endMs).toISOString(),accountId:actor.userId});
      output.qualityOutcomes=Object.fromEntries(['COPY','IMAGE'].map(stage=>[stage,summarizeAccountQuality(judged.filter(row=>row.stage===stage))]));
      await client.query('SAVEPOINT personal_qa');
      try {
        const qaEvents = await readQaFacts(client,{range:filters.range,accountId:actor.userId,asOf:new Date(now).toISOString()});
        output.qa = summarizeQa(qaEvents);
        output.contribution = historyAvailable ? uniqueTaskCount([...events.filter(event=>event.kind==='COMPLETE'),...qaMetricRows(qaEvents)]) : null;
        output.qaTrend = [];
        for (let at=filters.range.startMs;at<filters.range.endMs;at+=86400000) {
          const daily=qaEvents.filter(event=>Date.parse(event.at)>=at && Date.parse(event.at)<at+86400000);
          output.qaTrend.push({date:new Date(at+8*3600000).toISOString().slice(0,10),...summarizeQa(daily)});
        }
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT personal_qa');
        output.qa=null;output.contribution=null;output.qaTrend=null;
      }
      await client.query('RELEASE SAVEPOINT personal_qa');
      if (!historyAvailable) Object.assign(output,{period:null,annotation:null,trend:null,quality:null,reworkDuration:null,reasons:null,repeatReworkTasks:null});
      if (!deliveryAvailable) {
        output.pendingDeliveryBatches = null;
        if (output.period) Object.assign(output.period,{deliveredBatches:null,deliveredTasks:null,confirmedByMeTasks:null});
      }
      output.notices = [!historyAvailable && '历史完成与质量数据暂不可用，当前待办仍可查看。',!deliveryAvailable && '交付统计暂不可用。',!output.qa && '质检贡献暂不可用，请确认中心已升级后重试。'].filter(Boolean);
    } else {
      output = selectPersonalTasks(facts,events,filters,now);
      const ids = output.items.filter(task=>task.canOpen).map(task=>task.id);
      const items = ids.length ? await loadTasks(client,ids) : [];
      const byId = new Map(items.map(task=>[task.id,task]));
      output.items = output.items.map(fact=>({ ...(byId.get(fact.id) ?? {
        id:fact.id,query:fact.query,state:fact.state,createdAt:fact.createdAt,assignedToUserId:null,assignedToAccountId:null,
        createdByUserId:null,createdByAccountId:null,currentCopyRevisionId:null,currentImageRunId:null,
        progressMessage:'历史完成记录；当前无权查看作业详情',progressPercent:0,
      }), canOpen:fact.canOpen, personalWork:fact.canOpen ? fact.personalWork : null, personalHistory:fact.history }));
      output.updatedAt = new Date(now).toISOString();
    }
    await client.query('COMMIT');
    return output;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

// Personal history exposes only the actor's own receipt, never the producer's
// identity, task query, version or task id. Existing blind-review rules still apply.
export async function readPersonalQualityActivity(pool,actor,input={}) {
  if (!Number.isSafeInteger(actor.userId) || actor.userId<=0) throw new ControlPlaneAuthenticationError();
  const allowed=new Set(['period','from','to','metric','stage','sampleSet','page','pageSize']);
  if(Object.keys(input).some(key=>!allowed.has(key)) || Object.values(input).some(Array.isArray)) throw new TypeError('质检历史筛选无效');
  const metric=input.metric || 'qa';
  const receiptMetrics=new Set(['submitAll','submitFirst','submitRework','copyFirstReview','annotationDiscarded','annotationOverall','qaFirst','qaPassed','qaReturned','qaRecheck',
    'qaActual','qaCoverage','qaBatchReturned','qaBatchReleased','qaDiscarded','qaEscalated']);
  if(!['contributed','qaAll','qa','qaRecheck','qaBatch','qaSpecial','qaPending','qaBlocked',...receiptMetrics].includes(metric)
    || input.stage && !['COPY','IMAGE'].includes(input.stage)
    || ['copyFirstReview','annotationDiscarded'].includes(metric) && input.stage && input.stage!=='COPY'
    || input.sampleSet && !['all','first','passed','failed'].includes(input.sampleSet)
    || input.sampleSet==='first' && metric!=='annotationOverall') throw new TypeError('质检指标无效');
  const filters=normalizePersonalFilters(input),client=await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='15s'");
    if(receiptMetrics.has(metric)) {
      const {rows,...page}=await readPersonalReceipts(client,actor,filters,metric,input.sampleSet);
      const result={...page,items:rows.map(row=>{
          const token=createHash('sha256').update(String(row.id)).digest('hex').slice(0,12).toUpperCase();
          return {id:`receipt:${token}`,code:`ACT-${token}`,stage:row.stage,kind:row.kind,at:iso(row.at),
            outcome:row.outcome??null,sampleKind:row.sample_kind??null,
            submissionType:row.submission_type??null,firstPassed:row.first_passed===true,
            ...(row.coverage_sources ? {coverageSources:row.coverage_sources,manualKinds:row.manual_kinds??[]} : {})};
        })};
      await client.query('COMMIT');return result;
    }
    const facts=await readInspectionRounds(client,await readQaFacts(client,{range:filters.range,accountId:actor.userId,stage:filters.stage}),new Date().toISOString());
    let rows=qaMetricRows(facts,metric==='contributed'?'qa':metric,filters.stage,input.sampleSet==='passed'?'PASS':input.sampleSet==='failed'?'RETURN':'');
    if(metric==='contributed') {
      const completed=(await client.query(PERSONAL_EVENTS_SQL,[actor.userId,new Date(filters.range.startMs).toISOString(),new Date(filters.range.endMs).toISOString()])).rows;
      if(completed.length>MAX_FACTS) throw new RangeError('历史记录超出上限，请缩小日期');
      rows.push(...completed.filter(row=>row.kind==='COMPLETE' && (!filters.stage || row.stage===filters.stage)).map(row=>({id:row.id,kind:row.kind,stage:row.stage,at:iso(row.at),taskId:Number(row.task_id)})));
    }
    rows.sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||a.id.localeCompare(b.id));
    const page=Math.min(filters.page,Math.max(1,Math.ceil(rows.length/filters.pageSize)));
    const result={total:rows.length,tasks:uniqueTaskCount(rows),page,pageSize:filters.pageSize,
      items:rows.slice((page-1)*filters.pageSize,page*filters.pageSize).map(row=>({
        id:row.id,code:`QA-${createHash('sha256').update(String(row.samplingItemPublicId??row.id)).digest('hex').slice(0,12).toUpperCase()}`,
        stage:row.stage,kind:row.kind,at:row.at,outcome:row.outcome,sampleKind:row.sampleKind,blocked:row.blocked,passBlocked:row.passBlocked,
        reviewRound:row.reviewRound,returnRound:row.returnRound,roundKnown:row.roundKnown,
        affectedCount:row.affectedCount,exclusion:row.exclusion,
      }))};
    await client.query('COMMIT');return result;
  } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
}
