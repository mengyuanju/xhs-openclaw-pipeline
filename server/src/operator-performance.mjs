import { readAccountQualityFacts } from './account-quality-statistics.mjs';
import { randomUUID } from 'node:crypto';
import { readQaFacts } from './quality-review-statistics.mjs';
import { readInspectionRounds } from './quality-rounds.mjs';
import { needsReassignment } from '../../src/quality-rounds.mjs';
import { ControlPlaneAuthorizationError, ControlPlaneConflictError, ControlPlaneNotFoundError } from './domain.mjs';
import { buildPerformanceSnapshot,normalizePerformanceFilters,performanceCsv,performanceMetricRows,performancePeoplePage,summarizeOperator } from '../../src/operator-performance.mjs';

const LIMIT=50_000,REPORT_EVENT_LIMIT=200_000,TTL=5*60_000;
const caches=new WeakMap();
const iso=value=>value instanceof Date ? value.toISOString():value;
const number=value=>value==null?null:Number(value);

export const PERFORMANCE_EVENTS_SQL=`SELECT e.*,EXISTS(SELECT 1 FROM tasks t WHERE t.id=e.task_id) AS task_exists,
    (SELECT bool_or(s.data->>'selected'='true') FROM operator_performance_events s WHERE s.task_id=e.task_id AND s.stage=e.stage
      AND s.kind='SAMPLE' AND s.data->>'sampleKind'='RANDOM' AND s.data->>'approvalId'=e.data->>'approvalId') AS sample_selected,
    previous.occurred_at AS previous_submitted_at,
    (SELECT max(r.occurred_at) FROM operator_performance_events r WHERE r.task_id=e.task_id
      AND r.occurred_at<e.occurred_at AND (previous.occurred_at IS NULL OR r.occurred_at>=previous.occurred_at)
      AND (r.kind IN ('RETURN','BATCH_RETURN') OR r.kind='QUALITY' AND r.data->>'outcome'='RETURN')
      AND COALESCE(r.data->>'target',r.stage) IN (e.stage,'BOTH')) AS returned_at,
    NULL::bigint AS return_round
  FROM operator_performance_events e
  LEFT JOIN LATERAL(SELECT occurred_at FROM operator_performance_events p WHERE p.task_id=e.task_id AND p.stage=e.stage
    AND p.kind='SUBMIT' AND p.data->>'exclusion' IS NULL AND (p.occurred_at,p.sequence_id)<(e.occurred_at,e.sequence_id)
    ORDER BY p.occurred_at DESC,p.sequence_id DESC LIMIT 1) previous ON e.kind='SUBMIT'
  WHERE e.occurred_at >= $1 AND e.occurred_at < $2 AND e.occurred_at <= $3
    AND ($4::bigint IS NULL OR e.account_id=$4) AND ($5::text='' OR e.stage=$5)
    AND ($6::bigint IS NULL OR (e.data->>'batchId')::bigint=$6)
  ORDER BY e.occurred_at,e.event_key LIMIT ${LIMIT+1}`;

// Account-scoped reports still credit a valid recheck performed by a different
// account to the original random sample. Each lookup is anchored to one failed
// first sample, so the supporting history stays bounded by the report rows.
const CROSS_ACCOUNT_RECHECK_SQL=`SELECT s.task_id,s.stage,recheck.account_id,recheck.occurred_at
  FROM jsonb_to_recordset($1::jsonb) AS s(task_id bigint,stage text,sampled_at timestamptz)
  JOIN LATERAL (
    SELECT e.account_id,e.occurred_at FROM operator_performance_events e
    WHERE e.task_id=s.task_id AND e.stage=s.stage AND e.occurred_at>=s.sampled_at
      AND e.occurred_at<$2 AND e.occurred_at<=$3 AND e.account_id<>$4::bigint
      AND e.kind='QUALITY' AND e.data->>'sampleKind'='MANDATORY_RECHECK'
      AND e.data->>'outcome'='PASS' AND e.data->>'exclusion' IS NULL
      AND ($5::bigint IS NULL OR (e.data->>'batchId')::bigint=$5)
    ORDER BY e.occurred_at,e.sequence_id LIMIT 1
  ) recheck ON true
  LIMIT ${LIMIT+1}`;

