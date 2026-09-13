-- Nodes that share one local Codex runtime must share a center-side capacity pool.
CREATE TABLE codex_concurrency_pools (
  id varchar(128) PRIMARY KEY,
  total_concurrency integer NOT NULL CHECK (total_concurrency BETWEEN 1 AND 64),
  image_concurrency integer NOT NULL CHECK (image_concurrency BETWEEN 1 AND 64),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (image_concurrency <= total_concurrency)
);

ALTER TABLE executor_nodes
  ADD COLUMN codex_pool_id varchar(128);

INSERT INTO codex_concurrency_pools(id, total_concurrency, image_concurrency)
SELECT id, GREATEST(copy_concurrency, image_concurrency), image_concurrency
FROM executor_nodes
ON CONFLICT(id) DO NOTHING;

UPDATE executor_nodes SET codex_pool_id = id WHERE codex_pool_id IS NULL;

ALTER TABLE executor_nodes
  ADD CONSTRAINT executor_nodes_codex_pool_fk
    FOREIGN KEY (codex_pool_id) REFERENCES codex_concurrency_pools(id);

CREATE INDEX executor_nodes_codex_pool_idx ON executor_nodes(codex_pool_id, id);

-- One production chain spans all automatic recovery attempts.  Artifact identity
-- is stable inside the chain, preventing duplicate rows and duplicate files.
ALTER TABLE tasks
  ADD COLUMN image_production_chain_id uuid,
  ADD COLUMN image_production_started_at timestamptz,
  ADD COLUMN image_production_duration_ms bigint NOT NULL DEFAULT 0
    CHECK (image_production_duration_ms >= 0);

ALTER TABLE task_executions
  ADD COLUMN image_production_chain_id uuid;

ALTER TABLE image_runs
  ADD COLUMN image_production_chain_id uuid;

UPDATE image_runs SET image_production_chain_id = id
WHERE image_production_chain_id IS NULL;

UPDATE task_executions AS execution
SET image_production_chain_id = run.image_production_chain_id
FROM image_runs AS run
WHERE run.execution_id = execution.id
  AND execution.image_production_chain_id IS NULL;

UPDATE tasks AS task
SET image_production_chain_id = run.image_production_chain_id,
    image_production_started_at = execution.started_at,
    image_production_duration_ms = CASE
      WHEN execution.finished_at IS NULL THEN 0
      ELSE GREATEST(0,
        EXTRACT(EPOCH FROM (execution.finished_at - execution.started_at)) * 1000)::bigint
    END
FROM image_runs AS run
JOIN task_executions AS execution ON execution.id = run.execution_id
WHERE task.current_image_run_id = run.id
  AND task.image_production_chain_id IS NULL;

ALTER TABLE image_runs
  ALTER COLUMN image_production_chain_id SET NOT NULL;

ALTER TABLE assets
  ADD COLUMN image_production_chain_id uuid,
  ADD COLUMN artifact_key varchar(255),
  ADD COLUMN origin_image_run_id uuid,
  ADD COLUMN active boolean NOT NULL DEFAULT true;

UPDATE assets AS asset
SET image_production_chain_id = run.image_production_chain_id,
    artifact_key = 'legacy-' || asset.id::text,
    origin_image_run_id = asset.image_run_id
FROM image_runs AS run
WHERE run.id = asset.image_run_id
  AND asset.image_production_chain_id IS NULL;

ALTER TABLE assets
  ALTER COLUMN image_production_chain_id SET NOT NULL,
  ALTER COLUMN artifact_key SET NOT NULL,
  ALTER COLUMN origin_image_run_id SET NOT NULL;

CREATE UNIQUE INDEX assets_chain_artifact_uq
  ON assets(image_production_chain_id, artifact_key);

CREATE INDEX task_executions_image_chain_idx
  ON task_executions(task_id, image_production_chain_id, started_at)
  WHERE kind = 'IMAGE';

CREATE INDEX assets_active_run_idx
  ON assets(image_run_id, id) WHERE active;
