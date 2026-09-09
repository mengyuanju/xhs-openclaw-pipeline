CREATE TABLE IF NOT EXISTS execution_claim_cursors (
  kind varchar(10) PRIMARY KEY CHECK (kind IN ('COPY', 'IMAGE')),
  last_assignee_user_id varchar(50),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The cursor is operational scheduling state, not task data. In particular,
-- the username intentionally has no foreign key so deleting a user cannot
-- reset or block the circular order.
INSERT INTO execution_claim_cursors(kind, last_assignee_user_id)
VALUES ('COPY', NULL), ('IMAGE', NULL)
ON CONFLICT(kind) DO NOTHING;
