CREATE TABLE IF NOT EXISTS human_quality_review_submissions (
  review_session_id uuid PRIMARY KEY,
  task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  stage varchar(10) NOT NULL CHECK (stage IN ('COPY', 'IMAGE')),
  reviewer_username varchar(50) NOT NULL,
  request_fingerprint char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS human_quality_assessments (
  id bigserial PRIMARY KEY,
  task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  stage varchar(10) NOT NULL CHECK (stage IN ('COPY', 'IMAGE')),
  copy_revision_id bigint REFERENCES copy_revisions(id) ON DELETE CASCADE,
  image_run_id uuid REFERENCES image_runs(id) ON DELETE CASCADE,
  score_x10 smallint NOT NULL CHECK (score_x10 IN (10, 20, 25, 30)),
  rating_context varchar(20) NOT NULL CHECK (rating_context IN ('ORIGINAL', 'EDITED', 'IMAGE')),
  action varchar(20) NOT NULL CHECK (action IN ('SAVE', 'APPROVE', 'RETRY', 'DISCARD')),
  reason_codes text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(reason_codes) <= 10),
  problem_asset_ids bigint[] NOT NULL DEFAULT '{}'::bigint[] CHECK (cardinality(problem_asset_ids) <= 20),
  note text CHECK (note IS NULL OR char_length(note) <= 1000),
  -- Keep the authenticated username as an immutable audit snapshot even if the
  -- corresponding account is later deleted.
  reviewer_username varchar(50) NOT NULL,
  review_session_id uuid NOT NULL REFERENCES human_quality_review_submissions(review_session_id) ON DELETE CASCADE,
  request_fingerprint char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (stage = 'COPY' AND copy_revision_id IS NOT NULL AND image_run_id IS NULL
      AND rating_context IN ('ORIGINAL', 'EDITED') AND cardinality(problem_asset_ids) = 0)
    OR
    (stage = 'IMAGE' AND copy_revision_id IS NULL AND image_run_id IS NOT NULL
      AND rating_context = 'IMAGE')
  )
);

CREATE INDEX IF NOT EXISTS human_quality_assessments_task_created_idx
  ON human_quality_assessments(task_id, created_at, id);

CREATE INDEX IF NOT EXISTS human_quality_assessments_copy_revision_idx
  ON human_quality_assessments(copy_revision_id) WHERE copy_revision_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS human_quality_assessments_image_run_idx
  ON human_quality_assessments(image_run_id) WHERE image_run_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS human_quality_assessments_copy_session_idx
  ON human_quality_assessments(review_session_id, copy_revision_id)
  WHERE stage = 'COPY';

CREATE UNIQUE INDEX IF NOT EXISTS human_quality_assessments_image_session_idx
  ON human_quality_assessments(review_session_id, image_run_id)
  WHERE stage = 'IMAGE';
