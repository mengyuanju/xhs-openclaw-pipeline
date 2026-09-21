CREATE TABLE copy_qa_reason_tags (
  id bigserial PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE,
  group_code varchar(20) NOT NULL CHECK (group_code IN ('TITLE', 'BODY', 'PLAN')),
  label varchar(40) NOT NULL CHECK (char_length(label) BETWEEN 2 AND 20),
  normalized_label varchar(40) NOT NULL,
  owner_account_id bigint NOT NULL,
  owner_username varchar(50) NOT NULL,
  visibility varchar(20) NOT NULL DEFAULT 'PRIVATE'
    CHECK (visibility IN ('PRIVATE', 'PUBLIC')),
  status varchar(20) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'PENDING', 'DISABLED')),
  public_requested_at timestamptz,
  public_reviewed_at timestamptz,
  public_reviewed_by_account_id bigint,
  public_reviewed_by_username varchar(50),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX copy_qa_reason_tags_owner_label_uq
  ON copy_qa_reason_tags(owner_account_id, group_code, normalized_label)
  WHERE status <> 'DISABLED';

CREATE UNIQUE INDEX copy_qa_reason_tags_public_label_uq
  ON copy_qa_reason_tags(group_code, normalized_label)
  WHERE visibility = 'PUBLIC' AND status = 'ACTIVE';

CREATE INDEX copy_qa_reason_tags_owner_status_idx
  ON copy_qa_reason_tags(owner_account_id, status, updated_at DESC);

CREATE INDEX copy_qa_reason_tags_public_status_idx
  ON copy_qa_reason_tags(visibility, status, group_code, label);

COMMENT ON TABLE copy_qa_reason_tags IS
  'Reviewer-owned reusable copy-QA labels. Submitted verdicts store a label snapshot in revision/event JSON.';

COMMENT ON COLUMN copy_qa_reason_tags.owner_account_id IS
  'Immutable historical app_users.id; deliberately retained without a foreign key after account deletion.';
