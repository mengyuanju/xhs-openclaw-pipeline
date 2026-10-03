import { inspectionRoundCtes } from './operator-performance-facts-query.mjs';

export function personalHistoryEventCtes({ start, end, asOf }) {
  return `core_events AS (
    SELECT e.event_key,e.task_id,e.account_id,e.stage,
      CASE WHEN e.kind='SUBMIT' THEN 'COMPLETE' ELSE e.kind END AS kind,e.occurred_at,e.data,
      (SELECT max(r.occurred_at) FROM operator_performance_events r WHERE r.task_id=e.task_id
        AND r.occurred_at<e.occurred_at AND (r.kind IN ('RETURN','BATCH_RETURN') OR r.kind='QUALITY' AND r.data->>'outcome'='RETURN')
        AND coalesce(r.data->>'target',r.stage) IN (e.stage,'BOTH')) AS returned_at
    FROM operator_performance_events e WHERE e.account_id=$1
      AND e.occurred_at>=${start}::timestamptz AND e.occurred_at<${end}::timestamptz
      AND e.kind IN ('SUBMIT','QUALITY','RETURN') AND e.data->>'exclusion' IS NULL
  ), ${inspectionRoundCtes({ asOf })}, history_events AS (
    SELECT * FROM rounded_events
    UNION ALL
    SELECT event_key||':return',task_id,account_id,stage,'RETURN',occurred_at,data,returned_at,
      review_round,return_round,consecutive_returns,round_known,first_recheck,root_item_id
    FROM rounded_events WHERE kind='QUALITY' AND data->>'outcome'='RETURN'
  )`;
}

function eventPredicate(filters, bind) {
  const clauses = [];
  if (filters.stage) clauses.push(`stage=${bind(filters.stage)}`);
  if (filters.mode === 'COMPLETED') clauses.push("kind='COMPLETE'");
  if (filters.mode === 'REWORK') clauses.push("kind='COMPLETE' AND coalesce((data->>'rework')::boolean,false)");
  if (filters.mode === 'RETURNS') clauses.push("kind='RETURN'");
  if (filters.mode === 'QUALITY') {
    clauses.push("kind='QUALITY'");
    if (filters.qualityFirst) clauses.push("data->>'first'='true'");
    if (filters.qualityRecheck) clauses.push('first_recheck');
  }
  return clauses.join(' AND ') || 'true';
}

/** Facts for only historical candidates, including safe placeholders for deleted/blind content. */
export function personalHistoryFactsSql(baseFactsSql, filters, { bind, at, additionalWhere = '' } = {}) {
  const start = bind(new Date(filters.range.startMs).toISOString());
  const end = bind(new Date(filters.range.endMs).toISOString());
  const predicate = eventPredicate(filters, bind);
  const available = baseFactsSql({ unbounded: true, classificationOnly: true, repeated: false,
    historicalCandidateSql: 'SELECT task_id FROM selected_history' });
  const columns = ['current_stage','created_at','queue_entered_at','priority_sort_at','priority_mode',
    'source_query_package_name','mandatory_copy_qc','mandatory_image_qc','mandatory_copy_qc_origin','revision_origin',
    'is_created','is_assigned','has_access','rework_target','rework_source','returned_at','return_note','return_reasons',
    'rework_rounds','plan_status','plan_ready_at','queued','running','ready','failed','preview_ready_at','delivery_ready'];
  return `WITH RECURSIVE ${personalHistoryEventCtes({ start, end, asOf: at })},
    selected_history AS (
      SELECT task_id,max(occurred_at) AS newest_event_at,
        coalesce(bool_or(kind='RETURN' AND return_round>=2),false) AS history_repeated
      FROM history_events WHERE ${predicate} GROUP BY task_id
    ), available AS (${available})
    SELECT task.* FROM (
      SELECT h.task_id AS id,coalesce(f.query,'历史内容 #'||h.task_id) AS query,
        coalesce(f.state,'HISTORY_ONLY') AS state,${columns.map(column => `f.${column}`).join(',')},
        h.newest_event_at,h.history_repeated
      FROM selected_history h LEFT JOIN available f ON f.id=h.task_id
    ) task WHERE true ${additionalWhere}`;
}

export async function readPersonalHistoryPageEvents(client, actor, filters, taskIds, now) {
  if (!taskIds.length) return [];
  const values = [actor.userId,new Date(filters.range.startMs).toISOString(),new Date(filters.range.endMs).toISOString(),
    new Date(now).toISOString(),taskIds];
  const predicate = eventPredicate(filters, value => { values.push(value); return `$${values.length}`; });
  const rows = (await client.query(`WITH RECURSIVE ${personalHistoryEventCtes({ start: '$2', end: '$3', asOf: '$4' })}
    SELECT * FROM history_events WHERE task_id=ANY($5::bigint[]) AND ${predicate}
    ORDER BY occurred_at,event_key`, values)).rows;
  return rows.map(row => ({ accountId: actor.userId,id:row.event_key,taskId:Number(row.task_id),kind:row.kind,stage:row.stage,
    at:row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
    samplingItemId:row.data?.samplingItemId,sampleKind:row.data?.sampleKind,approvalId:row.data?.approvalId,
    firstSubmission:row.data?.firstSubmission,firstRecheck:row.first_recheck,outcome:row.data?.outcome,
    rework:row.data?.rework===true,returnedAt:row.returned_at instanceof Date ? row.returned_at.toISOString() : row.returned_at,
    passed:row.data?.outcome==='PASS',first:row.data?.first===true,reasons:row.data?.reasons??[],
    round:row.return_round==null ? null : Number(row.return_round),
    reviewRound:row.review_round==null ? null : Number(row.review_round),
    consecutiveReturns:Number(row.consecutive_returns??0),
    rootItemId:row.root_item_id==null ? null : Number(row.root_item_id),
    returnRound:row.return_round==null ? null : Number(row.return_round),roundKnown:row.round_known,
  }));
}
