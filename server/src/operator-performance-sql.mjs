import { OPERATOR_EVENTS_SOURCE_SQL, OPERATOR_CURRENT_SOURCE_SQL, OPERATOR_PENDING_SOURCE_SQL } from './operator-performance-event-sources.mjs';
import { ACCOUNT_RECORDS_SOURCE_SQL, ANNOTATION_VERDICTS_SOURCE_SQL, UNKNOWN_BATCH_SOURCE_SQL } from './operator-performance-account-sources.mjs';
import { QA_ACTIVITY_SQL, QA_PENDING_SQL } from './quality-review-statistics.mjs';
import { inspectionRoundCtes } from './operator-performance-facts-query.mjs';
import { projectedOperatorEventsSourceSql } from './report-query-projections.mjs';
import { PERFORMANCE_VERSION, summarizeOperator } from '../../src/operator-performance.mjs';
import { slimSummaryRawFacts, summaryMetricCte, useSummaryMetricColumns } from './operator-performance-summary-query.mjs';

const withoutLimit = sql => sql.replace(/\s+LIMIT\s+\d+\s*$/u, '');
const bind = (sql, indexes) => sql.replace(/\$(\d+)/gu, (_, n) => `$${indexes[Number(n)-1]}`);
const iso = value => value instanceof Date ? value.toISOString() : value;
const safe = value => `report_safe_integer(${value})`;
const bool = (key, alias='f') => `${alias}.data->>'${key}'='true'`;
const empty = () => summarizeOperator([]);

export function operatorReportParameters(filters, asOf) {
  return [new Date(filters.range.startMs).toISOString(),new Date(filters.range.endMs).toISOString(),asOf,
    filters.accountId,filters.stage,filters.batchId,filters.query.toLocaleLowerCase('zh-CN'),filters.activity];
}

const jsonCommon = (id, account, at, canOpen,alias='') => `jsonb_build_object('id',${id},'taskId',${alias}task_id,
  'accountId',${account},'stage',${alias}stage,'kind',${alias}kind,'at',${at},'canOpen',${canOpen})`;

