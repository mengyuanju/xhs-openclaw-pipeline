ALTER TABLE copy_review_drafts
  ADD COLUMN content_archived_at timestamptz;

CREATE TABLE copy_review_draft_payload_archives (
  draft_id bigint PRIMARY KEY REFERENCES copy_review_drafts(id) ON DELETE CASCADE,
  codec varchar(16) NOT NULL CHECK (codec = 'gzip'),
  payload bytea NOT NULL CHECK (octet_length(payload) BETWEEN 1 AND 1100000),
  original_byte_length integer NOT NULL CHECK (original_byte_length BETWEEN 2 AND 1048576),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  archived_at timestamptz NOT NULL DEFAULT now()
);

-- A bounded ID cursor avoids scanning every task to find an old draft body.
CREATE INDEX copy_review_drafts_pending_archive_idx ON copy_review_drafts(id)
  WHERE content_archived_at IS NULL;
