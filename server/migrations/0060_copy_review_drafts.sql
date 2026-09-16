CREATE TABLE copy_review_drafts (
  id bigserial PRIMARY KEY,
  task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  base_copy_revision_id bigint NOT NULL REFERENCES copy_revisions(id) ON DELETE CASCADE,
  reviewer_account_id bigint NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  reviewer_username varchar(80) NOT NULL,
  draft_version integer NOT NULL CHECK (draft_version > 0),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id, base_copy_revision_id, reviewer_account_id, draft_version)
);

CREATE INDEX copy_review_drafts_history_idx
  ON copy_review_drafts(task_id, base_copy_revision_id, reviewer_account_id, id DESC);
