-- Persist the protocol advertised by each executor heartbeat so operators can
-- distinguish an online legacy image worker from one that can execute edits.
ALTER TABLE executor_nodes
  ADD COLUMN image_edit_executor_version integer NOT NULL DEFAULT 0
    CHECK (image_edit_executor_version >= 0);
