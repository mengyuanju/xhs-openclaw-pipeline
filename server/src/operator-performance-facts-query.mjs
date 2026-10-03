function identifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new TypeError('事实查询关系名无效');
  return value;
}

/**
 * Append to WITH RECURSIVE. Source fields: event_key, task_id, stage, kind,
 * occurred_at, data (jsonb). Output keeps those fields and adds round columns.
 * Date-bounded seeds follow ancestry outside the selected period, up to the
 * same 100-link/cycle boundary as inspectionContexts in src/quality-rounds.mjs.
 */
export function inspectionRoundCtes({ source = 'core_events', output = 'rounded_events', asOf = '$3', prefix = 'inspection' } = {}) {
  identifier(source); identifier(output); identifier(prefix);
  if (!/^\$[1-9][0-9]*$/u.test(asOf)) throw new TypeError('事实截止时间参数无效');
  const selected = `${prefix}_selected`, chain = `${prefix}_chain`, ranked = `${prefix}_ranked`, contexts = `${prefix}_contexts`;
  const safeId = field => `CASE WHEN e.data->>'${field}' ~ '^[1-9][0-9]{0,15}$' THEN (e.data->>'${field}')::bigint END`;
  return `${selected} AS (
    SELECT e.event_key,e.stage,e.task_id,link.item_id
    FROM ${source} e
    JOIN LATERAL (
      SELECT l.item_id FROM quality_inspection_links l
      WHERE l.stage=e.stage AND l.task_id=e.task_id AND l.created_at<=${asOf}::timestamptz
        AND (l.item_id=${safeId('samplingItemId')}
          OR ${safeId('samplingItemId')} IS NULL AND e.kind='SUBMIT' AND l.approval_id=${safeId('approvalId')})
      ORDER BY l.item_id DESC LIMIT 1
    ) link ON true
  ), ${chain} AS (
    SELECT s.event_key,l.stage,l.task_id,l.item_id,l.parent_item_id,l.sample_kind,l.submitter_id,
      verdict.data->>'outcome' AS outcome,verdict.data->>'exclusion' AS exclusion,
      l.submitter_id AS current_submitter_id,ARRAY[l.item_id]::bigint[] AS visited,1 AS depth
    FROM ${selected} s JOIN quality_inspection_links l ON l.stage=s.stage AND l.item_id=s.item_id
    LEFT JOIN operator_performance_events verdict ON verdict.event_key=lower(l.stage)||'-qa:'||l.item_id
      AND verdict.occurred_at<=${asOf}::timestamptz
    UNION ALL
    SELECT c.event_key,l.stage,l.task_id,l.item_id,l.parent_item_id,l.sample_kind,l.submitter_id,
      verdict.data->>'outcome',verdict.data->>'exclusion',c.current_submitter_id,c.visited||l.item_id,c.depth+1
    FROM ${chain} c JOIN quality_inspection_links l ON l.stage=c.stage AND l.item_id=c.parent_item_id
      AND l.task_id=c.task_id AND l.created_at<=${asOf}::timestamptz
    LEFT JOIN operator_performance_events verdict ON verdict.event_key=lower(l.stage)||'-qa:'||l.item_id
      AND verdict.occurred_at<=${asOf}::timestamptz
    WHERE c.sample_kind='MANDATORY_RECHECK' AND c.depth<100 AND NOT l.item_id=ANY(c.visited)
      AND NOT (c.sample_kind='RANDOM' AND c.parent_item_id IS NULL)
  ), ${ranked} AS (
    SELECT c.*, bool_and(coalesce(submitter_id IS NOT NULL AND submitter_id=current_submitter_id
      AND coalesce(exclusion,'')='' AND outcome='RETURN',false)) OVER(PARTITION BY event_key ORDER BY depth) AS consecutive_return
    FROM ${chain} c
  ), ${contexts} AS (
    SELECT event_key,
      bool_or(sample_kind='RANDOM' AND parent_item_id IS NULL) AS round_known,
      CASE WHEN bool_or(sample_kind='RANDOM' AND parent_item_id IS NULL) THEN max(depth) END AS review_round,
      CASE WHEN bool_or(sample_kind='RANDOM' AND parent_item_id IS NULL) THEN
        count(*) FILTER(WHERE submitter_id IS NOT NULL AND coalesce(exclusion,'')='' AND outcome='RETURN') END AS return_round,
      CASE WHEN bool_or(sample_kind='RANDOM' AND parent_item_id IS NULL) THEN count(*) FILTER(WHERE consecutive_return) ELSE 0 END AS consecutive_returns,
      max(depth)=2 AND bool_or(sample_kind='RANDOM' AND parent_item_id IS NULL AND submitter_id IS NOT NULL
        AND coalesce(exclusion,'')='' AND outcome='RETURN') AS first_recheck,
      max(item_id) FILTER(WHERE sample_kind='RANDOM' AND parent_item_id IS NULL) AS root_item_id
    FROM ${ranked} GROUP BY event_key
  ), ${output} AS (
    SELECT e.*,c.review_round,c.return_round,coalesce(c.consecutive_returns,0) AS consecutive_returns,
      coalesce(c.round_known,false) AS round_known,coalesce(c.first_recheck,e.data->>'firstRecheck'='true',false) AS first_recheck,c.root_item_id
    FROM ${source} e LEFT JOIN ${contexts} c USING(event_key)
  )`;
}
