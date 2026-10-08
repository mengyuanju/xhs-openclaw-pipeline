import { DISCARDS_SQL } from './annotation-discard-facts.mjs';
import { ANNOTATION_ASSIGNMENTS_SQL, ANNOTATION_FIRST_COPY_SQL } from './annotation-assignment-report.mjs';
import { operatorReportParameters, readSqlOperatorSnapshot,operatorReportFactCtes } from './operator-performance-sql.mjs';

const withoutLimit=sql=>sql.replace(/\s+LIMIT\s+\d+\s*$/u,'');

export function annotationJobBaseSql({useProjections=true,materializeCurrent=useProjections}={}) {
  return `WITH RECURSIVE ${operatorReportFactCtes({annotationOnly:true,useProjections,materializeCurrent})},
    current_identity_keys AS (SELECT account_id,max(task_id) AS task_id FROM selected_current
      WHERE account_id IS NOT NULL GROUP BY account_id),
    identity_rows AS (
      SELECT account_id,data->>'username' AS username,data->>'displayName' AS display_name,1 AS source_order,occurred_at
        FROM selected_facts WHERE account_id IS NOT NULL
      UNION ALL SELECT c.account_id,c.username,c.display_name,2,c.waiting_at FROM selected_current c
        JOIN current_identity_keys i ON i.account_id=c.account_id AND i.task_id=c.task_id
    ), identities AS (SELECT DISTINCT ON(account_id) account_id,username,
      coalesce(display_name,username,'历史账号 #'||account_id) AS display_name FROM identity_rows
      ORDER BY account_id,source_order DESC,occurred_at DESC),
    annotation_outcomes AS (SELECT account_id,count(*) FILTER(WHERE data->>'outcome'='RETURN') AS failed,count(*) AS decided
      FROM selected_facts WHERE kind='ANNOTATION_QUALITY' AND account_id>0 AND coalesce(data->>'exclusion','')=''
        AND data->>'outcome' IN('PASS','RETURN') GROUP BY account_id)
    SELECT jsonb_build_object('people',coalesce((SELECT jsonb_agg(jsonb_build_object('accountId',i.account_id,
      'username',i.username,'displayName',i.display_name,'annotationOverallPass',jsonb_build_object(
        'failed',coalesce(a.failed,0),'decided',coalesce(a.decided,0))))
      FROM identities i LEFT JOIN annotation_outcomes a USING(account_id)),'[]'),
      'dataQuality',jsonb_build_object('unknownIdentity',(SELECT count(*) FROM selected_facts
        WHERE account_id IS NULL AND kind NOT IN('QA_PENDING','ANNOTATION_UNKNOWN_BATCH')),
        'unattributedAnnotationBatchReturns',(SELECT coalesce(sum(report_safe_integer(data->>'unknownCount')),0)
          FROM selected_facts WHERE kind='ANNOTATION_UNKNOWN_BATCH'),
        'unattributedAnnotationBatchScopes',(SELECT count(*) FROM selected_facts
          WHERE kind='ANNOTATION_UNKNOWN_BATCH' AND data->>'unknownScope'='true'))) AS base`;
}

async function readAnnotationJobBase(client,filters,asOf,dataCutoff,options) {
  if(filters.activity!=='PRODUCTION')return readSqlOperatorSnapshot(client,filters,asOf,dataCutoff,options);
  const raw=(await client.query(annotationJobBaseSql(options),operatorReportParameters(filters,dataCutoff))).rows[0].base;
  const trend=[];
  for(let at=filters.range.startMs;at<filters.range.endMs;at+=86400000)trend.push({date:new Date(at+8*3600000).toISOString().slice(0,10)});
  return {timezone:'Asia/Shanghai',asOf,dataCutoff,range:{from:filters.range.from,to:filters.range.to},trend,
    people:raw.people,dataQuality:raw.dataQuality};
}

