import { OPERATOR_EVENTS_SOURCE_SQL, OPERATOR_CURRENT_SOURCE_SQL, OPERATOR_PENDING_SOURCE_SQL } from './operator-performance-event-sources.mjs';
import { readAccountQualityFacts } from './account-quality-statistics.mjs';
import { readAnnotationDiscardFacts } from './annotation-discard-facts.mjs';
import { readAnnotationAssignmentReport } from './annotation-assignment-report.mjs';
import { randomUUID } from 'node:crypto';
import { readQaFacts } from './quality-review-statistics.mjs';
import { readInspectionRounds } from './quality-rounds.mjs';
import { needsReassignment } from '../../src/quality-rounds.mjs';
import { ControlPlaneAuthorizationError, ControlPlaneConflictError, ControlPlaneNotFoundError } from './domain.mjs';
import { buildPerformanceSnapshot,normalizePerformanceFilters,performanceCsv,performanceMetricRows,performancePeoplePage,summarizeOperator } from '../../src/operator-performance.mjs';
import { buildAnnotationJobReport } from '../../src/annotation-job-report.mjs';
import { readCachedReportAggregate, runLimitedReportExport, readReportFactVersion, OPERATOR_REPORT_SOURCES, TASK_REPORT_SOURCES, runReportSingleFlight,runHeavyReportQuery,acquireReportQuerySlot } from './report-query-cache.mjs';
import { readSqlOperatorSnapshot, readSqlOperatorDetails } from './operator-performance-sql.mjs';
import { readSqlAnnotationJobReport } from './annotation-job-report-query.mjs';

const LIMIT=50_000,REPORT_EVENT_LIMIT=200_000,TTL=5*60_000;
const caches=new WeakMap();
const oracleCaches=new WeakMap();
const iso=value=>value instanceof Date ? value.toISOString():value;
// Preserve the database clock's microseconds for fact cutoffs, while showing
// the established ISO millisecond timestamp in the public response.
async function readOperatorClock(client) {
  const row=(await client.query('SELECT at,at::text AS data_cutoff FROM (SELECT clock_timestamp() AS at) report_clock')).rows[0];
  return {asOf:iso(row.at),dataCutoff:row.data_cutoff??iso(row.at)};
}
const number=value=>value==null?null:Number(value);

export const PERFORMANCE_EVENTS_SQL=`${OPERATOR_EVENTS_SOURCE_SQL} LIMIT ${LIMIT+1}`;

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

const CURRENT_SQL=`${OPERATOR_CURRENT_SOURCE_SQL} LIMIT ${LIMIT+1}`;

const PENDING_SQL=`${OPERATOR_PENDING_SOURCE_SQL} LIMIT ${LIMIT+1}`;

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
function cacheFor(pool,now,stores=caches) {
  if(!stores.has(pool)) stores.set(pool,new Map());
  const cache=stores.get(pool);
  for(const [key,value] of cache) if(value.expires<=now) cache.delete(key);
  return cache;
}

