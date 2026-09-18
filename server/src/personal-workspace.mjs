import { normalizePersonalFilters, selectPersonalTasks, summarizePersonalWorkspace } from '../../src/personal-workspace.mjs';
import { normalizeRange } from '../../src/web-statistics/summary.mjs';
import { ControlPlaneAuthenticationError } from './domain.mjs';

const MAX_FACTS = 50_000;
const iso = value => value instanceof Date ? value.toISOString() : value ?? null;

// All report/list classification is performed against the same small, read-only
// facts. Generated copy, prompts, credentials and execution snapshots never leave this query.
export function personalFactsSql(blindSql) {
  return `SELECT task.id, task.query, task.state, task.current_stage,
      task.created_at, task.personal_stage_entered_at AS queue_entered_at, task.priority_sort_at, task.priority_mode,
      task.source_query_package_name, task.mandatory_copy_qc, task.mandatory_image_qc,
      task.mandatory_copy_qc_origin, revision.revision_origin,
      creator.id = $1 AS is_created, assignee.id = $1 AS is_assigned,
      (($3::varchar = 'ADMIN' OR creator.id = $1 OR assignee.id = $1)
        AND NOT ($3::varchar = 'REVIEWER' AND ${blindSql})) AS has_access,
      COALESCE(returns.target, revision.content->'finalRework'->>'target', 'COPY') AS rework_target,
      returns.source AS rework_source, returns.at AS returned_at, returns.note AS return_note,
      returns.rounds AS rework_rounds, plan.status AS plan_status, plan.finished_at AS plan_ready_at,
      edits.queued, edits.running, edits.ready, edits.failed, edits.preview_ready_at,
      EXISTS (SELECT 1 FROM delivery_entries d WHERE d.task_id=task.id AND d.status='READY'
        AND d.copy_revision_id=task.current_copy_revision_id AND d.image_run_id=task.current_image_run_id
        AND NOT EXISTS (SELECT 1 FROM delivery_batch_items packed JOIN delivery_item_confirmations confirmation ON confirmation.item_id=packed.id
          WHERE packed.task_id=task.id AND packed.copy_revision_id=task.current_copy_revision_id AND packed.image_run_id=task.current_image_run_id)) AS delivery_ready
    FROM tasks task
    LEFT JOIN app_users creator ON creator.username=task.created_by_user_id AND creator.created_at<task.created_at
    LEFT JOIN app_users assignee ON assignee.username=task.assigned_to_user_id AND assignee.created_at<task.assigned_at
    LEFT JOIN copy_revisions revision ON revision.id=task.current_copy_revision_id
    LEFT JOIN LATERAL (
      SELECT status,finished_at FROM copy_image_plan_regeneration_jobs p
      WHERE p.task_id=task.id AND p.copy_revision_id=task.current_copy_revision_id
        AND task.state='COPY_REVIEW_PENDING' ORDER BY p.created_at DESC,p.id DESC LIMIT 1
    ) plan ON true
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE e.status='QUEUED') AS queued,
        count(*) FILTER (WHERE e.status='RUNNING') AS running,
        count(*) FILTER (WHERE e.status='PREVIEW_READY') AS ready,
        count(*) FILTER (WHERE e.status='FAILED') AS failed,
        min(e.updated_at) FILTER (WHERE e.status='PREVIEW_READY') AS preview_ready_at
      FROM (SELECT DISTINCT ON (target_page) * FROM image_edit_requests e
        WHERE e.task_id=task.id AND e.copy_revision_id=task.current_copy_revision_id
          AND e.status<>'DRAFT' ORDER BY target_page,created_at DESC,id DESC) e
    ) edits ON true
    LEFT JOIN LATERAL (
      SELECT latest.*, count(*) OVER () AS rounds FROM (
        SELECT r.created_at AS at,'COPY_QA' AS source,'COPY' AS target,r.content->'qualityReturn'->>'note' AS note
          FROM copy_revisions r WHERE r.task_id=task.id AND r.revision_origin='QA_RETURN'
        UNION ALL
        SELECT i.reviewed_at,'IMAGE_QA',COALESCE(i.rework_target,'IMAGE'),i.note
          FROM image_sampling_items i WHERE i.task_id=task.id AND i.rework_target IS NOT NULL AND i.reviewed_at IS NOT NULL
        UNION ALL
        SELECT a.created_at,'FINAL_REWORK',a.rework_target,a.note FROM human_quality_assessments a
          WHERE a.task_id=task.id AND a.rework_target IS NOT NULL
      ) latest ORDER BY at DESC LIMIT 1
    ) returns ON true
    WHERE (($5::boolean AND (
        ($4::varchar='ASSIGNED' AND assignee.id=$1)
        OR ($4::varchar='CREATED' AND creator.id=$1)
        OR ($4::varchar='ALL' AND (creator.id=$1 OR assignee.id=$1))))
      OR task.id=ANY($2::bigint[]))
      AND NOT ($3::varchar='REVIEWER' AND ${blindSql})
    ORDER BY task.id LIMIT ${MAX_FACTS + 1}`;
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
    reworkCount: Number(row.rework_rounds ?? 0), planStatus: row.plan_status, planReadyAt: iso(row.plan_ready_at),
    imageEdits: { queued: Number(row.queued ?? 0), running: Number(row.running ?? 0), ready: Number(row.ready ?? 0), failed: Number(row.failed ?? 0) },
    previewReadyAt: iso(row.preview_ready_at), deliveryReady: row.delivery_ready === true };
}