// Every source keeps the existing legacy/v2 attribution and duplicate rules.
// The resulting relation is consumed by GROUP BY or LIMIT/OFFSET; no complete
// event set crosses the database connection or enters the snapshot cache.
export function operatorReportFactCtes({accountParameter=4,annotationOnly=false,useProjections=true,summaryOnly=false,materializeCurrent=false}={}) {
  const records=bind(ACCOUNT_RECORDS_SOURCE_SQL,[1,2,accountParameter,5,6]);
  const verdicts=bind(ANNOTATION_VERDICTS_SOURCE_SQL,[1,2,accountParameter,5,6]);
  const unknown=bind(UNKNOWN_BATCH_SOURCE_SQL,[1,2,5,6]);
  const current=annotationOnly?`SELECT latest.task_id,latest.account_id,latest.username,latest.stage,latest.phase,latest.state,
    latest.occurred_at AS waiting_at,NULL::timestamptz AS assigned_at,NULL::text AS query,NULL::bigint AS batch_id,
    NULL::jsonb AS last_quality,coalesce(u.display_name,latest.username,'历史身份未确认') AS display_name
    FROM operator_stage_current latest JOIN tasks t ON t.id=latest.task_id LEFT JOIN app_users u ON u.id=latest.account_id
    WHERE latest.phase<>'CLOSED' AND ($${accountParameter}::bigint IS NULL OR latest.account_id=$${accountParameter})
      AND ($5::text='' OR latest.stage=$5) AND ($6::bigint IS NULL OR t.production_batch_id=$6)`
    :bind(OPERATOR_CURRENT_SOURCE_SQL,[accountParameter,5,6]).replace(/\s+ORDER BY latest\.task_id$/u,'')
      .replace('latest.*,t.query,',`latest.*,${summaryOnly?'NULL::text AS query':'t.query'},`);
  const pending=bind(OPERATOR_PENDING_SOURCE_SQL,[1,2,accountParameter,5,6]);
  const qaPending=bind(withoutLimit(QA_PENDING_SQL),[4,5,6]).replace('SELECT a.*,u.id AS account_id',
    'SELECT a.stage,a.source,a.id,a.public_id,a.task_id,a.assigned_review_at,a.sample_kind,a.submitter_id,'+
    'a.copy_revision_id,a.image_run_id,a.batch_id,a.qa_batch_id,a.qa_batch_public_id,a.qa_batch_display_name,'+
    'a.query,a.priority_paused,a.editing,u.id AS account_id');
  const facts = `operator_raw AS MATERIALIZED (${bind(useProjections?projectedOperatorEventsSourceSql():OPERATOR_EVENTS_SOURCE_SQL,[1,2,3,accountParameter,5,6])}),
    current_raw AS ${materializeCurrent?'':'NOT '}MATERIALIZED (${current}),
    account_raw AS (${records}), annotation_raw AS (${verdicts}),
    unknown_batch_raw AS (${unknown}), production_pending_raw AS (${pending}),
    qa_raw AS (${withoutLimit(QA_ACTIVITY_SQL)}),qa_pending_raw AS (${qaPending}),
    qa_recovery_scopes AS (SELECT DISTINCT stage,${safe("data->>'freezeId'")} AS freeze_id FROM qa_raw
      WHERE kind='QA_BATCH_RETURN' AND NOT coalesce(jsonb_typeof(data->'affectedCount')='number' AND ${safe("data->>'affectedCount'")}>=0,false)
        AND NOT report_valid_task_ids(data->'affectedTaskIds')),
    raw_facts AS (
      SELECT e.event_key,e.task_id,e.account_id,e.stage,e.kind,e.occurred_at,
        e.data||${jsonCommon('event_key','account_id','occurred_at','task_exists','e.')}
          ||jsonb_build_object('sampleSelected',sample_selected,'previousSubmittedAt',previous_submitted_at,
            'returnedAt',returned_at,'returnRound',0) AS data
      FROM operator_raw e WHERE $8<>'QA'
      UNION ALL
      SELECT 'account-quality:'||r.id,r.task_id,r.operator_account_id,r.stage,'ACCOUNT_QUALITY',r.first_qa_at,
        r.data||jsonb_build_object('id','account-quality:'||r.id,'taskId',r.task_id,'accountId',r.operator_account_id,
          'stage',r.stage,'kind','ACCOUNT_QUALITY','at',r.first_qa_at,'firstQaAt',r.first_qa_at,
          'outcomeChangedAt',r.outcome_changed_at,'outcomeVersion',r.outcome_version,'reassigned',r.reassigned,
          'bucket',r.current_bucket,'outcome',r.current_bucket,'canOpen',r.task_exists,
          'username',COALESCE(r.current_username,r.data->>'username'),
          'displayName',COALESCE(r.current_display_name,r.data->>'displayName'))
      FROM account_raw r WHERE $8<>'QA'
      UNION ALL
      SELECT 'annotation-quality:'||r.event_key,r.task_id,r.account_id,r.stage,'ANNOTATION_QUALITY',r.occurred_at,
        COALESCE(r.record_data,'{}')||r.data||jsonb_build_object('id','annotation-quality:'||r.event_key,
          'taskId',r.task_id,'accountId',r.account_id,'stage',r.stage,'kind','ANNOTATION_QUALITY','at',r.occurred_at,
          'day',r.verdict_day,'outcome',r.action,'exclusion',NULL,'canOpen',r.task_exists,
          'username',COALESCE(r.current_username,r.data->>'username',r.record_data->>'username'),
          'displayName',COALESCE(r.current_display_name,r.data->>'displayName',r.record_data->>'displayName'),
          'query',COALESCE(r.current_query,r.data->>'query',r.record_data->>'query'),
          'batchId',COALESCE(${safe("r.data->>'batchId'")},${safe("r.record_data->>'batchId'")},r.production_batch_id),
          'firstQaAt',r.first_qa_at,'outcomeChangedAt',r.outcome_changed_at,'outcomeVersion',r.outcome_version,
          'reassigned',COALESCE(r.reassigned,false),'fromBatch',r.from_batch,
          'firstPassed',r.action='PASS' AND NOT r.had_return AND COALESCE(r.data->>'sampleKind',r.record_data->>'sampleKind','')<>'MANDATORY_RECHECK',
          'reworkPassed',r.action='PASS' AND (r.had_return OR COALESCE(r.data->>'sampleKind',r.record_data->>'sampleKind','')='MANDATORY_RECHECK'),
          'finalPassed',r.action='PASS')
      FROM annotation_raw r WHERE $8<>'QA'
      UNION ALL
      SELECT 'annotation-unknown-batch:'||r.event_key,NULL::bigint,NULL::bigint,r.stage,'ANNOTATION_UNKNOWN_BATCH',r.occurred_at,
        jsonb_build_object('id','annotation-unknown-batch:'||r.event_key,'taskId',NULL,'accountId',NULL,'stage',r.stage,
          'kind','ANNOTATION_UNKNOWN_BATCH','at',r.occurred_at,'batchId',${safe("r.data->>'batchId'")},
          'unknownCount',CASE WHEN ${safe("r.data->>'affectedCount'")}>=0
            THEN greatest(0,${safe("r.data->>'affectedCount'")}-r.known_count) END,
          'unknownScope',${safe("r.data->>'affectedCount'")} IS NULL)
      FROM unknown_batch_raw r WHERE $8<>'QA' AND $4::bigint IS NULL
        AND COALESCE(r.data->>'exclusion','')<>'SIMULATED'
        AND (${safe("r.data->>'affectedCount'")} IS NULL OR ${safe("r.data->>'affectedCount'")}>r.known_count)
      UNION ALL
      SELECT 'pending:'||q.stage||':'||q.id,q.task_id,q.account_id,q.stage,
        CASE WHEN q.selected AND q.status='PENDING' THEN 'PENDING' ELSE 'EXCLUDED' END,q.created_at,
        jsonb_build_object('id','pending:'||q.stage||':'||q.id,'taskId',q.task_id,'accountId',q.account_id,
          'stage',q.stage,'kind',CASE WHEN q.selected AND q.status='PENDING' THEN 'PENDING' ELSE 'EXCLUDED' END,
          'at',q.created_at,'username',q.username,'displayName',q.display_name,'batchId',q.batch_id,'query',q.query,
          'exclusion',q.exclusion,'copyRevisionId',q.copy_revision_id,'imageRunId',q.image_run_id,
          'sampleKind',q.sample_kind,'first',q.first_random,'policyVersion',q.policy_version)
      FROM production_pending_raw q WHERE $8<>'QA'
      UNION ALL
      SELECT e.event_key,e.task_id,e.account_id,e.stage,e.kind,e.occurred_at,
        e.data||${jsonCommon('event_key','account_id','occurred_at','task_exists','e.')}
        ||CASE WHEN recovered.freeze_id IS NOT NULL AND NOT coalesce(jsonb_typeof(e.data->'affectedCount')='number' AND ${safe("e.data->>'affectedCount'")}>=0,false)
          AND NOT report_valid_task_ids(e.data->'affectedTaskIds')
          AND (e.stage='COPY' AND EXISTS(SELECT 1 FROM copy_sampling_freezes WHERE id=${safe("e.data->>'freezeId'")})
            OR e.stage='IMAGE' AND EXISTS(SELECT 1 FROM image_sampling_freezes WHERE id=${safe("e.data->>'freezeId'")})) THEN
          jsonb_build_object('affectedCountRecovered',true,'affectedCount',CASE WHEN e.stage='COPY' THEN
            (SELECT count(i.id) FROM copy_sampling_freezes f LEFT JOIN copy_sampling_items i
              ON i.freeze_id=f.id AND i.status='BATCH_AFFECTED' WHERE f.id=${safe("e.data->>'freezeId'")})
            ELSE (SELECT count(i.id) FROM image_sampling_freezes f LEFT JOIN image_sampling_items i
              ON i.freeze_id=f.id AND i.status='BATCH_RETURNED' WHERE f.id=${safe("e.data->>'freezeId'")}) END)
          ELSE '{}'::jsonb END
      FROM qa_raw e LEFT JOIN qa_recovery_scopes recovered ON recovered.stage=e.stage
        AND recovered.freeze_id=${safe("e.data->>'freezeId'")} WHERE $8<>'PRODUCTION'
      UNION ALL
      SELECT 'qa-pending:'||q.stage||':'||CASE WHEN q.source='v2' THEN 'v2:' ELSE '' END||q.id,
        q.task_id,q.account_id,q.stage,'QA_PENDING',q.assigned_review_at,
        jsonb_build_object('id','qa-pending:'||q.stage||':'||CASE WHEN q.source='v2' THEN 'v2:' ELSE '' END||q.id,
          'taskId',q.task_id,'accountId',q.account_id,'stage',q.stage,'kind','QA_PENDING','at',q.assigned_review_at,
          'username',q.username,'displayName',q.display_name,'query',q.query,'batchId',q.batch_id,
          'samplingItemId',q.id,'samplingItemPublicId',q.public_id,'sampleKind',q.sample_kind,
          'qaBatchId',q.qa_batch_id,'qaBatchPublicId',q.qa_batch_public_id,'qaBatchDisplayName',q.qa_batch_display_name,
          'copyRevisionId',q.copy_revision_id,'imageRunId',q.image_run_id,'blocked',q.blocked,'passBlocked',q.editing,'canOpen',true)
      FROM qa_pending_raw q WHERE $8<>'PRODUCTION'
    ), ${annotationOnly?`current_facts AS (SELECT c.*,false AS reassign_suggested FROM current_raw c),
      all_facts AS (SELECT * FROM raw_facts)`:`round_source_base AS MATERIALIZED (
      SELECT * FROM raw_facts
      UNION ALL SELECT 'current-decision:'||c.task_id,c.task_id,${safe("c.last_quality->>'accountId'")},c.stage,'QUALITY',
        report_safe_timestamp(c.last_quality->>'at'),c.last_quality FROM current_raw c WHERE c.last_quality IS NOT NULL
    ), round_source AS (
      SELECT s.event_key,coalesce(s.task_id,batch_link.task_id) AS task_id,s.account_id,s.stage,s.kind,s.occurred_at,s.data
      FROM round_source_base s LEFT JOIN LATERAL (
        SELECT l.task_id FROM quality_inspection_links l WHERE s.kind='QA_BATCH_RETURN' AND s.task_id IS NULL
          AND l.stage=s.stage AND l.item_id=${safe("s.data->>'samplingItemId'")} AND l.created_at<=$3::timestamptz
          AND EXISTS(SELECT 1 FROM round_source_base other WHERE other.task_id=l.task_id)
        LIMIT 1
      ) batch_link ON true
    ), ${annotationOnly?`report_round_selected AS (SELECT event_key,NULL::bigint AS item_id FROM raw_facts WHERE false),
      round_facts AS (SELECT r.*,NULL::integer AS review_round,NULL::integer AS return_round,
        0::integer AS consecutive_returns,false AS round_known,false AS first_recheck,NULL::bigint AS root_item_id FROM raw_facts r)`
      :inspectionRoundCtes({source:'round_source',output:'round_facts',prefix:'report_round'})},
    enriched_facts AS (
      SELECT r.event_key,CASE WHEN r.kind='QA_BATCH_RETURN' AND r.data->>'taskId' IS NULL THEN NULL ELSE r.task_id END AS task_id,
        r.account_id,r.stage,r.kind,r.occurred_at,r.data
        ||CASE WHEN r.data->>'samplingItemId' ~ '^[1-9][0-9]{0,15}$' OR round_seed.item_id IS NOT NULL THEN
          jsonb_build_object('reviewRound',r.review_round,'returnRound',r.return_round,
          'consecutiveReturns',r.consecutive_returns,'roundKnown',r.round_known,
          'firstRecheck',r.first_recheck,'rootItemId',r.root_item_id)
          WHEN r.kind IN('QUALITY','RETURN') THEN jsonb_build_object('returnRound',NULL,'roundKnown',false)
          ELSE '{}'::jsonb END
        ||CASE WHEN ${annotationOnly?'false':"r.kind='SUBMIT' AND COALESCE(r.data->>'exclusion','')='' AND r.account_id IS NOT NULL"} THEN
          jsonb_build_object('timing',${useProjections?"coalesce(projected.timing,":""}jsonb_build_object('humanMs',timing.human_ms,'backgroundMs',timing.background_ms,
            'qualityWaitMs',timing.quality_wait_ms,'reason',timing.reason)${useProjections?")":""}) ELSE '{}'::jsonb END AS data
      FROM round_facts r
      LEFT JOIN report_round_selected round_seed ON round_seed.event_key=r.event_key
      ${useProjections?`LEFT JOIN report_operator_event_context projected ON projected.event_key=r.event_key AND projected.task_id=r.task_id
        AND EXISTS(SELECT 1 FROM report_projection_tasks revision WHERE revision.task_id=projected.task_id
          AND revision.revision=revision.projected_revision AND revision.revision=projected.source_revision)`:''}
      LEFT JOIN LATERAL (
        SELECT CASE WHEN bounds.starts_at IS NULL OR covering.id IS NULL OR covering.baseline AND
            covering.occurred_at>COALESCE(report_safe_timestamp(r.data->>'previousSubmittedAt'),'-infinity'::timestamptz)
          THEN NULL ELSE sum(elapsed.ms) FILTER(WHERE segment.stage=r.stage AND segment.account_id=r.account_id AND segment.phase='HUMAN' AND elapsed.ms>0) END AS human_ms,
          CASE WHEN bounds.starts_at IS NULL OR covering.id IS NULL OR covering.baseline AND
            covering.occurred_at>COALESCE(report_safe_timestamp(r.data->>'previousSubmittedAt'),'-infinity'::timestamptz)
            THEN NULL ELSE coalesce(sum(elapsed.ms) FILTER(WHERE segment.stage=r.stage AND segment.phase IN ('BACKGROUND','MACHINE_QUEUE','MACHINE_RUNNING')),0) END AS background_ms,
          CASE WHEN bounds.starts_at IS NULL OR covering.id IS NULL OR covering.baseline AND
            covering.occurred_at>COALESCE(report_safe_timestamp(r.data->>'previousSubmittedAt'),'-infinity'::timestamptz)
            THEN NULL ELSE coalesce(sum(elapsed.ms) FILTER(WHERE segment.stage=r.stage AND segment.phase='QUALITY_WAIT'),0) END AS quality_wait_ms,
          CASE WHEN bounds.starts_at IS NULL OR covering.id IS NULL THEN 'UNKNOWN_START'
            WHEN covering.baseline AND covering.occurred_at>COALESCE(report_safe_timestamp(r.data->>'previousSubmittedAt'),'-infinity'::timestamptz) THEN 'UNKNOWN_START'
            WHEN count(*) FILTER(WHERE segment.stage=r.stage AND segment.account_id=r.account_id AND segment.phase='HUMAN' AND elapsed.ms>0)=0 THEN 'NO_OWN_INTERVAL' END AS reason
        FROM LATERAL (SELECT coalesce(report_safe_timestamp(r.data->>'previousSubmittedAt'),
          (SELECT occurred_at FROM operator_stage_events first WHERE first.task_id=r.task_id AND first.stage=r.stage
            AND first.occurred_at<=r.occurred_at ORDER BY occurred_at,id LIMIT 1)) AS starts_at) bounds
        LEFT JOIN LATERAL (SELECT * FROM operator_stage_events cover WHERE cover.task_id=r.task_id
          AND cover.occurred_at<=bounds.starts_at ORDER BY cover.occurred_at DESC,cover.id DESC LIMIT 1) covering ON true
        LEFT JOIN LATERAL (SELECT e.*,lead(e.occurred_at,1,r.occurred_at) OVER(ORDER BY e.occurred_at,e.id) AS ends_at
          FROM operator_stage_events e WHERE e.task_id=r.task_id AND e.occurred_at<=r.occurred_at) segment ON true
        LEFT JOIN LATERAL (SELECT greatest(0,extract(epoch FROM least(date_trunc('milliseconds',segment.ends_at),date_trunc('milliseconds',r.occurred_at))
          -greatest(date_trunc('milliseconds',segment.occurred_at),date_trunc('milliseconds',bounds.starts_at)))*1000) AS ms) elapsed ON true
        GROUP BY bounds.starts_at,covering.id,covering.baseline,covering.occurred_at
      ) timing ON ${annotationOnly?'false':`${useProjections?'projected.timing IS NULL AND ':''}r.kind='SUBMIT' AND r.account_id IS NOT NULL AND COALESCE(r.data->>'exclusion','')=''`}
      WHERE r.event_key NOT LIKE 'current-decision:%'
    ), current_decisions AS MATERIALIZED (
      SELECT * FROM round_facts WHERE event_key LIKE 'current-decision:%'
    ), current_facts AS (
      SELECT c.task_id,c.account_id,c.stage,c.phase,c.waiting_at,c.assigned_at,c.username,c.display_name,c.query,c.state,c.batch_id,
        CASE WHEN r.event_key IS NOT NULL THEN r.data||jsonb_build_object('roundKnown',r.round_known,'consecutiveReturns',r.consecutive_returns,
          'reviewRound',r.review_round,'returnRound',r.return_round,'firstRecheck',r.first_recheck) END AS last_quality,
        c.phase='HUMAN' AND c.account_id IS NOT NULL AND r.account_id=c.account_id
          AND r.stage=c.stage AND r.data->>'outcome'='RETURN' AND COALESCE(r.data->>'exclusion','')=''
          AND r.round_known AND r.consecutive_returns>=2
          AND (c.assigned_at IS NULL OR report_safe_timestamp(r.data->>'submittedAt')>=c.assigned_at) AS reassign_suggested
      FROM current_raw c LEFT JOIN current_decisions r ON r.task_id=c.task_id AND r.stage=c.stage WHERE $8<>'QA'
    ), all_facts AS (
      SELECT * FROM enriched_facts
      UNION ALL SELECT 'reassign:'||c.task_id||':'||c.stage,c.task_id,c.account_id,c.stage,'REASSIGN',
        report_safe_timestamp(c.last_quality->>'at'),c.last_quality||jsonb_build_object('id','reassign:'||c.task_id||':'||c.stage,
          'kind','REASSIGN','accountId',c.account_id,'username',c.username,'displayName',c.display_name,'query',c.query,'batchId',c.batch_id,
          'returnedAt',c.last_quality->>'at','waitingMs',greatest(0,extract(epoch FROM date_trunc('milliseconds',$3::timestamptz)
            -date_trunc('milliseconds',c.waiting_at))*1000),'canOpen',true) FROM current_facts c WHERE c.reassign_suggested
    )`}, matching_accounts AS (
      SELECT DISTINCT account_id FROM (
        SELECT account_id,data->>'displayName' AS display_name,data->>'username' AS username FROM all_facts
        UNION ALL SELECT account_id,display_name,username FROM current_facts
        UNION ALL SELECT id,display_name,username FROM app_users WHERE $8='ALL' AND ($4::bigint IS NULL OR id=$4)
      ) identities WHERE account_id IS NOT NULL AND strpos(lower(coalesce(display_name,'')||' '||coalesce(username,'')),$7)>0
    ), selected_facts AS ${summaryOnly?'NOT ':''}MATERIALIZED (
      SELECT f.* FROM all_facts f WHERE ($7='' OR f.account_id IN(SELECT account_id FROM matching_accounts)
        OR f.account_id IS NULL AND strpos(lower(coalesce(f.data->>'displayName','')||' '||coalesce(f.data->>'username','')),$7)>0)
        AND (f.kind IN('PENDING','EXCLUDED','QA_PENDING','REASSIGN') OR f.occurred_at>=$1::timestamptz AND f.occurred_at<$2::timestamptz)
    ), selected_current AS NOT MATERIALIZED (
      SELECT c.*,greatest(0,extract(epoch FROM date_trunc('milliseconds',$3::timestamptz)
        -date_trunc('milliseconds',c.waiting_at))*1000) AS waiting_ms FROM current_facts c
      WHERE $7='' OR account_id IN(SELECT account_id FROM matching_accounts)
        OR account_id IS NULL AND strpos(lower(coalesce(display_name,'')||' '||coalesce(username,'')),$7)>0
    ), marked AS (
      SELECT f.*,COALESCE(f.data->>'exclusion','')='' AND f.account_id IS NOT NULL AS valid,
        left(f.kind,3)='QA_' AS qa_activity,
        row_number() OVER(PARTITION BY CASE WHEN f.kind='QA_REVIEW' THEN f.stage||':'||CASE WHEN f.stage='COPY'
          AND f.data->>'qaBatchId' IS NOT NULL THEN 'copy-v2' ELSE 'legacy' END||':'||COALESCE(f.data->>'samplingItemId',f.event_key)
          ELSE f.event_key END ORDER BY f.occurred_at,f.event_key) AS qa_order
      FROM selected_facts f
    ), classified AS ${summaryOnly?'NOT ':''}MATERIALIZED (
      SELECT f.*,kind='SUBMIT' AND valid AS submission,
        valid AND (kind='RETURN' OR kind='QUALITY' AND data->>'outcome'='RETURN') AS returned,
        kind IN('QA_REVIEW','QA_ESCALATE') AND valid AND account_id>0 AND data->>'outcome' IN('PASS','RETURN','ESCALATE') AND qa_order=1 AS qa_review,
        kind='QA_BATCH_RETURN' AND valid AS qa_batch,
        kind IN('QA_DIRECT_PASS','QA_DISCARD') AND valid AS qa_special,
        kind='QUALITY' AND valid AND data->>'first'='true' AND data->>'sampleKind'='RANDOM' AND data->>'outcome' IN('PASS','RETURN') AS first_sample,
        kind='QUALITY' AND valid AND data->>'sampleKind'='MANDATORY_RECHECK' AND data->>'outcome' IN('PASS','RETURN') AS recheck,
        kind='ANNOTATION_QUALITY' AND valid AND account_id>0 AND data->>'outcome' IN('PASS','RETURN') AS annotation_quality,
        CASE WHEN jsonb_typeof(data->'affectedCount')='number' AND ${safe("data->>'affectedCount'")}>=0 THEN ${safe("data->>'affectedCount'")}
          WHEN report_valid_task_ids(data->'affectedTaskIds') THEN jsonb_array_length(data->'affectedTaskIds') END AS affected_count,
        report_safe_timestamp(data->>'submittedAt') AS submitted_at,
        ${safe("data->'timing'->>'humanMs'")} AS human_ms,
        extract(epoch FROM date_trunc('milliseconds',occurred_at)-date_trunc('milliseconds',report_safe_timestamp(data->>'submittedAt')))*1000 AS quality_wait_ms,
        extract(epoch FROM date_trunc('milliseconds',occurred_at)-date_trunc('milliseconds',report_safe_timestamp(data->>'returnedAt')))*1000 AS rework_ms,
        to_char(occurred_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day
      FROM marked f
    )`;
  return summaryOnly && !annotationOnly
    ? `${slimSummaryRawFacts(facts)}, ${summaryMetricCte()}`
    : facts;
}

