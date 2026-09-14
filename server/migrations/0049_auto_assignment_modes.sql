-- Existing installations keep the original continuous replenishment behavior.
-- Administrators can explicitly switch to fixed-quantity, one-shot allocation.
ALTER TABLE task_auto_assignment_settings
  ADD COLUMN mode varchar(30) NOT NULL DEFAULT 'CONTINUOUS'
    CHECK (mode IN ('CONTINUOUS', 'FIXED_QUANTITY'));

ALTER TABLE task_auto_assignment_admin_events
  DROP CONSTRAINT task_auto_assignment_admin_events_action_check;

ALTER TABLE task_auto_assignment_admin_events
  ADD CONSTRAINT task_auto_assignment_admin_events_action_check CHECK (action IN (
    'SETTINGS_UPDATED', 'WORKER_ADDED', 'WORKER_UPDATED', 'WORKER_REMOVED',
    'ALLOCATION_RUN'
  ));
