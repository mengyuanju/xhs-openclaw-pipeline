import { ANNOTATION_VERDICTS_SOURCE_SQL } from './operator-performance-account-sources.mjs';
import { DISCARDS_SQL } from './annotation-discard-facts.mjs';
import { PERSONAL_QA_COVERAGE_SQL, PERSONAL_LEGACY_COPY_IMPACTS_SQL, PERSONAL_UNATTRIBUTED_RELEASES_SQL } from './personal-qa-coverage.mjs';

const unlimited = sql => sql.replace(/\s+LIMIT\s+50001\s*$/iu, '');
const remap = (sql, mapping) => sql.replace(/\$(\d+)\b/gu, (_, n) => mapping[Number(n)]);
const positive = value => `(CASE WHEN ${value} ~ '^[+]?[0-9]+([.]0+)?$' THEN
  CASE WHEN (${value})::numeric BETWEEN 1 AND 9007199254740991 THEN (${value})::numeric::bigint END END)`;
const itemKey = alias => `CASE
  WHEN jsonb_typeof(${alias}.data->'reviewItemKey')='string' AND ${alias}.data->>'reviewItemKey'<>''
    THEN ${alias}.data->>'reviewItemKey'
  WHEN ${alias}.stage='COPY' AND (${positive(`${alias}.data->>'qaBatchId'`)} IS NOT NULL OR ${alias}.id LIKE 'copy-v2:%')
    AND ${positive(`${alias}.data->>'samplingItemId'`)} IS NOT NULL
    THEN 'COPY:v2:'||${positive(`${alias}.data->>'samplingItemId'`)}::text
  WHEN ${positive(`${alias}.data->>'freezeId'`)} IS NOT NULL AND ${alias}.task_id>0
    THEN ${alias}.stage||':legacy:'||${positive(`${alias}.data->>'freezeId'`)}::text||':'||${alias}.task_id::text
  WHEN ${positive(`${alias}.data->>'samplingItemId'`)} IS NOT NULL
    THEN ${alias}.stage||':legacy:item:'||${positive(`${alias}.data->>'samplingItemId'`)}::text
  ELSE ${alias}.stage||':event:'||${alias}.id END`;

export function personalStatisticsParameters(actor, range, now = Date.now(), stage = '') {
  return [actor.userId, new Date(range.startMs).toISOString(), new Date(range.endMs).toISOString(),
    new Date(now).toISOString(), stage];
}

export function personalSubmissionCtes() {
  return `personal_submissions AS (
    SELECT e.event_key AS id,e.task_id,e.stage,e.occurred_at AS at,
      NOT EXISTS (SELECT 1 FROM operator_performance_events previous
        WHERE previous.task_id=e.task_id AND previous.stage=e.stage AND previous.kind='SUBMIT'
          AND previous.data->>'exclusion' IS NULL
          AND (previous.occurred_at,previous.sequence_id)<(e.occurred_at,e.sequence_id)) AS first_submission,
      e.data->>'rework'='true' AS rework
    FROM operator_performance_events e WHERE e.account_id=$1 AND e.occurred_at>=$2 AND e.occurred_at<$3
      AND e.kind='SUBMIT' AND e.data->>'exclusion' IS NULL AND ($5::text='' OR e.stage=$5))`;
}

export function personalAnnotationCtes() {
  return `personal_verdicts AS (${remap(ANNOTATION_VERDICTS_SOURCE_SQL,
    { 1:'$2',2:'$3',3:'$1',4:'$5',5:'NULL::bigint' })}),
    personal_annotation AS (SELECT 'annotation-quality:'||event_key AS id,task_id,stage,occurred_at AS at,
      'ANNOTATION_QUALITY'::text AS kind,action AS outcome,
      COALESCE(data->>'sampleKind',record_data->>'sampleKind') AS sample_kind,
      action='PASS' AND NOT had_return AND COALESCE(data->>'sampleKind',record_data->>'sampleKind','')<>'MANDATORY_RECHECK'
        AS first_passed
    FROM personal_verdicts WHERE data->>'exclusion' IS NULL AND account_id>0)`;
}

