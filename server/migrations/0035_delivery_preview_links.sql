ALTER TABLE delivery_entries
  ADD COLUMN preview_id uuid,
  ADD COLUMN preview_note_id varchar(64),
  ADD COLUMN preview_url text,
  ADD COLUMN preview_content_hash char(64),
  ADD COLUMN preview_status varchar(20)
    CHECK (preview_status IS NULL OR preview_status IN ('PUBLISHED', 'REVOKED')),
  ADD COLUMN preview_uploaded_by_account_id bigint,
  ADD COLUMN preview_uploaded_by_username varchar(50),
  ADD COLUMN preview_published_at timestamptz,
  ADD COLUMN preview_revoked_at timestamptz,
  ADD CONSTRAINT delivery_entries_preview_binding_check CHECK (
    (preview_id IS NULL
      AND preview_note_id IS NULL
      AND preview_url IS NULL
      AND preview_content_hash IS NULL
      AND preview_status IS NULL
      AND preview_uploaded_by_account_id IS NULL
      AND preview_uploaded_by_username IS NULL
      AND preview_published_at IS NULL
      AND preview_revoked_at IS NULL)
    OR
    (preview_id IS NOT NULL
      AND preview_note_id ~ '^[0-9a-f]{32}$'
      AND char_length(preview_url) BETWEEN 1 AND 2048
      AND preview_content_hash ~ '^[0-9a-f]{64}$'
      AND preview_status IS NOT NULL
      AND preview_uploaded_by_account_id IS NOT NULL
      AND preview_uploaded_by_username IS NOT NULL
      AND preview_published_at IS NOT NULL
      AND ((preview_status = 'PUBLISHED' AND preview_revoked_at IS NULL)
        OR (preview_status = 'REVOKED' AND preview_revoked_at IS NOT NULL)))
  );

CREATE UNIQUE INDEX delivery_entries_preview_id_uq
  ON delivery_entries(preview_id) WHERE preview_id IS NOT NULL;

CREATE UNIQUE INDEX delivery_entries_preview_note_id_uq
  ON delivery_entries(preview_note_id) WHERE preview_note_id IS NOT NULL;