export function annotationJobReportSql({useProjections=true}={}) {
  const discards=withoutLimit(DISCARDS_SQL).replace(/\$1\b/gu,"'0001-01-01T00:00:00Z'::timestamptz")
    .replace(/\$2\b/gu,"'infinity'::timestamptz").replace(/\$[46]\b/gu,'NULL').replace(/\$5\b/gu,"''")
    .replace(/\$7\b/gu,'NULL');
  const assignments=withoutLimit(ANNOTATION_ASSIGNMENTS_SQL)
    .replaceAll('task_id=ANY($1::bigint[])',`task_id IN(SELECT task_id FROM ${useProjections?'uncached_assignment_scope':'task_scope'})`)
    .replace(/\$2\b/gu,'$3');
  const verdicts=withoutLimit(ANNOTATION_FIRST_COPY_SQL)
    .slice(ANNOTATION_FIRST_COPY_SQL.indexOf('  SELECT cohort.cycle_key')).replace(/\$2\b/gu,'$3')
    .replace('SELECT cohort.cycle_key,cohort.task_id,cohort.account_id,','SELECT cohort.cycle_key,cohort.task_id,cohort.account_id,cohort.day,cohort.submitted_at,');
  const cycleCount=predicate=>`count(*) FILTER(WHERE ${predicate})`;
  return `WITH period_candidates AS MATERIALIZED (
    SELECT task_id FROM operator_performance_events WHERE kind='SUBMIT' AND account_id IS NOT NULL
      AND data->>'exclusion' IS NULL AND occurred_at>=$1::timestamptz AND occurred_at<$2::timestamptz
      AND occurred_at<=$3::timestamptz AND ($4::bigint IS NULL OR account_id=$4)
      AND ($5::text='' OR stage=$5) AND ($6::bigint IS NULL OR report_safe_integer(data->>'batchId')=$6)
    UNION SELECT task_id FROM (${withoutLimit(DISCARDS_SQL).replace(/\$7\b/gu,'NULL')}) d
  ), task_scope AS MATERIALIZED (SELECT DISTINCT task_id FROM period_candidates),
  full_work AS MATERIALIZED (
    SELECT e.event_key,e.task_id,e.account_id,e.stage,e.kind,e.occurred_at,e.sequence_id,e.data
    FROM operator_performance_events e JOIN task_scope s ON s.task_id=e.task_id
    WHERE e.kind='SUBMIT' AND e.account_id>0 AND e.data->>'exclusion' IS NULL AND e.occurred_at<=$3::timestamptz
    UNION ALL SELECT 'annotation-discard:'||d.event_key,d.task_id,d.account_id,d.stage,'ANNOTATION_DISCARD',d.occurred_at,0,
      jsonb_build_object('username',d.username,'displayName',d.display_name,'batchId',d.batch_id,'query',d.query)
      FROM (${discards}) d JOIN task_scope s ON s.task_id=d.task_id WHERE d.account_id>0
  ), ${useProjections?`cached_transitions AS MATERIALIZED (
      SELECT history.task_id,history.history FROM report_annotation_assignment_history history
      JOIN task_scope scope ON scope.task_id=history.task_id
      JOIN report_projection_tasks revision ON revision.task_id=history.task_id
        AND revision.revision=revision.projected_revision AND revision.revision=history.source_revision
      WHERE history.max_occurred_at<=$3::timestamptz
    ), uncached_assignment_scope AS MATERIALIZED (
      SELECT task_id FROM task_scope WHERE NOT EXISTS(SELECT 1 FROM cached_transitions cached WHERE cached.task_id=task_scope.task_id)
    ),`:''} assignment_rows AS (${assignments}),
  transitions AS MATERIALIZED (
    SELECT task_id,report_annotation_transitions(jsonb_agg(jsonb_build_object('id',id,'order',ordering,'kind',kind,
      'accountId',account_id,'username',username,'previousAccountId',previous_account_id,'previousUsername',previous_username,
      'atMs',(extract(epoch FROM date_trunc('milliseconds',occurred_at))*1000)::bigint,
      'endMs',(extract(epoch FROM date_trunc('milliseconds',ended_at))*1000)::bigint,'baseline',baseline)
      ORDER BY occurred_at,ordering)) AS history FROM assignment_rows GROUP BY task_id
      ${useProjections?'UNION ALL SELECT task_id,history FROM cached_transitions':''}
  ), cycle_work AS (
    SELECT w.*,w.task_id||':'||coalesce(epoch.id,'initial')||':'||w.account_id||':'||w.stage AS cycle_key
    FROM full_work w LEFT JOIN transitions t ON t.task_id=w.task_id
    LEFT JOIN LATERAL (SELECT value->>'id' AS id FROM jsonb_array_elements(t.history) WITH ORDINALITY
      WHERE (value->>'atMs')::bigint<=extract(epoch FROM date_trunc('milliseconds',w.occurred_at))*1000
      ORDER BY (value->>'atMs')::bigint DESC,ordinality DESC LIMIT 1) epoch ON true
  ), annotated_work AS MATERIALIZED (
    SELECT w.*,row_number() OVER(PARTITION BY cycle_key ORDER BY date_trunc('milliseconds',occurred_at),sequence_id,event_key)=1 AS first,
      first_value(kind) OVER submission_order AS first_submission_kind,
      first_value(occurred_at) OVER submission_order AS first_submitted_at,
      first_value(data->>'approvalId') OVER submission_order AS first_approval_id,
      first_value(data->>'copyRevisionId') OVER submission_order AS first_copy_revision_id
    FROM cycle_work w WINDOW submission_order AS (PARTITION BY cycle_key
      ORDER BY (kind='SUBMIT') DESC,date_trunc('milliseconds',occurred_at),sequence_id,event_key)
  ), keyword_accounts AS (
    SELECT DISTINCT w.account_id FROM annotated_work w LEFT JOIN app_users u ON u.id=w.account_id
    WHERE w.occurred_at>=$1::timestamptz AND w.occurred_at<$2::timestamptz AND $7<>''
      AND strpos(lower(coalesce(u.display_name,'')||' '||coalesce(u.username,'')||' '
        ||coalesce(w.data->>'displayName','')||' '||coalesce(w.data->>'username','')),$7)>0
  ), period_work AS MATERIALIZED (
    SELECT w.*,to_char(occurred_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day FROM annotated_work w
    LEFT JOIN app_users u ON u.id=w.account_id
    WHERE occurred_at>=$1::timestamptz AND occurred_at<$2::timestamptz
      AND ($4::bigint IS NULL OR account_id=$4) AND ($5::text='' OR stage=$5)
      AND ($6::bigint IS NULL OR report_safe_integer(data->>'batchId')=$6)
      AND ($7='' OR w.account_id=ANY($8::bigint[]) OR w.account_id IN(SELECT account_id FROM keyword_accounts))
  ), cohort AS MATERIALIZED (
    SELECT w.cycle_key,w.task_id,w.account_id,w.day,
      CASE WHEN first_submission_kind='SUBMIT' THEN first_submitted_at END AS submitted_at,
      CASE WHEN first_submission_kind='SUBMIT' THEN report_safe_integer(first_approval_id) END AS approval_id,
      CASE WHEN first_submission_kind='SUBMIT' THEN report_safe_integer(first_copy_revision_id) END AS copy_revision_id
    FROM period_work w
    WHERE w.stage='COPY' AND w.first
  ), verdicts AS (${verdicts}),
  cycle_summary AS (
    SELECT v.account_id,v.day,
      ${cycleCount("v.submitted_at IS NOT NULL AND v.outcome='PASS'")} AS passed,
      ${cycleCount("v.submitted_at IS NOT NULL AND v.outcome='RETURN'")} AS returned,
      ${cycleCount("v.submitted_at IS NOT NULL AND v.outcome='DISCARD'")} AS qa_discarded,
      ${cycleCount("v.submitted_at IS NOT NULL AND v.outcome IN('PASS','RETURN','DISCARD')")} AS decided,
      ${cycleCount('v.submitted_at IS NULL')} AS direct_discarded,
      ${cycleCount('v.submitted_at IS NOT NULL AND v.outcome IS NULL')} AS unjudged,
      ${cycleCount("v.submitted_at IS NOT NULL AND v.outcome IS NULL AND v.reason='PENDING'")} AS pending,
      ${cycleCount("v.submitted_at IS NOT NULL AND v.outcome IS NULL AND v.reason IN('ADMIN_DIRECT','NOT_SELECTED')")} AS bypassed,
      ${cycleCount("v.submitted_at IS NOT NULL AND v.outcome IS NULL AND coalesce(v.reason,'NO_RECORD') NOT IN('PENDING','ADMIN_DIRECT','NOT_SELECTED')")} AS unjudged_other
    FROM verdicts v GROUP BY v.account_id,v.day
  ), task_flags AS (SELECT account_id,task_id,bool_or(stage='COPY' AND first) AS first_copy,
    bool_or(stage='COPY' AND NOT first) AS rework_copy FROM period_work GROUP BY account_id,task_id),
  work_summary AS (
    SELECT account_id,count(*) AS total_jobs,
      count(*) FILTER(WHERE stage='COPY' AND first) AS copy_first,
      count(*) FILTER(WHERE stage='COPY' AND NOT first) AS copy_rework,
      count(*) FILTER(WHERE stage='IMAGE' AND first) AS image_first,
      count(*) FILTER(WHERE stage='IMAGE' AND NOT first) AS image_rework,
      count(DISTINCT task_id) FILTER(WHERE stage='COPY' AND first) AS copy_first_tasks,
      count(DISTINCT task_id) FILTER(WHERE stage='COPY' AND NOT first) AS copy_rework_tasks,
      count(DISTINCT task_id) FILTER(WHERE stage='IMAGE' AND NOT first) AS image_rework_tasks,
      count(DISTINCT task_id) FILTER(WHERE kind='ANNOTATION_DISCARD') AS discarded
    FROM period_work GROUP BY account_id
  ), identities AS (SELECT DISTINCT ON(w.account_id) w.account_id,
    coalesce(u.username,w.data->>'username') AS username,
    coalesce(u.display_name,w.data->>'displayName',w.data->>'username','历史账号 #'||w.account_id) AS display_name
    FROM period_work w LEFT JOIN app_users u ON u.id=w.account_id ORDER BY w.account_id,occurred_at DESC,event_key DESC),
  daily AS (SELECT account_id,day,count(*) AS total_jobs,
    count(*) FILTER(WHERE first AND stage='COPY') AS copy_review,
    count(*) FILTER(WHERE first AND stage='IMAGE') AS image_first FROM period_work GROUP BY account_id,day)
  SELECT jsonb_build_object('work',coalesce((SELECT jsonb_agg(to_jsonb(w)||to_jsonb(i)) FROM work_summary w JOIN identities i USING(account_id)),'[]'),
    'cycles',coalesce((SELECT jsonb_agg(to_jsonb(c)) FROM cycle_summary c),'[]'),
    'daily',coalesce((SELECT jsonb_agg(to_jsonb(d)) FROM daily d),'[]'),
    'intersections',coalesce((SELECT jsonb_agg(to_jsonb(f)) FROM (SELECT account_id,count(*) FILTER(WHERE first_copy AND rework_copy) AS total
      FROM task_flags GROUP BY account_id) f),'[]')) AS annotation`;
}