export function personalDiscardCtes() {
  return `personal_discards AS (${remap(unlimited(DISCARDS_SQL),
    { 1:'$2',2:'$3',3:'$4',4:'$1',5:"'COPY'::text",6:'NULL::bigint',7:'NULL::bigint[]' })})`;
}

// The personal QA card counts manual items and member coverage separately.
// All merges happen in PostgreSQL; a batch may cover millions of members without
// transferring those members to the web process. Member-ledger exclusions still
// suppress legacy batch scopes, just as the existing JS oracle does.
export function personalQaCtes() {
  return `personal_qa_raw AS MATERIALIZED (
    SELECT e.event_key AS id,e.task_id,e.stage,e.kind,e.occurred_at AS at,
      e.data||jsonb_build_object('sampleKind',CASE WHEN e.data->>'sampleKind' IS NOT NULL THEN e.data->>'sampleKind'
        WHEN e.kind='QA_REVIEW' THEN CASE WHEN EXISTS (SELECT 1 FROM account_quality_events previous
          WHERE previous.task_id=e.task_id AND previous.stage=e.stage AND previous.event_key<>e.event_key
            AND previous.action IN ('PASS','RETURN') AND previous.data->>'exclusion' IS NULL
            AND previous.occurred_at<e.occurred_at) THEN 'MANDATORY_RECHECK' ELSE 'RANDOM' END END) AS data
    FROM quality_review_activity_events e WHERE e.account_id=$1 AND e.occurred_at>=$2 AND e.occurred_at<$3
      AND ($5::text='' OR e.stage=$5)),
  personal_coverage_current AS (${unlimited(PERSONAL_QA_COVERAGE_SQL)}),
  personal_coverage_legacy AS (${unlimited(PERSONAL_LEGACY_COPY_IMPACTS_SQL)}),
  personal_coverage_missing AS (${PERSONAL_UNATTRIBUTED_RELEASES_SQL}),
  personal_coverage AS MATERIALIZED (
    SELECT event_key AS id,task_id,stage,kind,occurred_at AS at,1 AS source_order,
      data||jsonb_build_object('reviewItemKey',review_item_key,'operationKey',operation_key,
        'outcome',CASE WHEN kind='BATCH_RELEASE' THEN 'RELEASE' ELSE 'RETURN' END) AS data
    FROM personal_coverage_current
    UNION ALL SELECT 'legacy-coverage:'||event_key,task_id,stage,'BATCH_RETURN',occurred_at,2,
      data||jsonb_build_object('reviewItemKey','COPY:v2:'||COALESCE(data->>'samplingItemId','undefined'),
        'operationKey','COPY:v2:'||COALESCE(data->>'qaBatchId','undefined')||':BATCH_RETURN','outcome','RETURN')
    FROM personal_coverage_legacy),
  personal_direct AS MATERIALIZED (
    SELECT q.*,${itemKey('q')} AS item_key,'DIRECT'::text AS source,0 AS source_order
    FROM personal_qa_raw q WHERE q.data->>'exclusion' IS NULL AND
      (q.kind='QA_REVIEW' AND q.data->>'outcome' IN ('PASS','RETURN')
        OR q.kind='QA_ESCALATE' AND q.data->>'outcome'='ESCALATE' OR q.kind='QA_DISCARD')),
  personal_qa_review_events AS (
    SELECT DISTINCT ON (CASE WHEN q.kind='QA_REVIEW' THEN q.stage||':'||
      CASE WHEN q.stage='COPY' AND q.data->'qaBatchId' IS NOT NULL AND q.data->'qaBatchId'<>'null'::jsonb
        THEN 'copy-v2' ELSE 'legacy' END||':'||COALESCE(q.data->>'samplingItemId',q.id) ELSE q.id END) q.*
    FROM personal_qa_raw q WHERE q.kind IN ('QA_REVIEW','QA_ESCALATE') AND q.data->>'exclusion' IS NULL
      AND q.data->>'outcome' IN ('PASS','RETURN','ESCALATE')
    ORDER BY CASE WHEN q.kind='QA_REVIEW' THEN q.stage||':'||
      CASE WHEN q.stage='COPY' AND q.data->'qaBatchId' IS NOT NULL AND q.data->'qaBatchId'<>'null'::jsonb
        THEN 'copy-v2' ELSE 'legacy' END||':'||COALESCE(q.data->>'samplingItemId',q.id) ELSE q.id END,q.at,q.id),
  personal_batch AS MATERIALIZED (
    SELECT q.*,COALESCE(q.data->>'operationKey',CASE WHEN q.stage='COPY' AND ${positive("q.data->>'qaBatchId'")} IS NOT NULL
      THEN 'COPY:v2:'||${positive("q.data->>'qaBatchId'")}::text||':BATCH_RETURN'
      ELSE q.stage||':legacy:return:'||COALESCE(q.data->>'sourceEventId',q.id) END) AS operation_key,
      CASE WHEN jsonb_typeof(q.data->'affectedTaskIds')='array' AND ${positive("q.data->>'freezeId'")} IS NOT NULL
        THEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(q.data->'affectedTaskIds') member
          WHERE ${positive("member #>> '{}' ")} IS NULL) ELSE false END AS members_known
    FROM personal_qa_raw q WHERE q.kind='QA_BATCH_RETURN' AND q.data->>'exclusion' IS NULL
      AND NOT EXISTS (SELECT 1 FROM personal_coverage captured WHERE captured.kind='BATCH_RETURN'
        AND captured.stage=q.stage AND captured.data->>'sourceEventId'=q.data->>'sourceEventId')),
  personal_batch_fallback AS MATERIALIZED (
    SELECT b.* FROM personal_batch b WHERE NOT EXISTS (SELECT 1 FROM personal_coverage captured
      WHERE captured.kind='BATCH_RETURN' AND captured.data->>'operationKey'=b.operation_key)),
  personal_qa_sources AS (
    SELECT id,task_id,stage,kind,at,data,item_key,source,source_order FROM personal_direct
    UNION ALL SELECT c.id,c.task_id,c.stage,c.kind,c.at,c.data,${itemKey('c')},c.kind,c.source_order
    FROM personal_coverage c WHERE c.data->>'exclusion' IS NULL AND c.kind IN ('BATCH_RETURN','BATCH_RELEASE')
      AND ($5::text='' OR c.stage=$5)
    UNION ALL SELECT b.id,member.task_id,b.stage,b.kind,b.at,b.data||jsonb_build_object('outcome','RETURN'),
      b.stage||':legacy:'||${positive("b.data->>'freezeId'")}::text||':'||member.task_id::text,'BATCH_RETURN',3
    FROM personal_batch_fallback b CROSS JOIN LATERAL (SELECT DISTINCT ${positive("value #>> '{}' ")} AS task_id
      FROM jsonb_array_elements(CASE WHEN b.members_known THEN b.data->'affectedTaskIds' ELSE '[]'::jsonb END)) member),
  personal_actual_newest AS (SELECT DISTINCT ON(stage,item_key) * FROM personal_direct ORDER BY stage,item_key,at DESC,id),
  personal_covered_newest AS (SELECT DISTINCT ON(stage,item_key) * FROM personal_qa_sources
    ORDER BY stage,item_key,at DESC,source_order,id),
  personal_item_flags AS (
    SELECT stage,item_key,bool_or(source='DIRECT') AS actual,bool_or(source='BATCH_RETURN') AS batch_returned,
      bool_or(source='BATCH_RELEASE') AS batch_released,
      bool_or(source='DIRECT' AND data->>'outcome'='PASS') AS passed,
      bool_or(source='DIRECT' AND data->>'outcome'='RETURN') AS returned,
      bool_or(source='DIRECT' AND kind='QA_DISCARD') AS discarded,
      bool_or(source='DIRECT' AND kind='QA_ESCALATE') AS escalated
    FROM personal_qa_sources GROUP BY stage,item_key),
  personal_qa_items AS (SELECT n.*,f.actual,f.batch_returned,f.batch_released,f.passed,f.returned,f.discarded,f.escalated,
      a.data->>'sampleKind' AS actual_sample_kind
    FROM personal_covered_newest n JOIN personal_item_flags f USING(stage,item_key)
    LEFT JOIN personal_actual_newest a USING(stage,item_key)),
  personal_qa_operations AS (
    SELECT stage,COALESCE(data->>'operationKey',id) AS operation_key FROM personal_coverage
      WHERE kind IN ('BATCH_RETURN','BATCH_RELEASE') AND data->>'exclusion' IS NULL AND ($5::text='' OR stage=$5)
    UNION SELECT stage,operation_key FROM personal_batch),
  personal_qa_incomplete AS (
    SELECT stage FROM personal_coverage_missing
    UNION SELECT stage FROM personal_batch_fallback b WHERE
      NOT members_known AND b.data->'affectedCount' IS DISTINCT FROM '0'::jsonb
      OR members_known AND jsonb_typeof(b.data->'affectedCount')='number'
        AND b.data->>'affectedCount' ~ '^[0-9]+$' AND (b.data->>'affectedCount')::numeric<=9007199254740991
        AND (b.data->>'affectedCount')::numeric<>(SELECT count(DISTINCT value) FROM jsonb_array_elements(b.data->'affectedTaskIds')))`;
}

