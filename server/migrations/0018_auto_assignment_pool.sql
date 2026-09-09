CREATE TABLE IF NOT EXISTS task_auto_assignment_settings (
  singleton smallint PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by_username varchar(50),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Automatic assignment is opt-in. Applying this migration must never start
-- routing work in an existing installation.
INSERT INTO task_auto_assignment_settings(singleton, enabled)
VALUES (1, false)
ON CONFLICT(singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS task_auto_assignment_workers (
  username varchar(50) PRIMARY KEY
    REFERENCES app_users(username) ON DELETE CASCADE,
  status varchar(20) NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED')),
  assignment_limit smallint NOT NULL CHECK (assignment_limit BETWEEN 1 AND 500),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_username varchar(50) NOT NULL,
  updated_by_username varchar(50) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_auto_assignment_workers_status_username_idx
  ON task_auto_assignment_workers(status, username);

CREATE TABLE IF NOT EXISTS task_auto_assignment_admin_events (
  id bigserial PRIMARY KEY,
  actor_username varchar(50) NOT NULL,
  action varchar(30) NOT NULL CHECK (action IN (
    'SETTINGS_UPDATED', 'WORKER_ADDED', 'WORKER_UPDATED', 'WORKER_REMOVED'
  )),
  worker_username varchar(50),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_auto_assignment_admin_events_created_idx
  ON task_auto_assignment_admin_events(created_at DESC, id DESC);