// Event identity is the original submitter account, never the current owner.
// Reassignments therefore affect pending work but not historical contributions.
export const PERSONAL_EVENTS_SQL = `WITH returns AS (
    SELECT 'copy-return:'||r.id AS id,r.task_id,'COPY' AS stage,r.created_at AS at,
      approval.approved_by_account_id AS account_id,
      COALESCE(r.content->'qualityReturn'->'reasonCodes','[]'::jsonb) AS reasons
    FROM copy_revisions r LEFT JOIN copy_approval_events approval ON approval.copy_revision_id=r.parent_revision_id
    WHERE r.revision_origin='QA_RETURN'
    UNION ALL
    SELECT 'image-return:'||i.id,i.task_id,'IMAGE',i.reviewed_at,i.submitter_account_id,to_jsonb(i.reason_codes)
    FROM image_sampling_items i WHERE i.rework_target IS NOT NULL AND i.reviewed_at IS NOT NULL
    UNION ALL
    SELECT 'final-return:'||a.id,a.task_id,'IMAGE',a.created_at,approval.submitted_by_account_id,to_jsonb(a.reason_codes)
    FROM human_quality_assessments a LEFT JOIN image_approval_events approval ON approval.image_run_id=a.image_run_id
    WHERE a.rework_target IS NOT NULL
  ), completions AS (
    SELECT 'copy:'||a.id AS id,a.task_id,'COPY' AS stage,a.approved_at AS at,a.approved_by_account_id AS account_id,
      (r.revision_origin IN ('QA_RETURN','FINAL_REWORK') OR COALESCE(r.copy_rework_satisfied,false)) AS rework
    FROM copy_approval_events a JOIN copy_revisions r ON r.id=a.copy_revision_id
    WHERE a.approval_mode='MANUAL'
    UNION ALL
    SELECT 'image:'||a.id,a.task_id,'IMAGE',a.submitted_at,a.submitted_by_account_id,a.submission_mode='MANDATORY_RECHECK'
    FROM image_approval_events a JOIN image_runs run ON run.id=a.image_run_id
    WHERE COALESCE(run.result->'simulation'->>'enabled','false')<>'true'
  ), quality AS (
    SELECT event_key AS id,task_id,stage,occurred_at AS at,account_id,
      data->>'outcome'='PASS' AS passed,COALESCE((data->>'first')::boolean,false) AS first
    FROM operator_performance_events WHERE kind='QUALITY' AND data->>'exclusion' IS NULL
  ), events AS (
    SELECT c.id,c.task_id,'COMPLETE' AS kind,c.stage,c.at,c.account_id,
      (c.rework AND EXISTS (SELECT 1 FROM returns r WHERE r.task_id=c.task_id AND r.at<c.at
        AND NOT EXISTS (SELECT 1 FROM completions prior WHERE prior.task_id=c.task_id AND prior.stage=c.stage
          AND prior.at>=r.at AND prior.at<c.at))) AS rework,
      (SELECT max(r.at) FROM returns r WHERE r.task_id=c.task_id AND r.at<c.at) AS returned_at,
      NULL::boolean AS passed,NULL::boolean AS first,'[]'::jsonb AS reasons,0::bigint AS round
    FROM completions c
    UNION ALL
    SELECT r.id,r.task_id,'RETURN',r.stage,r.at,r.account_id,false,NULL::timestamptz,NULL::boolean,NULL::boolean,r.reasons,
      row_number() OVER (PARTITION BY r.task_id ORDER BY r.at,r.id)
    FROM returns r
    UNION ALL
    SELECT q.id,q.task_id,'QUALITY',q.stage,q.at,q.account_id,false,NULL::timestamptz,q.passed,q.first,'[]'::jsonb,0::bigint
    FROM quality q
  ) SELECT id,task_id,kind,stage,at,rework,returned_at,passed,first,reasons,round FROM events
    WHERE account_id=$1 AND at >= $2::timestamptz AND at < $3::timestamptz
    ORDER BY at,id LIMIT ${MAX_FACTS + 1}`;

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

export async function readPersonalWorkspace(pool, actor, input, { report = false, blindSql, loadTasks } = {}) {
  if (!Number.isSafeInteger(actor.userId) || actor.userId <= 0) throw new ControlPlaneAuthenticationError();
  const now = Date.now();
  const filters = normalizePersonalFilters(input, now);
  if (filters.createdFrom || filters.createdTo) {
    const date = filters.createdFrom || filters.createdTo;
    normalizeRange({ period:'custom',from:filters.createdFrom||date,to:filters.createdTo||date });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    let events = [], historyAvailable = true, deliveryAvailable = true, batches = [];
    if (report || filters.mode !== 'CURRENT') {
      await client.query('SAVEPOINT personal_history');
      try {
        const result = await client.query(PERSONAL_EVENTS_SQL, [actor.userId,new Date(filters.range.startMs).toISOString(),new Date(filters.range.endMs).toISOString()]);
        if (result.rows.length > MAX_FACTS) throw new RangeError('个人历史记录超出统计上限，请缩小日期范围');
        events = result.rows.map(row => ({ id:row.id,taskId:Number(row.task_id),kind:row.kind,stage:row.stage,at:iso(row.at),
          rework:row.rework===true,returnedAt:iso(row.returned_at),passed:row.passed===true,first:row.first===true,reasons:row.reasons,round:Number(row.round) }));
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
      if (!historyAvailable) Object.assign(output,{period:null,trend:null,quality:null,reworkDuration:null,reasons:null,repeatReworkTasks:null});
      if (!deliveryAvailable) {
        output.pendingDeliveryBatches = null;
        if (output.period) Object.assign(output.period,{deliveredBatches:null,deliveredTasks:null,confirmedByMeTasks:null});
      }
      output.notices = [!historyAvailable && '历史完成与质量数据暂不可用，当前待办仍可查看。',!deliveryAvailable && '交付统计暂不可用。'].filter(Boolean);
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