export async function readPersonalPeriodSummary(client, actor, range, now = Date.now()) {
  const values = personalStatisticsParameters(actor, range, now);
  const sql = `WITH ${personalSubmissionCtes()},${personalAnnotationCtes()},${personalDiscardCtes()},${personalQaCtes()}
    SELECT stage,
      (SELECT count(*) FROM personal_submissions s WHERE s.stage=stages.stage) AS submissions,
      (SELECT count(*) FROM personal_submissions s WHERE s.stage=stages.stage AND s.first_submission AND NOT COALESCE(s.rework,false)) AS first_submissions,
      (SELECT count(*) FROM personal_submissions s WHERE s.stage=stages.stage AND s.rework) AS rework_submissions,
      (SELECT count(*) FROM personal_discards WHERE stage='COPY' AND stages.stage='COPY') AS annotation_discarded,
      (SELECT count(*) FROM personal_annotation a WHERE a.stage=stages.stage) AS decided,
      (SELECT count(*) FROM personal_annotation a WHERE a.stage=stages.stage AND a.outcome='PASS') AS annotation_passed,
      (SELECT count(*) FROM personal_annotation a WHERE a.stage=stages.stage AND a.first_passed) AS first_passed,
      (SELECT count(*) FROM personal_qa_review_events r WHERE r.stage=stages.stage) AS reviews,
      (SELECT count(*) FROM personal_qa_items q WHERE q.stage=stages.stage AND q.actual) AS actual_operations,
      (SELECT count(*) FROM personal_qa_items q WHERE q.stage=stages.stage) AS processing_coverage,
      (SELECT count(*) FROM personal_qa_items q WHERE q.stage=stages.stage AND q.actual AND q.actual_sample_kind IS DISTINCT FROM 'MANDATORY_RECHECK') AS qa_first,
      (SELECT count(*) FROM personal_qa_items q WHERE q.stage=stages.stage AND q.actual AND q.actual_sample_kind='MANDATORY_RECHECK') AS rechecks,
      (SELECT count(*) FROM personal_qa_items q WHERE q.stage=stages.stage AND q.passed) AS passed,
      (SELECT count(*) FROM personal_qa_items q WHERE q.stage=stages.stage AND q.returned) AS returned,
      (SELECT count(*) FROM personal_qa_items q WHERE q.stage=stages.stage AND q.batch_returned) AS batch_returned,
      (SELECT count(*) FROM personal_qa_items q WHERE q.stage=stages.stage AND q.batch_released) AS batch_released,
      (SELECT count(*) FROM personal_qa_items q WHERE q.stage=stages.stage AND q.discarded) AS discarded,
      (SELECT count(*) FROM personal_qa_items q WHERE q.stage=stages.stage AND q.escalated) AS escalated,
      (SELECT count(DISTINCT operation_key) FROM personal_qa_operations o WHERE o.stage=stages.stage) AS batch_actions,
      EXISTS(SELECT 1 FROM personal_qa_incomplete i WHERE i.stage=stages.stage) AS coverage_incomplete
    FROM (VALUES ('COPY'::text),('IMAGE')) stages(stage)`;
  const rows = (await client.query(sql, values)).rows;
  const annotation = {}, qa = {};
  for (const row of rows) {
    const number = key => Number(row[key] ?? 0), decided = number('decided'), passed = number('annotation_passed'), first = number('first_passed');
    annotation[row.stage] = { firstReviews:number('first_submissions')+number('annotation_discarded'),
      discarded:number('annotation_discarded'),firstSubmissions:number('first_submissions'),
      reworkSubmissions:number('rework_submissions'),submissions:number('submissions'),
      quality:{firstPassed:first,passed,decided,firstPassRate:decided ? first/decided : null,rate:decided ? passed/decided : null} };
    qa[row.stage] = { firstReviews:number('qa_first'),rechecks:number('rechecks'),passed:number('passed'),returned:number('returned'),
      reviews:number('reviews'),actualOperations:number('actual_operations'),processingCoverage:number('processing_coverage'),
      batchReturned:number('batch_returned'),batchReleased:number('batch_released'),batchActions:number('batch_actions'),
      discarded:number('discarded'),escalated:number('escalated'),coverageIncomplete:row.coverage_incomplete===true };
  }
  return {section:'personal',updatedAt:new Date(now).toISOString(),timezone:'Asia/Shanghai',
    range:{from:range.from,to:range.to},annotation,qa,notices:[]};
}

