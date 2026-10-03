// Full canonical account-quality source relations, preserving legacy and v2 duplicate rules.

export const ACCOUNT_RECORDS_SOURCE_SQL=`SELECT r.*,EXISTS(SELECT 1 FROM tasks WHERE id=r.task_id) AS task_exists,
      u.username AS current_username,u.display_name AS current_display_name
    FROM account_quality_records r LEFT JOIN app_users u ON u.id=r.operator_account_id
    WHERE r.first_qa_at >= $1 AND r.first_qa_at < $2
      AND ($3::bigint IS NULL OR r.operator_account_id=$3) AND ($4::text='' OR r.stage=$4)
      AND ($5::bigint IS NULL OR (r.data->>'batchId')::bigint=$5)
    ORDER BY r.first_qa_at,r.id`;

export const ANNOTATION_VERDICTS_SOURCE_SQL=`WITH decisions AS (
      SELECT e.*,to_char(e.occurred_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS verdict_day
      FROM account_quality_events e
      WHERE e.action IN ('PASS','RETURN') AND e.occurred_at >= $1 AND e.occurred_at < $2
        AND ($3::bigint IS NULL OR e.account_id=$3) AND ($4::text='' OR e.stage=$4)
        AND ($5::bigint IS NULL OR (e.data->>'batchId')::bigint=$5)
        AND NOT (COALESCE(e.data->>'source'='BATCH_RETURN',false) AND EXISTS (
          SELECT 1 FROM account_quality_events individual
          WHERE individual.task_id=e.task_id AND individual.stage=e.stage
            AND individual.account_id=e.account_id AND individual.action='RETURN'
            AND individual.data->>'source' IS DISTINCT FROM 'BATCH_RETURN'
            AND date_trunc('milliseconds',individual.occurred_at)=date_trunc('milliseconds',e.occurred_at)
            AND individual.data->>'samplingItemId'=COALESCE(e.data->>'samplingItemId',
              substring(e.event_key from '[0-9]+$'))))
        AND NOT (COALESCE(e.data->>'source'='BATCH_RETURN',false) AND EXISTS (
          SELECT 1 FROM account_quality_events duplicate
          WHERE duplicate.task_id=e.task_id AND duplicate.stage=e.stage
            AND duplicate.account_id=e.account_id AND duplicate.action='RETURN'
            AND duplicate.data->>'source'='BATCH_RETURN'
            AND date_trunc('milliseconds',duplicate.occurred_at)=date_trunc('milliseconds',e.occurred_at)
            AND duplicate.sequence_id<e.sequence_id
            AND COALESCE('item:'||(duplicate.data->>'samplingItemId'),
              'item:'||substring(duplicate.event_key from '[0-9]+$'),
              'freeze:'||(duplicate.data->>'freezeId'),'batch:'||(duplicate.data->>'batchId'))
              =COALESCE('item:'||(e.data->>'samplingItemId'),
                'item:'||substring(e.event_key from '[0-9]+$'),
                'freeze:'||(e.data->>'freezeId'),'batch:'||(e.data->>'batchId'))))
      ORDER BY e.occurred_at,e.sequence_id
    ) SELECT decisions.*,r.first_qa_at,r.outcome_changed_at,r.outcome_version,r.reassigned,
        r.data AS record_data,u.username AS current_username,u.display_name AS current_display_name,
        t.query AS current_query,t.production_batch_id, (t.id IS NOT NULL) AS task_exists,
        EXISTS (SELECT 1 FROM account_quality_events previous
          WHERE previous.task_id=decisions.task_id AND previous.stage=decisions.stage
            AND previous.account_id=decisions.account_id AND previous.action='RETURN'
            AND (previous.occurred_at,previous.sequence_id)<(decisions.occurred_at,decisions.sequence_id)) AS had_return,
        (COALESCE(decisions.data->>'source'='BATCH_RETURN',false) OR decisions.action='RETURN' AND EXISTS (
          SELECT 1 FROM account_quality_events batch
          WHERE batch.task_id=decisions.task_id AND batch.stage=decisions.stage
            AND batch.account_id=decisions.account_id AND batch.action='RETURN'
            AND batch.data->>'source'='BATCH_RETURN'
            AND date_trunc('milliseconds',batch.occurred_at)=date_trunc('milliseconds',decisions.occurred_at)
            AND COALESCE(batch.data->>'samplingItemId',substring(batch.event_key from '[0-9]+$'))
              =decisions.data->>'samplingItemId')) AS from_batch
      FROM decisions LEFT JOIN account_quality_records r ON r.task_id=decisions.task_id AND r.stage=decisions.stage
        AND r.operator_account_id=decisions.account_id
      LEFT JOIN app_users u ON u.id=decisions.account_id LEFT JOIN tasks t ON t.id=decisions.task_id
      ORDER BY decisions.occurred_at,decisions.sequence_id`;

export const UNKNOWN_BATCH_SOURCE_SQL=`SELECT batch.event_key,batch.stage,batch.occurred_at,batch.data,
      count(DISTINCT COALESCE('item:'||(member.data->>'samplingItemId'),
        'item:'||substring(member.event_key from '[0-9]+$'),
        'task:'||member.task_id::text||':'||member.account_id::text))
        FILTER (WHERE member.data->>'batchTrigger'='false')::int AS known_count
    FROM quality_review_activity_events batch LEFT JOIN account_quality_events member
      ON member.stage=batch.stage AND member.data->>'source'='BATCH_RETURN'
      AND (member.data->>'freezeId'=batch.data->>'freezeId'
        OR (member.data->>'freezeId' IS NULL
          AND date_trunc('milliseconds',member.occurred_at)=date_trunc('milliseconds',batch.occurred_at)
          AND member.data->>'batchId'=batch.data->>'batchId'))
    WHERE batch.kind='QA_BATCH_RETURN' AND batch.occurred_at >= $1 AND batch.occurred_at < $2
      AND ($3::text='' OR batch.stage=$3)
      AND ($4::bigint IS NULL OR (batch.data->>'batchId')::bigint=$4)
    GROUP BY batch.event_key,batch.stage,batch.occurred_at,batch.data
    ORDER BY batch.occurred_at,batch.event_key`;
