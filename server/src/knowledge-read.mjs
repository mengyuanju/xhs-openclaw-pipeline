function positiveInteger(value, fallback, maximum) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new TypeError('knowledge pagination is invalid');
  return number;
}

function searchText(value, maximumLength) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new TypeError('knowledge search is invalid');
  const text = value.normalize('NFKC').trim();
  if ([...text].length > maximumLength) throw new TypeError('knowledge search is too long');
  return text.toLocaleLowerCase('zh-CN');
}

// Keep the workbench's newest-version semantics. Production publication and the
// full version-history endpoint remain separate from this bounded read.
export async function listCopyKnowledgeOverview(pool, options = {}) {
  const page = positiveInteger(options.page, 1, 1_000_000);
  const pageSize = positiveInteger(options.pageSize, 10, 100);
  const label = searchText(options.label, 50);
  const query = searchText(options.query, 200);
  const result = await pool.query(`
    WITH copies AS MATERIALIZED (
      SELECT i.id, i.name, v.id AS version_id, COALESCE(v.title, i.name) AS title, v.labels, v.created_at
      FROM knowledge_items i
      JOIN LATERAL (
        SELECT id, content->>'title' AS title,
          CASE WHEN jsonb_typeof(content->'labels') = 'array' THEN content->'labels' ELSE '[]'::jsonb END AS labels,
          created_at FROM knowledge_versions
        WHERE item_id = i.id ORDER BY version DESC LIMIT 1
      ) v ON true
      WHERE i.kind = 'COPY' AND i.status <> 'ARCHIVED'
    ), filtered AS MATERIALIZED (
      SELECT * FROM copies
      WHERE ($3 = '' OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(labels) label(value)
        WHERE jsonb_typeof(label.value) = 'string' AND lower(label.value #>> '{}') = $3
      )) AND ($4 = '' OR strpos(lower(normalize(title, NFKC)), $4) > 0)
    ), totals AS (
      SELECT count(*)::integer AS total FROM filtered
    ), bounds AS (
      SELECT total, GREATEST(1, CEIL(total::numeric / $2::integer)::integer) AS total_pages,
        LEAST($1, GREATEST(1, CEIL(total::numeric / $2::integer)::integer)) AS page FROM totals
    ), selected AS (
      SELECT filtered.* FROM filtered ORDER BY id DESC
      LIMIT $2 OFFSET (SELECT (page - 1) * $2 FROM bounds)
    ), page_items AS (
      SELECT selected.id, selected.name, v.content, selected.created_at FROM selected
      JOIN knowledge_versions v ON v.id = selected.version_id
    ), labels AS (
      SELECT label.value #>> '{}' AS name, count(*)::integer AS item_count FROM copies,
        LATERAL jsonb_array_elements(copies.labels) label(value)
      WHERE jsonb_typeof(label.value) = 'string' GROUP BY label.value
    )
    SELECT bounds.*,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name, 'content', content,
        'createdAt', created_at) ORDER BY id DESC) FROM page_items), '[]'::jsonb) AS items,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('name', name, 'itemCount', item_count)) FROM labels), '[]'::jsonb) AS labels
    FROM bounds`, [page, pageSize, label, query]);
  const row = result.rows[0];
  const data = row.items.map(item => ({ ...item.content, id: Number(item.id),
    title: item.content?.title ?? item.name, sourceCopy: item.content?.sourceCopy ?? '',
    analysisPrompt: item.content?.analysisPrompt ?? '', summary: item.content?.summary ?? '',
    analysis: item.content?.analysis ?? item.content?.text ?? '',
    labels: Array.isArray(item.content?.labels) ? item.content.labels.filter(label => typeof label === 'string') : [],
    createdAt: item.content?.createdAt ?? item.createdAt }));
  return { data, pagination: { page: Number(row.page), pageSize, totalItems: Number(row.total),
    totalPages: Number(row.total_pages) },
  labels: row.labels.sort((a, b) => b.itemCount - a.itemCount || a.name.localeCompare(b.name)) };
}