export async function readOperatorPerformanceOracle(pool,actor,input={},options={}) {
  if(actor?.role!=='ADMIN' || !Number.isSafeInteger(actor.userId) || actor.userId<1) throw new ControlPlaneAuthorizationError('仅管理员可以查看人员表现');
  const now=options.now?.()??Date.now(),filters=normalizePerformanceFilters(input,now),cache=cacheFor(pool,now,oracleCaches);
  let snapshot;
  if(filters.snapshotToken) {
    snapshot=cache.get(filters.snapshotToken);
    if(!snapshot || snapshot.actor!==actorKey(actor)) throw new ControlPlaneConflictError('PERFORMANCE_SNAPSHOT_EXPIRED','报表快照已过期，请刷新统计后重试');
    if(!options.kind || ['report','annotationJobReport'].includes(options.kind)) {
      const original=snapshot.report.filters;
      for(const key of ['period','accountId','stage','batchId','query','activity']) if(input[key]!==undefined && filters[key]!==original[key]) {
        throw new ControlPlaneConflictError('PERFORMANCE_SNAPSHOT_FILTER_MISMATCH','筛选条件已变化，请刷新统计');
      }
      if((input.from && input.from!==snapshot.report.range.from)||(input.to && input.to!==snapshot.report.range.to)) {
        throw new ControlPlaneConflictError('PERFORMANCE_SNAPSHOT_FILTER_MISMATCH','日期已变化，请刷新统计');
      }
    }
  } else {
    if(options.kind && !['report','annotationJobReport'].includes(options.kind)) throw new TypeError('查看明细或导出需要报表快照');
    const client=await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout='15s'");
      const databaseSnapshot=await readOperatorClock(client);
      databaseSnapshot.snapshot_version=await readReportFactVersion(client,options.kind==='annotationJobReport'
        ? [...TASK_REPORT_SOURCES,'copy_return_dispositions','image_task_dispositions']:OPERATOR_REPORT_SOURCES);
      const asOf=databaseSnapshot.dataCutoff;
      const {page,pageSize,sort,order,metric,sampleSet,snapshotToken,...aggregateFilters}=filters;
      snapshot=await readCachedReportAggregate(pool,`operator-performance:${options.kind??'report'}`,actor,aggregateFilters,
        databaseSnapshot.snapshot_version,async()=>{
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
      if(options.kind==='annotationJobReport') events.push(...await readAnnotationDiscardFacts(client,{start,end,asOf,...filters}));
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
      const annotation=options.kind==='annotationJobReport' ? await readAnnotationAssignmentReport(client,report) : null;
      const token=randomUUID();
      return {report,current,timeline,annotationReport:annotation?.report??null,
        firstCopyVerdicts:annotation?.firstCopyVerdicts??null,actor:actorKey(actor),expires:now+TTL,token};
      });
      await client.query('COMMIT');
      // Keep memory bounded; an evicted snapshot returns an explicit refresh error.
      cache.delete(snapshot.token);
      while(cache.size>=8 || [...cache.values()].reduce((n,s)=>n+s.report.rows.length+s.report.people.length+s.timeline.length,0)
        +snapshot.report.rows.length+snapshot.report.people.length+snapshot.timeline.length>150_000) {
        if(!cache.size) break;
        cache.delete(cache.keys().next().value);
      }
      cache.set(snapshot.token,snapshot);
    } catch(error) { await client.query('ROLLBACK');throw error; }
    finally {client.release();}
  }
  const {report}=snapshot;
  if(options.kind==='annotationJobReport') {
    if(snapshot.annotationReport==null) {
      const client=await pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query("SET LOCAL statement_timeout='15s'");
        const annotation=await readAnnotationAssignmentReport(client,report);
        snapshot.annotationReport=annotation.report;
        snapshot.firstCopyVerdicts=annotation.firstCopyVerdicts;
        await client.query('COMMIT');
      } catch(error) { await client.query('ROLLBACK');throw error; }
      finally {client.release();}
    }
    return buildAnnotationJobReport(snapshot.annotationReport,snapshot.firstCopyVerdicts);
  }
  if(options.kind==='export') return runLimitedReportExport(pool,async()=>({csv:performanceCsv(report),asOf:report.asOf}));
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
  const {rows,people,dataCutoff,...rest}=report;
  return {...rest,people:performancePeoplePage(report,filters),snapshotToken:snapshot.token,expiresAt:new Date(snapshot.expires).toISOString()};
}

function rememberCompactSnapshot(cache,snapshot) {
  snapshot.bytes=Buffer.byteLength(JSON.stringify(snapshot.report),'utf8');
  cache.delete(snapshot.token);
  while(cache.size>=128 || [...cache.values()].reduce((total,value)=>total+(value.bytes??0),0)+snapshot.bytes>32*1024*1024) {
    if(!cache.size)break;
    cache.delete(cache.keys().next().value);
  }
  cache.set(snapshot.token,snapshot);
}