const CURRENT_SQL=`SELECT latest.*,t.query,t.production_batch_id AS batch_id,t.assigned_at,
    (SELECT q.data||jsonb_build_object('id',q.event_key,'taskId',q.task_id,'accountId',q.account_id,
      'stage',q.stage,'kind',q.kind,'at',q.occurred_at)
      FROM operator_performance_events q WHERE q.task_id=t.id AND q.stage=latest.stage AND q.kind='QUALITY'
      ORDER BY q.occurred_at DESC,q.sequence_id DESC LIMIT 1) AS last_quality,
    CASE WHEN latest.baseline THEN greatest(t.personal_stage_entered_at,
      (SELECT max(p.finished_at) FROM copy_image_plan_regeneration_jobs p WHERE p.task_id=t.id AND p.copy_revision_id=t.current_copy_revision_id AND p.status='SUCCEEDED' AND t.state='COPY_REVIEW_PENDING'),
      (SELECT max(e.updated_at) FROM image_edit_requests e WHERE e.task_id=t.id AND e.copy_revision_id=t.current_copy_revision_id AND e.status='PREVIEW_READY' AND t.state IN ('MANUAL_ARCHIVE','IMAGE_REWORK_PENDING')))
      ELSE latest.occurred_at END AS waiting_at,
    COALESCE(u.display_name,latest.username,'历史身份未确认') AS display_name
  FROM (SELECT DISTINCT ON(task_id) * FROM operator_stage_events ORDER BY task_id,occurred_at DESC,id DESC) latest
  JOIN tasks t ON t.id=latest.task_id LEFT JOIN app_users u ON u.id=latest.account_id
  WHERE latest.phase<>'CLOSED' AND ($1::bigint IS NULL OR latest.account_id=$1)
    AND ($2::text='' OR latest.stage=$2) AND ($3::bigint IS NULL OR t.production_batch_id=$3)
  ORDER BY latest.task_id LIMIT ${LIMIT+1}`;

const PENDING_SQL=`SELECT q.*,t.query,COALESCE(u.display_name,q.username,'历史身份未确认') AS display_name
  FROM operator_quality_samples q JOIN tasks t ON t.id=q.task_id LEFT JOIN app_users u ON u.id=q.account_id
  WHERE q.outcome IS NULL AND ((q.selected AND q.status='PENDING') OR (q.exclusion IS NOT NULL AND q.created_at >= $1 AND q.created_at < $2))
    AND ($3::bigint IS NULL OR q.account_id=$3) AND ($4::text='' OR q.stage=$4)
    AND ($5::bigint IS NULL OR q.batch_id=$5)
  ORDER BY q.created_at,q.id LIMIT ${LIMIT+1}`;

function assertComplete(rows) {
  if(rows.length>LIMIT) throw new RangeError('统计范围超过 50,000 条事实，请缩小日期或选择人员；未返回不完整排名');
  return rows;
}
function assertReportComplete(rows) {
  if(rows.length>REPORT_EVENT_LIMIT) throw new RangeError('合并统计事实超过 200,000 条，请缩小日期或选择人员；未返回不完整排名');
  return rows;
}
function eventFrom(row) {
  return {...row.data,id:row.event_key,taskId:Number(row.task_id),accountId:number(row.account_id),stage:row.stage,kind:row.kind,
    at:iso(row.occurred_at),canOpen:row.task_exists,sampleSelected:row.sample_selected,previousSubmittedAt:iso(row.previous_submitted_at),returnedAt:iso(row.returned_at),returnRound:Number(row.return_round??0)};
}
function actorKey(actor) { return `${actor.userId}:${actor.username}:${actor.credentialVersion??actor.version??1}`; }
function cacheFor(pool,now) {
  if(!caches.has(pool)) caches.set(pool,new Map());
  const cache=caches.get(pool);
  for(const [key,value] of cache) if(value.expires<=now) cache.delete(key);
  return cache;
}

