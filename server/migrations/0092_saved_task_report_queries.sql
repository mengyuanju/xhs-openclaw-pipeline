CREATE TABLE saved_task_report_queries (
  id bigserial PRIMARY KEY,
  owner_account_id bigint NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  report_key varchar(40) NOT NULL DEFAULT 'TASK_DATA_STATISTICS'
    CHECK (report_key = 'TASK_DATA_STATISTICS'),
  name varchar(50) NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 50),
  schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  query_config jsonb NOT NULL CHECK (jsonb_typeof(query_config) = 'object'),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX saved_task_report_queries_owner_name_uq
  ON saved_task_report_queries(owner_account_id, report_key, lower(name));

CREATE UNIQUE INDEX saved_task_report_queries_one_default_uq
  ON saved_task_report_queries(owner_account_id, report_key)
  WHERE is_default = true;

CREATE INDEX saved_task_report_queries_owner_updated_idx
  ON saved_task_report_queries(owner_account_id, report_key, updated_at DESC, id DESC);