export async function readSqlAnnotationJobReport(client,filters,asOf,baseReport,dataCutoff=baseReport?.dataCutoff??asOf,options={}) {
  const snapshot=baseReport??await readAnnotationJobBase(client,filters,asOf,dataCutoff,options);
  const raw=(await client.query(annotationJobReportSql(options),[...operatorReportParameters(filters,dataCutoff).slice(0,7),snapshot.people.map(person=>person.accountId)])).rows[0].annotation;
  const work=new Map(raw.work.map(row=>[Number(row.account_id),row]));
  const cycles=new Map();
  const dayCycles=new Map();
  for(const row of raw.cycles) {
    const accountId=Number(row.account_id),value=cycles.get(accountId)??{};
    for(const key of ['passed','returned','qa_discarded','decided','direct_discarded','unjudged','pending','bypassed','unjudged_other']) {
      value[key]=(value[key]??0)+Number(row[key]);
    }
    cycles.set(accountId,value);dayCycles.set(`${row.day}:${accountId}`,row);
  }
  const identities=new Map(snapshot.people.map(person=>[person.accountId,person]));
  for(const [accountId,row] of work)if(!identities.has(accountId))identities.set(accountId,
    {accountId,username:row.username,displayName:row.display_name,annotationOverallPass:{failed:0,decided:0}});
  const intersections=new Map(raw.intersections.map(row=>[Number(row.account_id),Number(row.total)]));
  const people=[...identities.values()].filter(person=>work.has(person.accountId)||person.annotationOverallPass.decided>0).map(person=>{
    const w=work.get(person.accountId)??{},c=cycles.get(person.accountId)??{},n=key=>Number(w[key]??0),q=key=>Number(c[key]??0);
    const intersection=intersections.get(person.accountId)??0;
    return {accountId:person.accountId,username:person.username,displayName:person.displayName,totalJobs:n('total_jobs'),
      copyReview:n('copy_first'),copyReviewTasks:n('copy_first_tasks'),copyRework:n('copy_rework'),copyReworkTasks:n('copy_rework_tasks'),
      copyReworkOfFirstTasks:intersection,copyReworkOtherTasks:n('copy_rework_tasks')-intersection,
      imageReview:n('image_first')+n('image_rework'),imageFirstReview:n('image_first'),imageRework:n('image_rework'),
      imageReworkTasks:n('image_rework_tasks'),discarded:n('discarded'),copyFirstPassRate:q('decided')?q('passed')/q('decided'):0,
      copyFirstPassed:q('passed'),copyDecided:q('decided'),copyFirstReturned:q('returned'),copyFirstQaDiscarded:q('qa_discarded'),
      copyFirstUnjudged:q('unjudged'),copyFirstDirectDiscarded:q('direct_discarded'),copyFirstPending:q('pending'),
      copyFirstBypassed:q('bypassed'),copyFirstUnjudgedOther:q('unjudged_other'),returned:person.annotationOverallPass.failed};
  }).sort((a,b)=>b.totalJobs-a.totalJobs||a.accountId-b.accountId);
  const dates=snapshot.trend.map(row=>row.date);
  const daily=raw.daily.map(row=>{
    const accountId=Number(row.account_id),c=dayCycles.get(`${row.day}:${accountId}`)??{},decided=Number(c.decided??0),passed=Number(c.passed??0);
    return {date:row.day,accountId,totalJobs:Number(row.total_jobs),copyReview:Number(row.copy_review),imageFirstReview:Number(row.image_first),
      copyFirstPassed:passed,copyDecided:decided,copyFirstPassRate:decided?passed/decided:null};
  }).sort((a,b)=>a.date.localeCompare(b.date)||a.accountId-b.accountId);
  return {timezone:snapshot.timezone,asOf,range:snapshot.range,summary:{workers:people.filter(p=>p.totalJobs>0).length,
    totalJobs:people.reduce((sum,p)=>sum+p.totalJobs,0),returned:people.reduce((sum,p)=>sum+p.returned,0)},people,
    trend:{dates,rows:daily},dataQuality:{unknownIdentity:snapshot.dataQuality.unknownIdentity,
      unattributedAnnotationBatchReturns:snapshot.dataQuality.unattributedAnnotationBatchReturns,
      unattributedAnnotationBatchScopes:snapshot.dataQuality.unattributedAnnotationBatchScopes}};
}