export async function readOperatorPerformance(pool,actor,input={},options={}) {
  if(actor?.role!=='ADMIN' || !Number.isSafeInteger(actor.userId) || actor.userId<1) throw new ControlPlaneAuthorizationError('仅管理员可以查看人员表现');
  const now=options.now?.()??Date.now(),filters=normalizePerformanceFilters(input,now),cache=cacheFor(pool,now);
  let snapshot;
  if(filters.snapshotToken) {
    snapshot=cache.get(filters.snapshotToken);
    if(!snapshot || snapshot.actor!==actorKey(actor)) throw new ControlPlaneConflictError('PERFORMANCE_SNAPSHOT_EXPIRED','报表快照已过期，请刷新统计后重试');
    if(!options.kind || options.kind==='report') {
      const original=snapshot.report.filters;
      for(const key of ['period','accountId','stage','batchId','query','activity']) if(input[key]!==undefined && filters[key]!==original[key]) {
        throw new ControlPlaneConflictError('PERFORMANCE_SNAPSHOT_FILTER_MISMATCH','筛选条件已变化，请刷新统计');
      }
      if((input.from && input.from!==snapshot.report.range.from)||(input.to && input.to!==snapshot.report.range.to)) {
        throw new ControlPlaneConflictError('PERFORMANCE_SNAPSHOT_FILTER_MISMATCH','日期已变化，请刷新统计');
      }
    }
  } else {
    if(options.kind && options.kind!=='report') throw new TypeError('查看明细或导出需要报表快照');
    const client=await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout='15s'");
      const asOf=iso((await client.query('SELECT clock_timestamp() AS at')).rows[0].at);
      // The account roster belongs to the same database snapshot as its facts.
      // Activity and date filters apply to metrics, not to who appears in ALL.
      const rosterRows=filters.activity==='ALL' ? (await client.query(`
        SELECT id,username,display_name FROM app_users
        WHERE ($1::bigint IS NULL OR id=$1)
        ORDER BY id LIMIT ${LIMIT+1}`, [filters.accountId])).rows : [];
      if(rosterRows.length>LIMIT) throw new RangeError('账号超过 50,000 个，请指定人员；未返回不完整排名');
      const roster=rosterRows.map(row=>({accountId:Number(row.id),username:row.username,displayName:row.display_name}));
      const start=new Date(filters.range.startMs).toISOString(),end=new Date(filters.range.endMs).toISOString();
      let events=filters.activity==='QA'?[]:assertComplete((await client.query(PERFORMANCE_EVENTS_SQL,[start,end,asOf,filters.accountId,filters.stage,filters.batchId])).rows).map(eventFrom);
      if(filters.activity!=='QA') events.push(...await readAccountQualityFacts(client,{start,end,...filters}));
      if(filters.activity!=='PRODUCTION') events.push(...await readQaFacts(client,{...filters,asOf}));
      const pending=filters.activity==='QA'?[]:assertComplete((await client.query(PENDING_SQL,[start,end,filters.accountId,filters.stage,filters.batchId])).rows);
      for(const row of pending) events.push({id:`pending:${row.stage}:${row.id}`,taskId:Number(row.task_id),accountId:number(row.account_id),stage:row.stage,
        kind:row.selected&&row.status==='PENDING'?'PENDING':'EXCLUDED',at:iso(row.created_at),username:row.username,displayName:row.display_name,
        batchId:number(row.batch_id),query:row.query,exclusion:row.exclusion,copyRevisionId:number(row.copy_revision_id),imageRunId:row.image_run_id,
        sampleKind:row.sample_kind,first:row.first_random,policyVersion:number(row.policy_version)});
      assertReportComplete(events);
      const firstReturns=filters.accountId ? events.filter(row=>row.kind==='QUALITY' && row.first===true
        && row.sampleKind==='RANDOM' && row.outcome==='RETURN' && !row.exclusion && row.accountId!==null)
        .map(row=>({task_id:row.taskId,stage:row.stage,sampled_at:row.at})):[];
      const otherRechecks=firstReturns.length ? assertComplete((await client.query(CROSS_ACCOUNT_RECHECK_SQL,
        [JSON.stringify(firstReturns),end,asOf,filters.accountId,filters.batchId])).rows).map(row=>({
        taskId:Number(row.task_id),stage:row.stage,accountId:Number(row.account_id),kind:'QUALITY',
        sampleKind:'MANDATORY_RECHECK',outcome:'PASS',at:iso(row.occurred_at),exclusion:null,
        batchId:filters.batchId})):[];
      const current=(filters.activity==='QA'?[]:assertComplete((await client.query(CURRENT_SQL,[filters.accountId,filters.stage,filters.batchId])).rows)).map(row=>({
        taskId:Number(row.task_id),accountId:number(row.account_id),username:row.username,displayName:row.display_name,stage:row.stage,
        phase:row.phase,state:row.state,query:row.query,batchId:number(row.batch_id),at:iso(row.waiting_at),assignedAt:iso(row.assigned_at),
        lastQuality:row.last_quality,waitingMs:Math.max(0,Date.parse(asOf)-Date.parse(row.waiting_at))}));
      const eventCount=events.length;
      const roundRows=await readInspectionRounds(client,[...events,...current.filter(row=>row.lastQuality).map(row=>row.lastQuality)],asOf);
      events=roundRows.slice(0,eventCount);
      const decisions=new Map(roundRows.slice(eventCount).map(row=>[`${row.taskId}:${row.stage}`,row]));
      for(const task of current) {
        const decision=decisions.get(`${task.taskId}:${task.stage}`);
        task.lastQuality=decision??null;
        task.reassignSuggested=needsReassignment(task,decision);
        if(task.reassignSuggested) events.push({...decision,id:`reassign:${task.taskId}:${task.stage}`,kind:'REASSIGN',
          accountId:task.accountId,username:task.username,displayName:task.displayName,query:task.query,batchId:task.batchId,
          returnedAt:decision.at,waitingMs:task.waitingMs,canOpen:true});
      }
      const taskIds=[...new Set(events.filter(row=>row.kind==='SUBMIT').map(row=>row.taskId))];
      const timeline=taskIds.length ? assertComplete((await client.query(`SELECT * FROM operator_stage_events WHERE task_id=ANY($1::bigint[])
        AND occurred_at <= $2 ORDER BY task_id,occurred_at,id LIMIT ${LIMIT+1}`,[taskIds,asOf])).rows).map(row=>({
        id:Number(row.id),taskId:Number(row.task_id),accountId:number(row.account_id),stage:row.stage,phase:row.phase,state:row.state,
        at:iso(row.occurred_at),baseline:row.baseline})):[];
      const report=buildPerformanceSnapshot(events,current,timeline,filters,asOf,[...events,...otherRechecks],roster);
      await client.query('COMMIT');
      const token=randomUUID();
      snapshot={report,current,timeline,actor:actorKey(actor),expires:now+TTL,token};
      // Keep memory bounded; an evicted snapshot returns an explicit refresh error.
      while(cache.size>=8 || [...cache.values()].reduce((n,s)=>n+s.report.rows.length+s.report.people.length+s.timeline.length,0)
        +events.length+report.people.length+timeline.length>150_000) {
        if(!cache.size) break;
        cache.delete(cache.keys().next().value);
      }
      cache.set(token,snapshot);
    } catch(error) { await client.query('ROLLBACK');throw error; }
    finally {client.release();}
  }
  const {report}=snapshot;
  if(options.kind==='export') return {csv:performanceCsv(report),asOf:report.asOf};
  if(options.kind==='detail' || options.accountId!==undefined) {
    const accountId=options.accountId===undefined?null:Number(options.accountId);
    if(accountId!==null && (!Number.isSafeInteger(accountId)||accountId<1)) throw new TypeError('人员账号无效');
    const person=accountId===null ? {...report.summary,accountId:0,username:'',displayName:'团队'} : report.people.find(row=>row.accountId===accountId);
    if(!person) throw new ControlPlaneNotFoundError('当前报表没有该人员记录');
    const all=report.rows.filter(row=>accountId===null || row.accountId===accountId);
    const rows=performanceMetricRows(all,filters.metric,filters.stage,filters.sampleSet).toSorted((a,b)=>Date.parse(b.at)-Date.parse(a.at)||a.id.localeCompare(b.id));
    const page=Math.min(filters.page,Math.max(1,Math.ceil(rows.length/filters.pageSize)));
    const tasks=new Set(rows.slice((page-1)*filters.pageSize,page*filters.pageSize).map(row=>row.taskId));
    const trend=[];
    for(const day of report.trend) {
      const daily=all.filter(row=>Number.isFinite(Date.parse(row.at)) && String(new Date(Date.parse(row.at)+8*3_600_000).toISOString()).slice(0,10)===day.date);
      const summary=summarizeOperator(daily);
      trend.push({date:day.date,qa:summary.qa.reviews,submitted:summary.submitted,returned:summary.returned,COPY:summary.COPY.firstPass,IMAGE:summary.IMAGE.firstPass});
    }
    return {person,range:report.range,asOf:report.asOf,snapshotToken:snapshot.token,trend,
      items:rows.slice((page-1)*filters.pageSize,page*filters.pageSize),total:rows.length,page,pageSize:filters.pageSize,
      timeline:snapshot.timeline.filter(row=>tasks.has(row.taskId)),current:snapshot.current.filter(row=>report.filters.activity!=='QA' && (accountId===null || row.accountId===accountId)),
      metricVersion:report.metricVersion};
  }
  const {rows,people,...rest}=report;
  return {...rest,people:performancePeoplePage(report,filters),snapshotToken:snapshot.token,expiresAt:new Date(snapshot.expires).toISOString()};
}