const count = condition => `count(*) FILTER(WHERE ${condition})`;
const tasks = condition => `count(DISTINCT task_id) FILTER(WHERE ${condition})`;
const object = fields => `jsonb_build_object(${Object.entries(fields).flatMap(([key,value])=>[`'${key}'`,value]).join(',')})`;
const distribution = (value, condition, missing='0') => object({
  samples:count(`${condition} AND ${value}>=0`),missing,
  meanMs:`round(avg(${value}) FILTER(WHERE ${condition} AND ${value}>=0))`,
  medianMs:`percentile_cont(0.5) WITHIN GROUP(ORDER BY (${value})::double precision) FILTER(WHERE ${condition} AND ${value}>=0)`,
  p90Ms:`percentile_disc(0.9) WITHIN GROUP(ORDER BY ${value}) FILTER(WHERE ${condition} AND ${value}>=0)`,
});
const rateCounts = condition => object({passed:count(`${condition} AND data->>'outcome'='PASS'`),failed:count(`${condition} AND data->>'outcome'='RETURN'`)});
const annotationCounts = () => object({firstPassed:count("annotation_quality AND data->>'firstPassed'='true'"),
  passed:count("annotation_quality AND data->>'outcome'='PASS'"),failed:count("annotation_quality AND data->>'outcome'='RETURN'")});
