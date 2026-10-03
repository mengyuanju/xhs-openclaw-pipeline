// Page IDs and the full filtered counters share one PostgreSQL snapshot. History
// and asset metadata are assembled only after the bounded page has been chosen.
export function imageQaSummaryPageSql({ selectSql, baseJoins, detailJoins, filterSql, groupSql }) {
  const pagedJoins = detailJoins.replace('FROM image_sampling_items AS item',
    'FROM page_ids AS selected_page JOIN image_sampling_items AS item ON item.id = selected_page.id');
  return `WITH eligible AS MATERIALIZED (
    SELECT item.id, item.task_id, item.image_run_id, item.sample_kind, task.priority_sort_at
    ${baseJoins} WHERE ${filterSql}
  ), totals AS (
    SELECT count(*) AS total,
      count(*) FILTER (WHERE sample_kind = 'MANDATORY_RECHECK') AS mandatory_count FROM eligible
  ), summary AS (
    SELECT totals.*,
      (SELECT count(asset.id) FROM eligible
        JOIN image_runs AS image_run ON image_run.id = eligible.image_run_id
          AND image_run.task_id = eligible.task_id
        LEFT JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(image_run.result->'images') = 'array'
            THEN image_run.result->'images' ELSE '[]'::jsonb END
        ) AS page(image) ON true
        LEFT JOIN image_run_asset_view AS asset ON asset.task_id = eligible.task_id
          AND asset.image_run_id = eligible.image_run_id
          AND asset.id::text = COALESCE(page.image->>'deliveryAssetId', page.image->>'assetId')
      ) AS asset_count,
      LEAST($4::bigint, CASE WHEN total = 0 THEN 0
        ELSE ((total - 1) / $3::bigint) * $3::bigint END) AS effective_offset
    FROM totals
  ), page_ids AS MATERIALIZED (
    SELECT id, priority_sort_at FROM eligible ORDER BY priority_sort_at, id
      LIMIT $3 OFFSET (SELECT effective_offset FROM summary)
  ), page_details AS (
    ${selectSql} ${pagedJoins} ${groupSql}
  )
  SELECT summary.total, summary.mandatory_count, summary.asset_count, summary.effective_offset,
    COALESCE((SELECT jsonb_agg(to_jsonb(detail) ORDER BY selected_page.priority_sort_at, selected_page.id)
      FROM page_details AS detail JOIN page_ids AS selected_page ON selected_page.id = detail.id), '[]'::jsonb) AS items
  FROM summary`;
}