export async function readPersonalPassTotals(client,actor,range) {
  const rows = (await client.query(`WITH personal_parameters AS (SELECT $4::timestamptz AS as_of),${personalAnnotationCtes()}
    SELECT stage,count(*) FILTER(WHERE outcome='PASS') AS passed FROM personal_annotation GROUP BY stage`,
  personalStatisticsParameters(actor,range))).rows;
  return Object.fromEntries(['COPY','IMAGE'].map(stage => [stage,Number(rows.find(row=>row.stage===stage)?.passed??0)]));
}

export function personalReceiptQuery(metric, sampleSet = '') {
  let ctes, source;
  if (metric.startsWith('submit') || ['copyFirstReview','annotationDiscarded'].includes(metric)) {
    ctes = personalSubmissionCtes()+','+personalDiscardCtes();
    const submitted = `SELECT id,task_id,stage,at,'SUBMIT'::text AS kind,NULL::text AS outcome,NULL::text AS sample_kind,
      CASE WHEN rework THEN 'REWORK' WHEN first_submission THEN 'FIRST' ELSE 'REPEAT' END AS submission_type,false AS first_passed,
      NULL::jsonb AS coverage_sources,NULL::jsonb AS manual_kinds FROM personal_submissions WHERE ${
      metric==='copyFirstReview' ? "stage='COPY' AND first_submission AND NOT COALESCE(rework,false)" :
      metric==='submitFirst' ? 'first_submission AND NOT COALESCE(rework,false)' : metric==='submitRework' ? 'rework' : 'true'}`;
    const discarded = `SELECT 'annotation-discard:'||event_key,task_id,stage,occurred_at,'ANNOTATION_DISCARD','DISCARD',NULL::text,NULL::text,false,NULL::jsonb,NULL::jsonb FROM personal_discards`;
    source = metric==='annotationDiscarded' ? discarded : metric==='copyFirstReview' ? `${submitted} UNION ALL ${discarded}` : submitted;
  } else if (metric==='annotationOverall') {
    ctes = personalAnnotationCtes();
    source = `SELECT id,task_id,stage,at,kind,outcome,sample_kind,NULL::text AS submission_type,first_passed,
      NULL::jsonb AS coverage_sources,NULL::jsonb AS manual_kinds FROM personal_annotation WHERE ${
      sampleSet==='first'?'first_passed':sampleSet==='passed'?"outcome='PASS'":sampleSet==='failed'?"outcome='RETURN'":'true'}`;
  } else {
    ctes = personalQaCtes();
    const condition = {qaCoverage:'true',qaBatchReturned:'q.batch_returned',qaBatchReleased:'q.batch_released',
      qaDiscarded:'q.discarded',qaEscalated:'q.escalated',qaFirst:"q.actual AND q.actual_sample_kind IS DISTINCT FROM 'MANDATORY_RECHECK'",
      qaRecheck:"q.actual AND q.actual_sample_kind='MANDATORY_RECHECK'",qaPassed:'q.passed',qaReturned:'q.returned'}[metric] ?? 'q.actual';
    const useActual = !['qaCoverage','qaBatchReturned','qaBatchReleased'].includes(metric);
    source = `SELECT 'personal-qa:'||q.item_key AS id,q.task_id,q.stage,${useActual?'a.at':'q.at'} AS at,
      ${useActual?'a.kind':'q.kind'} AS kind,${useActual?'a.data':'q.data'}->>'outcome' AS outcome,
      ${useActual?'a.data':'q.data'}->>'sampleKind' AS sample_kind,NULL::text AS submission_type,false AS first_passed,
      ${useActual ? `'["DIRECT"]'::jsonb` : `(SELECT jsonb_agg(source ORDER BY ordinal) FROM (VALUES ('DIRECT',1,q.actual),('BATCH_RETURN',2,q.batch_returned),
        ('BATCH_RELEASE',3,q.batch_released)) sources(source,ordinal,included) WHERE included)`} AS coverage_sources,
      (SELECT jsonb_agg(kind ORDER BY at,id) FROM (SELECT DISTINCT ON(kind) kind,at,id FROM personal_direct d
        WHERE d.stage=q.stage AND d.item_key=q.item_key ORDER BY kind,at,id) kinds) AS manual_kinds
    FROM personal_qa_items q LEFT JOIN personal_actual_newest a USING(stage,item_key) WHERE ${condition}`;
  }
  return { ctes, source };
}