const accountCounts = () => object({discarded:count("kind='ACCOUNT_QUALITY' AND valid AND data->>'bucket'='DISCARDED'"),
  firstPassed:count("kind='ACCOUNT_QUALITY' AND valid AND data->>'bucket'='FIRST_PASS'"),
  returned:count("kind='ACCOUNT_QUALITY' AND valid AND data->>'bucket'='RETURNED'"),
  reassigned:count("kind='ACCOUNT_QUALITY' AND valid AND data->>'reassigned'='true'"),
  tasks:tasks("kind='ACCOUNT_QUALITY' AND valid")});

export function operatorReportAggregateSql({useProjections=true,materializeCurrent=false,summaryOnly=useProjections}={}) {
  const stage=object({qualityOutcomes:accountCounts(),annotationOverallPass:annotationCounts(),
    submitted:tasks('submission'),submissions:count('submission'),
    firstSubmitted:tasks("submission AND data->>'firstSubmission'='true'"),
    reworked:tasks("submission AND data->>'rework'='true'"),reworkSubmissions:count("submission AND data->>'rework'='true'"),
    returned:tasks('returned'),firstPass:rateCounts('first_sample'),
    overallPass:object({passed:count("first_sample AND (data->>'outcome'='PASS' OR repaired)"),
      failed:count("first_sample AND data->>'outcome'='RETURN' AND NOT repaired")}),
    recheck:rateCounts('recheck'),firstRecheck:rateCounts("recheck AND data->>'firstRecheck'='true'"),
    duration:distribution('human_ms','submission',count('submission AND human_ms IS NULL')),
    qualityWait:distribution('quality_wait_ms',"kind='QUALITY' AND valid"),
    coverage:object({eligible:count("submission AND data->>'firstSubmission'='true' AND jsonb_typeof(data->'sampleSelected')='boolean'"),
      sampled:count("submission AND data->>'firstSubmission'='true' AND data->>'sampleSelected'='true'"),
      unresolved:count("submission AND data->>'firstSubmission'='true' AND jsonb_typeof(data->'sampleSelected') IS DISTINCT FROM 'boolean'")}),
    pending:count("kind='PENDING'"),excluded:count("NOT qa_activity AND (NOT valid OR kind='EXCLUDED')")});
  const qa=object({tasks:tasks('qa_review'),reviews:count('qa_review'),passed:count("qa_review AND data->>'outcome'='PASS'"),
    returned:count("qa_review AND data->>'outcome'='RETURN'"),escalated:count("qa_review AND data->>'outcome'='ESCALATE'"),
    rechecks:count("qa_review AND data->>'sampleKind'='MANDATORY_RECHECK'"),batchActions:count('qa_batch'),
    batchImpactReturns:'coalesce(sum(affected_count) FILTER(WHERE qa_batch),0)',
    unknownBatchScopes:count("qa_batch AND jsonb_typeof(data->'affectedTaskIds') IS DISTINCT FROM 'array'"),
    unknownBatchCounts:count('qa_batch AND affected_count IS NULL'),
    legacyAffectedCount:"coalesce(sum(affected_count) FILTER(WHERE qa_batch AND jsonb_typeof(data->'affectedTaskIds') IS DISTINCT FROM 'array'),0)",
    specialActions:count('qa_special'),directPass:count("qa_special AND kind='QA_DIRECT_PASS'"),discarded:count("qa_special AND kind='QA_DISCARD'"),
    participants:'count(DISTINCT account_id) FILTER(WHERE qa_review OR qa_batch OR qa_special)',
    pending:count("kind='QA_PENDING' AND NOT coalesce(data->>'blocked'='true',false)"),
    blocked:count("kind='QA_PENDING' AND data->>'blocked'='true'"),
    pendingRechecks:count("kind='QA_PENDING' AND NOT coalesce(data->>'blocked'='true',false) AND data->>'sampleKind'='MANDATORY_RECHECK'")});
  const summary=object({qualityOutcomes:accountCounts(),annotationOverallPass:annotationCounts(),qa,
    contributed:tasks('submission OR qa_review'),submitted:tasks('submission'),submissions:count('submission'),
    delivered:tasks("kind='DELIVERY' AND valid"),deliveredBatches:"count(DISTINCT data->>'deliveryBatchId') FILTER(WHERE kind='DELIVERY' AND valid)",
    released:tasks("kind='RELEASE' AND valid AND data->>'first'='true'"),
    rereleased:tasks("kind='RELEASE' AND valid AND NOT coalesce(data->>'first'='true',false)"),
    returned:tasks('returned'),returnRounds:count('returned'),repeatedReturns:tasks("returned AND report_safe_integer(data->>'returnRound')>=2"),
    reworked:tasks("submission AND data->>'rework'='true'"),reworkRounds:count("submission AND data->>'rework'='true'"),
    reassignSuggested:tasks("kind='REASSIGN'"),batchAffected:tasks("kind='BATCH_RETURN'"),
    reworkDuration:distribution('rework_ms',"submission AND data->>'rework'='true'",count("submission AND data->>'rework'='true' AND rework_ms IS NULL"))});
  const aggregate = `repaired_facts AS (
    SELECT f.*,EXISTS(SELECT 1 FROM operator_performance_events repair
      WHERE repair.task_id=f.task_id AND repair.stage=f.stage AND repair.kind='QUALITY'
        AND repair.account_id IS NOT NULL AND COALESCE(repair.data->>'exclusion','')=''
        AND repair.data->>'sampleKind'='MANDATORY_RECHECK' AND repair.data->>'outcome'='PASS'
        AND repair.occurred_at>=$1::timestamptz AND repair.occurred_at<$2::timestamptz AND repair.occurred_at<=$3::timestamptz
        AND date_trunc('milliseconds',repair.occurred_at)>=date_trunc('milliseconds',f.occurred_at)
        AND ($6::bigint IS NULL OR report_safe_integer(repair.data->>'batchId')=$6)) AS repaired FROM classified f
  ), grouped AS (
    SELECT grouping(account_id) AS all_people,grouping(stage) AS all_stages,account_id,stage,
      ${summary} AS summary,${stage} AS stage_summary,${qa} AS qa_stage
    FROM repaired_facts GROUP BY GROUPING SETS((),(stage),(account_id),(account_id,stage))
  ), current_grouped AS (
    SELECT grouping(account_id) AS all_people,grouping(stage) AS all_stages,account_id,stage,
      count(*) FILTER(WHERE phase='HUMAN') AS pending,count(*) FILTER(WHERE phase='QUALITY_WAIT') AS waiting_quality,
      count(*) FILTER(WHERE phase='HUMAN' AND waiting_at<date_trunc('milliseconds',$3::timestamptz)
        -interval '1 day'+interval '1 millisecond') AS long_waiting
    FROM selected_current GROUP BY GROUPING SETS((),(stage),(account_id),(account_id,stage))
  ), reasons_grouped AS (
    SELECT grouping(account_id) AS all_people,account_id,code,count(*) AS total FROM (
      SELECT f.account_id,f.event_key,reason.code FROM repaired_facts f
      JOIN LATERAL (SELECT DISTINCT value #>> '{}' AS code FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(f.data->'reasons')='array' THEN f.data->'reasons' ELSE '[]'::jsonb END)) reason ON true
      WHERE f.returned
    ) codes GROUP BY GROUPING SETS((code),(account_id,code))
  ), affected_grouped AS (
    SELECT grouping(account_id) AS all_people,account_id,count(DISTINCT task) AS total FROM (
      SELECT f.account_id,report_safe_integer(value #>> '{}') AS task FROM repaired_facts f
      JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(f.data->'affectedTaskIds')='array'
        THEN f.data->'affectedTaskIds' ELSE '[]'::jsonb END) item ON true WHERE f.qa_batch
    ) affected GROUP BY GROUPING SETS((),(account_id))
  ), day_grouped AS (
    SELECT day,count(DISTINCT task_id) FILTER(WHERE submission) AS submitted,
      count(DISTINCT task_id) FILTER(WHERE submission AND stage='COPY') AS copy_submitted,
      count(DISTINCT task_id) FILTER(WHERE submission AND stage='IMAGE') AS image_submitted,
      count(*) FILTER(WHERE qa_review) AS qa,
      count(DISTINCT task_id) FILTER(WHERE qa_review AND stage='COPY') AS copy_qa,
      count(DISTINCT task_id) FILTER(WHERE qa_review AND stage='IMAGE') AS image_qa,
      count(DISTINCT task_id) FILTER(WHERE kind='RELEASE' AND valid AND data->>'first'='true') AS released,
      count(*) FILTER(WHERE first_sample AND stage='COPY' AND data->>'outcome'='PASS') AS copy_passed,
      count(*) FILTER(WHERE first_sample AND stage='COPY' AND data->>'outcome'='RETURN') AS copy_failed,
      count(*) FILTER(WHERE first_sample AND stage='IMAGE' AND data->>'outcome'='PASS') AS image_passed,
      count(*) FILTER(WHERE first_sample AND stage='IMAGE' AND data->>'outcome'='RETURN') AS image_failed
    FROM repaired_facts GROUP BY day
  ), current_identity_keys AS (
    SELECT account_id,max(task_id) AS task_id FROM selected_current WHERE account_id IS NOT NULL GROUP BY account_id
  ), current_identities AS (
    SELECT c.account_id,c.username,c.display_name,c.waiting_at FROM selected_current c
    JOIN current_identity_keys i ON i.account_id=c.account_id AND i.task_id=c.task_id
  ), identity_rows AS (
    SELECT account_id,data->>'username' AS username,data->>'displayName' AS display_name,1 AS source_order,occurred_at FROM selected_facts WHERE account_id IS NOT NULL
    UNION ALL SELECT account_id,username,display_name,2,waiting_at FROM current_identities
    UNION ALL SELECT id,username,display_name,3,created_at FROM app_users WHERE $8='ALL'
      AND ($4::bigint IS NULL OR id=$4) AND ($7='' OR id IN(SELECT account_id FROM matching_accounts))
  ), identities AS (
    SELECT DISTINCT ON(account_id) account_id,username,coalesce(display_name,username,'历史账号 #'||account_id) AS display_name
    FROM identity_rows ORDER BY account_id,source_order DESC,occurred_at DESC
  ) SELECT jsonb_build_object(
    'groups',coalesce((SELECT jsonb_agg(to_jsonb(g)) FROM grouped g),'[]'),
    'current',coalesce((SELECT jsonb_agg(to_jsonb(g)) FROM current_grouped g),'[]'),
    'reasons',coalesce((SELECT jsonb_agg(to_jsonb(g)) FROM reasons_grouped g),'[]'),
    'affected',coalesce((SELECT jsonb_agg(to_jsonb(g)) FROM affected_grouped g),'[]'),
    'trend',coalesce((SELECT jsonb_agg(to_jsonb(g)) FROM day_grouped g),'[]'),
    'identities',coalesce((SELECT jsonb_agg(to_jsonb(g)) FROM identities g),'[]'),
    'dataQuality',jsonb_build_object('unknownIdentity',(SELECT count(*) FROM selected_facts WHERE account_id IS NULL AND kind NOT IN('QA_PENDING','ANNOTATION_UNKNOWN_BATCH')),
      'unattributedAnnotationBatchReturns',(SELECT coalesce(sum(report_safe_integer(data->>'unknownCount')),0) FROM selected_facts WHERE kind='ANNOTATION_UNKNOWN_BATCH'),
      'unattributedAnnotationBatchScopes',(SELECT count(*) FROM selected_facts WHERE kind='ANNOTATION_UNKNOWN_BATCH' AND data->>'unknownScope'='true'),
      'excluded',coalesce((SELECT jsonb_agg(jsonb_build_object('reason',reason,'count',n)) FROM (
        SELECT data->>'exclusion' AS reason,count(*) AS n FROM selected_facts WHERE left(kind,3)<>'QA_' AND coalesce(data->>'exclusion','')<>'' GROUP BY data->>'exclusion') reasons),'[]'),
      'timingSince',(SELECT min(s.occurred_at) FROM operator_stage_events s WHERE s.occurred_at<=$3::timestamptz
        AND EXISTS(SELECT 1 FROM operator_raw e WHERE e.task_id=s.task_id AND e.kind='SUBMIT')))) AS report`;
  return `WITH RECURSIVE ${operatorReportFactCtes({useProjections,materializeCurrent,summaryOnly})}, ${summaryOnly ? useSummaryMetricColumns(aggregate) : aggregate}`;
}

