CREATE TABLE delivery_batches (
  id bigserial PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE,
  code varchar(20) NOT NULL UNIQUE CHECK (code ~ '^JF-[0-9A-F]{8}$'),
  scope varchar(30) NOT NULL CHECK (scope IN ('ALL_READY', 'QUERY_PACKAGE', 'SELECTED')),
  query_package_name varchar(200),
  status varchar(20) NOT NULL DEFAULT 'GENERATED'
    CHECK (status IN ('GENERATED', 'DOWNLOADED')),
  archive_file_name varchar(180) NOT NULL,
  archive_byte_size bigint NOT NULL CHECK (archive_byte_size > 0),
  archive_sha256 char(64) NOT NULL CHECK (archive_sha256 ~ '^[a-f0-9]{64}$'),
  task_count integer NOT NULL CHECK (task_count > 0),
  created_by_account_id bigint NOT NULL,
  created_by_username varchar(50) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  first_downloaded_at timestamptz,
  last_downloaded_at timestamptz,
  download_count integer NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  CHECK ((scope = 'QUERY_PACKAGE') = (query_package_name IS NOT NULL))
);

CREATE TABLE delivery_batch_items (
  id bigserial PRIMARY KEY,
  delivery_batch_id bigint NOT NULL REFERENCES delivery_batches(id) ON DELETE RESTRICT,
  -- Snapshot only: tasks and delivery_entries may later be removed, while the
  -- immutable delivery manifest must remain readable.
  delivery_entry_id bigint,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  task_id bigint NOT NULL,
  copy_revision_id bigint NOT NULL,
  image_run_id uuid NOT NULL,
  query_snapshot text NOT NULL,
  query_package_id_snapshot bigint,
  query_package_name_snapshot varchar(200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(delivery_batch_id, ordinal),
  UNIQUE(task_id, copy_revision_id, image_run_id)
);

CREATE INDEX delivery_batch_items_batch_idx
  ON delivery_batch_items(delivery_batch_id, ordinal);
CREATE INDEX delivery_batch_items_delivery_entry_idx
  ON delivery_batch_items(delivery_entry_id) WHERE delivery_entry_id IS NOT NULL;
CREATE INDEX delivery_batch_items_task_idx
  ON delivery_batch_items(task_id, id DESC);
CREATE INDEX delivery_batch_items_package_name_idx
  ON delivery_batch_items(lower(query_package_name_snapshot), delivery_batch_id)
  WHERE query_package_name_snapshot IS NOT NULL;
CREATE INDEX delivery_batches_created_idx ON delivery_batches(created_at DESC, id DESC);

CREATE TABLE delivery_batch_download_events (
  id bigserial PRIMARY KEY,
  delivery_batch_id bigint NOT NULL REFERENCES delivery_batches(id) ON DELETE RESTRICT,
  actor_account_id bigint NOT NULL,
  actor_username varchar(50) NOT NULL,
  downloaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX delivery_batch_download_events_batch_idx
  ON delivery_batch_download_events(delivery_batch_id, downloaded_at DESC, id DESC);

CREATE FUNCTION protect_delivery_batch_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'delivery batch history is append-only';
END;
$$;

CREATE TRIGGER delivery_batch_items_append_only
BEFORE UPDATE OR DELETE ON delivery_batch_items
FOR EACH ROW EXECUTE FUNCTION protect_delivery_batch_history();

CREATE TRIGGER delivery_batch_download_events_append_only
BEFORE UPDATE OR DELETE ON delivery_batch_download_events
FOR EACH ROW EXECUTE FUNCTION protect_delivery_batch_history();
