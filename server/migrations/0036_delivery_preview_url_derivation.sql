ALTER TABLE delivery_entries
  DROP CONSTRAINT delivery_entries_preview_binding_check,
  DROP COLUMN preview_url;

ALTER TABLE delivery_entries
  ADD CONSTRAINT delivery_entries_preview_binding_check CHECK (
    (preview_id IS NULL
      AND preview_note_id IS NULL
      AND preview_content_hash IS NULL
      AND preview_status IS NULL
      AND preview_uploaded_by_account_id IS NULL
      AND preview_uploaded_by_username IS NULL
      AND preview_published_at IS NULL
      AND preview_revoked_at IS NULL)
    OR
    (preview_id IS NOT NULL
      AND preview_note_id ~ '^[0-9a-f]{32}$'
      AND preview_content_hash ~ '^[0-9a-f]{64}$'
      AND preview_status IS NOT NULL
      AND preview_uploaded_by_account_id IS NOT NULL
      AND preview_uploaded_by_username IS NOT NULL
      AND preview_published_at IS NOT NULL
      AND ((preview_status = 'PUBLISHED' AND preview_revoked_at IS NULL)
        OR (preview_status = 'REVOKED' AND preview_revoked_at IS NOT NULL)))
  );