function rate(value) {
  const passed=Number(value?.passed??0),failed=Number(value?.failed??0),decided=passed+failed;
  return {passed,failed,decided,rate:decided?passed/decided:null};
}
function quality(value) {
  const discarded=Number(value?.discarded??0),firstPassed=Number(value?.firstPassed??0),returned=Number(value?.returned??0);
  const counts=[discarded,firstPassed,returned],judged=discarded+firstPassed+returned;
  const units=counts.map(n=>judged?Math.floor(n*10000/judged):0);
  if(judged) {
    const order=counts.map((n,index)=>({index,remainder:n*10000%judged})).sort((a,b)=>b.remainder-a.remainder||a.index-b.index);
    for(let i=0,left=10000-units.reduce((a,b)=>a+b,0);i<left;i++)units[order[i].index]++;
  }
  return {judged,discarded,firstPassed,returned,reassigned:Number(value?.reassigned??0),tasks:Number(value?.tasks??0),
    discardedRate:judged?units[0]/10000:null,firstPassRate:judged?units[1]/10000:null,returnRate:judged?units[2]/10000:null};
}
function annotation(value) {
  const firstPassed=Number(value?.firstPassed??0),passed=Number(value?.passed??0),failed=Number(value?.failed??0),decided=passed+failed;
  return {firstPassed,reworkPassed:passed-firstPassed,passed,failed,decided,
    firstPassRate:decided?firstPassed/decided:0,rate:decided?passed/decided:0,returnRate:decided?failed/decided:0};
}