export async function readPersonalReceipts(client,actor,filters,metric,sampleSet='',now=Date.now()) {
  const {ctes,source} = personalReceiptQuery(metric,sampleSet), values=personalStatisticsParameters(actor,filters.range,now,filters.stage);
  const label = `${metric}:${sampleSet}`.replace(/[^a-zA-Z:]/gu,'');
  const prefix = `/* personal_receipts:${label} */ WITH personal_parameters AS (SELECT $4::timestamptz AS as_of),${ctes},personal_receipts AS (${source})`;
  const needsCoverage=['qaCoverage','qaBatchReturned','qaBatchReleased'].includes(metric);
  const count = (await client.query(`${prefix} SELECT count(*) AS total,${needsCoverage
    ? "EXISTS(SELECT 1 FROM personal_qa_incomplete WHERE $5::text='' OR stage=$5)" : 'false'} AS coverage_incomplete FROM personal_receipts`,values)).rows[0];
  const total=Number(count.total),page=Math.min(filters.page,Math.max(1,Math.ceil(total/filters.pageSize)));
  const rows=total ? (await client.query(`${prefix} SELECT * FROM personal_receipts ORDER BY at DESC,id COLLATE "en-US-x-icu" ASC LIMIT $6 OFFSET $7`,
    [...values,filters.pageSize,(page-1)*filters.pageSize])).rows : [];
  return {total,page,pageSize:filters.pageSize,coverageIncomplete:count.coverage_incomplete===true,rows};
}
