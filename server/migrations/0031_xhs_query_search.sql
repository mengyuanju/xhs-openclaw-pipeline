CREATE TABLE xhs_query_search_nodes (
  id varchar(100) PRIMARY KEY,
  name varchar(100) NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE xhs_query_search_jobs (
  id bigserial PRIMARY KEY,
  query_package_item_id bigint UNIQUE
    REFERENCES query_package_items(id) ON DELETE SET NULL,
  task_id bigint UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  CHECK (query_package_item_id IS NOT NULL OR task_id IS NOT NULL),
  query_snapshot varchar(500) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'BLOCKED', 'FAILED', 'CANCELLED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  claimed_by_node_id varchar(100) REFERENCES xhs_query_search_nodes(id) ON DELETE SET NULL,
  lease_token uuid,
  lease_expires_at timestamptz,
  retry_after timestamptz,
  blocked_reason varchar(40)
    CHECK (blocked_reason IS NULL OR blocked_reason IN ('LOGIN_REQUIRED', 'CAPTCHA_REQUIRED')),
  error text,
  result_count integer NOT NULL DEFAULT 0 CHECK (result_count >= 0),
  searched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'RUNNING' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'RUNNING' AND lease_token IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX xhs_query_search_jobs_claim_idx
  ON xhs_query_search_jobs(status, retry_after, id);

CREATE TABLE xhs_query_links (
  id bigserial PRIMARY KEY,
  search_job_id bigint NOT NULL REFERENCES xhs_query_search_jobs(id) ON DELETE CASCADE,
  note_id varchar(128) NOT NULL,
  url varchar(2048) NOT NULL,
  title varchar(500),
  rank smallint NOT NULL CHECK (rank BETWEEN 1 AND 20),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(search_job_id, note_id),
  UNIQUE(search_job_id, rank)
);

-- Existing approved Query-package rows must enter the same acquisition queue.
-- Invalid and rejected rows are deliberately excluded.
INSERT INTO xhs_query_search_jobs(query_package_item_id, query_snapshot)
SELECT item.id, item.query
FROM query_package_items AS item
WHERE item.query IS NOT NULL
  AND item.status IN ('READY', 'TASK_CREATED')
  AND item.screening_decision = 'SELECTED'
ON CONFLICT(query_package_item_id) DO NOTHING;

-- Produced tasks outlive a permanently deleted Query package. Bind every
-- existing produced item to its durable task before package rows can vanish.
DO $$
BEGIN
  IF EXISTS (
    SELECT task.source_query_package_item_id
    FROM tasks AS task
    WHERE task.source_query_package_item_id IS NOT NULL
    GROUP BY task.source_query_package_item_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'multiple tasks reference one Query package item';
  END IF;
END $$;

UPDATE xhs_query_search_jobs AS job
SET task_id = task.id
FROM tasks AS task
WHERE task.source_query_package_item_id = job.query_package_item_id;