export function buildSqlOperatorSnapshot(raw, filters, asOf) {
  const groups=new Map(raw.groups.map(row=>[`${row.all_people}:${row.account_id??''}:${row.all_stages}:${row.stage??''}`,row]));
  const current=new Map(raw.current.map(row=>[`${row.all_people}:${row.account_id??''}:${row.all_stages}:${row.stage??''}`,row]));
  const build=(accountId,allPeople)=>{
    const blank=empty(),key=`${allPeople}:${accountId??''}:1:`;
    const group=groups.get(key),summary={...blank,...group?.summary},waiting=current.get(key);
    summary.qualityOutcomes=quality(summary.qualityOutcomes);summary.annotationOverallPass=annotation(summary.annotationOverallPass);
    summary.pending=Number(waiting?.pending??0);summary.waitingQuality=Number(waiting?.waiting_quality??0);summary.longWaiting=Number(waiting?.long_waiting??0);
    summary.qa={...blank.qa,...summary.qa};
    delete summary.qa.pendingRechecks;
    summary.qa.affectedTasks=Number(raw.affected.find(row=>row.all_people===allPeople && row.account_id===accountId)?.total??0);
    summary.reasons=raw.reasons.filter(row=>row.all_people===allPeople && row.account_id===accountId)
      .map(row=>({code:row.code,count:Number(row.total)})).sort((a,b)=>b.count-a.count||a.code.localeCompare(b.code)).slice(0,10);
    for(const stage of ['COPY','IMAGE']) {
      const part=groups.get(`${allPeople}:${accountId??''}:0:${stage}`),value={...blank[stage],...part?.stage_summary};
      value.qualityOutcomes=quality(value.qualityOutcomes);value.annotationOverallPass=annotation(value.annotationOverallPass);
      for(const name of ['firstPass','overallPass','recheck','firstRecheck'])value[name]=rate(value[name]);
      value.coverage={...value.coverage,rate:value.coverage.eligible?value.coverage.sampled/value.coverage.eligible:null};
      summary[stage]=value;
      const stageQa={...blank.qa[stage],...part?.qa_stage};
      summary.qa[stage]=Object.fromEntries(['tasks','reviews','passed','returned','escalated','rechecks','batchImpactReturns','pending','blocked','pendingRechecks'].map(name=>[name,stageQa[name]]));
    }
    return summary;
  };
  const trendByDay=new Map(raw.trend.map(row=>[row.day,row]));
  const trend=[];
  for(let at=filters.range.startMs;at<filters.range.endMs;at+=86400000) {
    const date=new Date(at+8*3600000).toISOString().slice(0,10),row=trendByDay.get(date)??{};
    trend.push({date,qa:Number(row.qa??0),submitted:Number(row.submitted??0),copySubmitted:Number(row.copy_submitted??0),
      imageSubmitted:Number(row.image_submitted??0),copyQa:Number(row.copy_qa??0),imageQa:Number(row.image_qa??0),released:Number(row.released??0),
      COPY:rate({passed:row.copy_passed,failed:row.copy_failed}),IMAGE:rate({passed:row.image_passed,failed:row.image_failed})});
  }
  return {metricVersion:PERFORMANCE_VERSION,timezone:'Asia/Shanghai',asOf,range:{from:filters.range.from,to:filters.range.to},filters,
    summary:build(null,1),people:raw.identities.map(row=>({accountId:Number(row.account_id),username:row.username,displayName:row.display_name,...build(row.account_id,0)})),
    trend,rows:[],dataQuality:{...raw.dataQuality,timingSince:raw.dataQuality.timingSince?new Date(raw.dataQuality.timingSince).toISOString():null,
      historyNotice:'账号通过率按北京时间质检结论日统计实际标注账号的每次有效通过或打回判定；同一内容当天多次有效判定分别计入。整批打回按受影响内容记退回，单次操作不重复计触发项。首检废弃率沿用首次质检日口径。质检操作通过率单独归实际质检账号。缺失历史身份和时间不补造。'}};
}

