-- Human quality review is a shared queue. Eligible reviewers may process any
-- pending item except content they submitted or finally approved themselves.
-- Existing assignment columns remain for historical compatibility only.

DROP TRIGGER IF EXISTS sampling_assign_review ON copy_sampling_items;
DROP TRIGGER IF EXISTS image_sampling_assign_review ON image_sampling_items;

UPDATE copy_sampling_items
SET assigned_review_account_id = NULL,
    assigned_review_at = NULL,
    updated_at = now()
WHERE selected = true
  AND status = 'PENDING'
  AND (assigned_review_account_id IS NOT NULL OR assigned_review_at IS NOT NULL);

UPDATE image_sampling_items
SET assigned_review_account_id = NULL,
    assigned_review_at = NULL,
    updated_at = now()
WHERE selected = true
  AND status = 'PENDING'
  AND (assigned_review_account_id IS NOT NULL OR assigned_review_at IS NOT NULL);

COMMENT ON COLUMN copy_sampling_items.assigned_review_account_id IS
  'Legacy preassignment; shared copy-QA queues do not populate or authorize with this field.';
COMMENT ON COLUMN image_sampling_items.assigned_review_account_id IS
  'Legacy preassignment; shared image-QA queues do not populate or authorize with this field.';
