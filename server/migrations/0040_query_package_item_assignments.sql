ALTER TABLE query_package_items
  ADD COLUMN screening_assigned_to_account_id bigint REFERENCES app_users(id) ON DELETE SET NULL,
  ADD COLUMN screening_assigned_to_username varchar(50),
  ADD COLUMN screening_assigned_by_account_id bigint REFERENCES app_users(id) ON DELETE SET NULL,
  ADD COLUMN screening_assigned_by_username varchar(50),
  ADD COLUMN screening_assigned_at timestamptz,
  ADD CONSTRAINT query_package_items_screening_assignee_complete_check CHECK (
    (screening_assigned_to_account_id IS NULL AND screening_assigned_to_username IS NULL)
    OR
    (screening_assigned_to_account_id IS NOT NULL AND screening_assigned_to_username IS NOT NULL)
  );

-- Preserve access for packages that were assigned with the legacy whole-package
-- model. Future assignments are stored on each pending item instead.
UPDATE query_package_items AS item
SET screening_assigned_to_account_id = package.assigned_to_account_id,
    screening_assigned_to_username = package.assigned_to_username,
    screening_assigned_at = package.updated_at
FROM query_packages AS package
WHERE item.query_package_id = package.id
  AND item.status = 'READY'
  AND item.screening_decision = 'PENDING'
  AND package.assigned_to_account_id IS NOT NULL
  AND package.assigned_to_username IS NOT NULL;

CREATE INDEX query_package_items_screening_assignee_package_idx
  ON query_package_items(
    screening_assigned_to_account_id,
    screening_assigned_to_username,
    query_package_id,
    row_number,
    id
  )
  WHERE status = 'READY' AND screening_decision = 'PENDING';

CREATE INDEX query_package_items_package_screening_assignee_idx
  ON query_package_items(
    query_package_id,
    screening_assigned_to_account_id,
    screening_assigned_to_username,
    row_number,
    id
  )
  WHERE status = 'READY' AND screening_decision = 'PENDING';

CREATE TABLE query_package_item_assignment_events (
  id bigserial PRIMARY KEY,
  query_package_id bigint NOT NULL REFERENCES query_packages(id) ON DELETE CASCADE,
  query_package_item_id bigint NOT NULL REFERENCES query_package_items(id) ON DELETE CASCADE,
  actor_account_id bigint,
  actor_username varchar(50) NOT NULL,
  previous_assignee_account_id bigint,
  previous_assignee_username varchar(50),
  assignee_account_id bigint,
  assignee_username varchar(50),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX query_package_item_assignment_events_package_created_idx
  ON query_package_item_assignment_events(query_package_id, created_at DESC, id DESC);

ALTER TABLE query_package_mutation_requests
  DROP CONSTRAINT query_package_mutation_requests_operation_check;

ALTER TABLE query_package_mutation_requests
  ADD CONSTRAINT query_package_mutation_requests_operation_check
  CHECK (operation IN ('CREATE', 'SCREEN', 'PRODUCE', 'ABANDON', 'DELETE', 'ASSIGN_ITEMS'));