export async function readSqlOperatorSnapshot(client,filters,asOf,dataCutoff=asOf,options={}) {
  const result=await client.query(operatorReportAggregateSql(options),operatorReportParameters(filters,dataCutoff));
  return {...buildSqlOperatorSnapshot(result.rows[0].report,filters,asOf),dataCutoff};
}

export function operatorMetricPredicate(filters) {
  const metric=filters.metric;
  let condition;
  if(metric.startsWith('qa')) {
    if(filters.sampleSet==='first')return 'false';
    condition={qaAll:'qa_activity AND qa_order=1',qa:'qa_review',qaRecheck:"qa_review AND data->>'sampleKind'='MANDATORY_RECHECK'",
      qaBatch:'qa_batch',qaSpecial:'qa_special',qaPending:"kind='QA_PENDING' AND NOT coalesce(data->>'blocked'='true',false)",
      qaBlocked:"kind='QA_PENDING' AND data->>'blocked'='true'"}[metric];
  } else condition={all:'true',contributed:'submission OR qa_review',submitted:'submission',
    firstSubmitted:"submission AND data->>'firstSubmission'='true'",
    firstPass:"kind='QUALITY' AND valid AND data->>'first'='true' AND data->>'sampleKind'='RANDOM'",
    recheck:"kind='QUALITY' AND valid AND data->>'sampleKind'='MANDATORY_RECHECK'",
    firstRecheck:"kind='QUALITY' AND valid AND data->>'sampleKind'='MANDATORY_RECHECK' AND data->>'firstRecheck'='true'",
    returned:'returned',reworked:"submission AND data->>'rework'='true'",reassign:"kind='REASSIGN'",
    released:"kind='RELEASE' AND valid AND data->>'first'='true'",delivered:"kind='DELIVERY' AND valid",
    batchAffected:"kind='BATCH_RETURN'",excluded:"NOT valid OR kind='EXCLUDED'",pending:"kind='PENDING'",
    judged:"kind='ACCOUNT_QUALITY'",discarded:"kind='ACCOUNT_QUALITY' AND data->>'bucket'='DISCARDED'",
    firstPassed:"kind='ACCOUNT_QUALITY' AND data->>'bucket'='FIRST_PASS'",qualityReturned:"kind='ACCOUNT_QUALITY' AND data->>'bucket'='RETURNED'",
    reassigned:"kind='ACCOUNT_QUALITY' AND data->>'reassigned'='true'",annotationOverall:'annotation_quality'}[metric];
  if(!condition)throw new TypeError('统计指标无效');
  const sample=filters.sampleSet==='all'?'true':filters.sampleSet==='first'
    ? metric==='annotationOverall'?"data->>'firstPassed'='true'":'false'
    :`data->>'outcome'='${filters.sampleSet==='passed'?'PASS':'RETURN'}'`;
  return `(${condition}) AND (${sample})`;
}