export async function readOperatorPerformance(pool,actor,input={},options={}) {
  if(options.oracle===true) {
    return readOperatorPerformanceOracle(pool,actor,input,options);
  }
  if(actor?.role!=='ADMIN' || !Number.isSafeInteger(actor.userId) || actor.userId<1)throw new ControlPlaneAuthorizationError('仅管理员可以查看人员表现');
  const now=options.now?.()??Date.now(),filters=normalizePerformanceFilters(input,now),cache=cacheFor(pool,now);
  if(options.kind==='annotationJobReport') {
    const {page,pageSize,sort,order,metric,sampleSet,snapshotToken,...aggregateFilters}=filters;
    return runReportSingleFlight(pool,'annotation-jobs',[aggregateFilters,options.forceRefresh===true],async()=>{
    const client=await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout='30s'");
      // Only the two admitted heavy report calculations receive this budget.
      // It disappears at COMMIT/ROLLBACK and does not change the server/pool.
      const {asOf,dataCutoff}=await readOperatorClock(client);
      const version=await readReportFactVersion(client,[...TASK_REPORT_SOURCES,'copy_return_dispositions','image_task_dispositions']);
      const result=await readCachedReportAggregate(pool,'annotation-jobs-sql',
        {role:'ADMIN',userId:0,username:'report-scope'},aggregateFilters,version,
        ()=>runHeavyReportQuery(pool,async()=>{
          await client.query("SET LOCAL work_mem='32MB'");
          return readSqlAnnotationJobReport(client,filters,asOf,undefined,dataCutoff);
        }),{forceRefresh:options.forceRefresh===true});
      await client.query('COMMIT');
      return result;
    } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;}
    finally {client.release();}
    });
  }
  let snapshot;
  if(filters.snapshotToken && options.forceRefresh!==true) {
    snapshot=cache.get(filters.snapshotToken);
    if(!snapshot || snapshot.actor!==actorKey(actor))throw new ControlPlaneConflictError('PERFORMANCE_SNAPSHOT_EXPIRED','报表快照已过期，请刷新统计后重试');
    if(!snapshot.sql)return readOperatorPerformanceOracle(pool,actor,input,options);
    if(!options.kind || options.kind==='report') {
      for(const key of ['period','accountId','stage','batchId','query','activity'])if(input[key]!==undefined && filters[key]!==snapshot.report.filters[key]) {
        throw new ControlPlaneConflictError('PERFORMANCE_SNAPSHOT_FILTER_MISMATCH','筛选条件已变化，请刷新统计');
      }
      if((input.from && input.from!==snapshot.report.range.from)||(input.to && input.to!==snapshot.report.range.to))throw new ControlPlaneConflictError('PERFORMANCE_SNAPSHOT_FILTER_MISMATCH','日期已变化，请刷新统计');
    }
  } else {
    if(options.kind && options.kind!=='report')throw new TypeError('查看明细或导出需要报表快照');
    const {page,pageSize,sort,order,metric,sampleSet,snapshotToken,...aggregateFilters}=filters;
    const result=await runReportSingleFlight(pool,'operator-performance',[aggregateFilters,options.forceRefresh===true],async()=>{
      const client=await pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query("SET LOCAL statement_timeout='30s'");
        const {asOf,dataCutoff}=await readOperatorClock(client);
        const version=await readReportFactVersion(client,OPERATOR_REPORT_SOURCES);
        const report=await readCachedReportAggregate(pool,'operator-performance-sql',
          {role:'ADMIN',userId:0,username:'report-scope'},aggregateFilters,version,
          // The personnel-wide query retains its canonical source: the
          // projection join did not improve its million-current-task plan.
          ()=>runHeavyReportQuery(pool,async()=>{
            await client.query("SET LOCAL work_mem='32MB'");
            return readSqlOperatorSnapshot(client,filters,asOf,dataCutoff,{useProjections:false,summaryOnly:true});
          }),
          {forceRefresh:options.forceRefresh===true});
        await client.query('COMMIT');
        return {report,version};
      } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;}
      finally {client.release();}
    });
    snapshot={sql:true,report:result.report,actor:actorKey(actor),expires:now+TTL,token:randomUUID(),snapshotVersion:result.version};
    rememberCompactSnapshot(cache,snapshot);
  }
  const {report}=snapshot;
  if(options.kind==='export')return runLimitedReportExport(pool,async()=>({csv:performanceCsv(report),asOf:report.asOf}));
  if(options.kind==='detail' || options.accountId!==undefined) {
    const accountId=options.accountId===undefined?null:Number(options.accountId);
    if(accountId!==null && (!Number.isSafeInteger(accountId)||accountId<1))throw new TypeError('人员账号无效');
    let person=accountId===null ? {...report.summary,accountId:0,username:'',displayName:'团队'} : report.people.find(row=>row.accountId===accountId);
    if(!person)throw new ControlPlaneNotFoundError('当前报表没有该人员记录');
    let releaseHeavy=accountId===null?acquireReportQuerySlot(pool):null,client;
    try {
      client=await pool.connect();
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout='30s'");
      const version=await readReportFactVersion(client,OPERATOR_REPORT_SOURCES);
      const refreshed=version!==snapshot.snapshotVersion;
      let detailReport=report;
      if(refreshed) {
        releaseHeavy??=acquireReportQuerySlot(pool);
        await client.query("SET LOCAL work_mem='32MB'");
        const {asOf,dataCutoff}=await readOperatorClock(client);
        const detailFilters={...report.filters,accountId:accountId??report.filters.accountId};
        const {page,pageSize,sort,order,metric,sampleSet,snapshotToken,...aggregateFilters}=detailFilters;
        detailReport=await readCachedReportAggregate(pool,'operator-performance-sql',
          {role:'ADMIN',userId:0,username:'report-scope'},aggregateFilters,version,
          ()=>readSqlOperatorSnapshot(client,detailFilters,asOf,dataCutoff,{useProjections:false,summaryOnly:true}));
        person=accountId===null?{...detailReport.summary,accountId:0,username:'',displayName:'团队'}
          :detailReport.people.find(row=>row.accountId===accountId);
        if(!person)throw new ControlPlaneNotFoundError('当前报表没有该人员记录');
      }
      if(accountId===null&&!refreshed)await client.query("SET LOCAL work_mem='32MB'");
      const detail=await readSqlOperatorDetails(client,detailReport,filters,accountId,options);
      await client.query('COMMIT');
      return structuredClone({person,range:report.range,asOf:detailReport.asOf,reportAsOf:report.asOf,refreshed,
        snapshotToken:snapshot.token,metricVersion:report.metricVersion,...detail});
    } catch(error) {if(client)await client.query('ROLLBACK').catch(()=>{});throw error;}
    finally {client?.release();releaseHeavy?.();}
  }
  const {rows,people,dataCutoff,...rest}=report;
  return structuredClone({...rest,people:performancePeoplePage(report,filters),snapshotToken:snapshot.token,expiresAt:new Date(snapshot.expires).toISOString()});
}