function normalizedFact(row) {
  const fact={...row};
  for(const name of ['at','previousSubmittedAt','returnedAt','firstQaAt','outcomeChangedAt']) {
    if(fact[name]!=null && Number.isFinite(Date.parse(fact[name])))fact[name]=new Date(fact[name]).toISOString();
  }
  return fact;
}

export async function readSqlOperatorDetails(client,report,filters,accountId,{currentPage=1,currentPageSize=100,useProjections=true}={}) {
  if(!Number.isSafeInteger(currentPage)||currentPage<1||!Number.isSafeInteger(currentPageSize)||currentPageSize<1||currentPageSize>100) {
    throw new TypeError('当前待办页码无效');
  }
  const parameters=[...operatorReportParameters(report.filters,report.dataCutoff??report.asOf),accountId,filters.stage,filters.page,filters.pageSize,currentPage,currentPageSize];
  const predicate=operatorMetricPredicate(filters);
  // QA review deduplication and unassigned QA pending attribution keep the
  // report scope. Production sources can be restricted before their history
  // and timing joins; ancestry lookups still read the canonical global links.
  const accountParameter=accountId===null?4:9;
  const result=await client.query(`WITH RECURSIVE ${operatorReportFactCtes({accountParameter,useProjections})},
    detail_facts AS MATERIALIZED (SELECT * FROM classified WHERE ($9::bigint IS NULL OR account_id=$9)
      AND ($10::text='' OR stage=$10) AND ${predicate}),
    detail_count AS (SELECT count(*) AS total FROM detail_facts),
    detail_page AS (SELECT least($11::integer,greatest(1,ceil(total::numeric/$12)::integer)) AS page FROM detail_count),
    page_facts AS MATERIALIZED (SELECT * FROM detail_facts ORDER BY date_trunc('milliseconds',occurred_at) DESC,event_key
      LIMIT $12::integer OFFSET (SELECT (page-1)*$12 FROM detail_page)),
    current_detail AS MATERIALIZED (SELECT * FROM selected_current WHERE $9::bigint IS NULL OR account_id=$9),
    current_count AS (SELECT count(*) AS total FROM current_detail),
    current_page AS (SELECT least($13::integer,greatest(1,ceil(total::numeric/$14)::integer)) AS page FROM current_count),
    page_current AS (SELECT * FROM current_detail ORDER BY task_id LIMIT $14::integer OFFSET (SELECT (page-1)*$14 FROM current_page)),
    detail_days AS (SELECT day,count(*) FILTER(WHERE qa_review) AS qa,
      count(DISTINCT task_id) FILTER(WHERE submission) AS submitted,count(DISTINCT task_id) FILTER(WHERE returned) AS returned,
      count(*) FILTER(WHERE first_sample AND stage='COPY' AND data->>'outcome'='PASS') AS copy_passed,
      count(*) FILTER(WHERE first_sample AND stage='COPY' AND data->>'outcome'='RETURN') AS copy_failed,
      count(*) FILTER(WHERE first_sample AND stage='IMAGE' AND data->>'outcome'='PASS') AS image_passed,
      count(*) FILTER(WHERE first_sample AND stage='IMAGE' AND data->>'outcome'='RETURN') AS image_failed
      FROM classified WHERE $9::bigint IS NULL OR account_id=$9 GROUP BY day)
    SELECT jsonb_build_object('total',(SELECT total FROM detail_count),'page',(SELECT page FROM detail_page),
      'items',coalesce((SELECT jsonb_agg(data ORDER BY date_trunc('milliseconds',occurred_at) DESC,event_key) FROM page_facts),'[]'),
      'currentTotal',(SELECT total FROM current_count),'currentPage',(SELECT page FROM current_page),
      'current',coalesce((SELECT jsonb_agg(jsonb_build_object('taskId',task_id,'accountId',account_id,'username',username,
        'displayName',display_name,'stage',stage,'phase',phase,'state',state,'query',query,'batchId',batch_id,'at',waiting_at,
        'assignedAt',assigned_at,'waitingMs',waiting_ms,'lastQuality',last_quality,'reassignSuggested',coalesce(reassign_suggested,false))
        ORDER BY task_id) FROM page_current),'[]'),
      'timeline',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'taskId',task_id,'accountId',account_id,
        'stage',stage,'phase',phase,'state',state,'at',occurred_at,'baseline',baseline) ORDER BY task_id,occurred_at,id)
        FROM operator_stage_events WHERE task_id IN(SELECT task_id FROM page_facts) AND occurred_at<=$3::timestamptz),'[]'),
      'trend',coalesce((SELECT jsonb_agg(to_jsonb(d)) FROM detail_days d),'[]')) AS detail`,parameters);
  const raw=result.rows[0].detail,days=new Map(raw.trend.map(row=>[row.day,row]));
  const trend=report.trend.map(day=>{
    const row=days.get(day.date)??{};
    return {date:day.date,qa:Number(row.qa??0),submitted:Number(row.submitted??0),returned:Number(row.returned??0),
      COPY:rate({passed:row.copy_passed,failed:row.copy_failed}),IMAGE:rate({passed:row.image_passed,failed:row.image_failed})};
  });
  return {items:raw.items.map(normalizedFact),total:Number(raw.total),page:Number(raw.page),pageSize:filters.pageSize,
    trend,current:raw.current.map(row=>({...normalizedFact(row),lastQuality:row.lastQuality?normalizedFact(row.lastQuality):null})),
    currentTotal:Number(raw.currentTotal),currentPage:Number(raw.currentPage),currentPageSize,
    timeline:raw.timeline.map(normalizedFact)};
}
