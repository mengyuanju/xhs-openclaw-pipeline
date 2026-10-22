-- Snapshot references survive task/version cleanup. Files remain at their original
-- immutable asset paths; download ZIPs are only temporary derived artifacts.
CREATE TABLE delivery_snapshot_assets (
  snapshot_public_id uuid NOT NULL,
  storage_path text NOT NULL CHECK (length(storage_path) > 0),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  task_id bigint NOT NULL CHECK (task_id > 0),
  asset_id bigint CHECK (asset_id > 0),
  PRIMARY KEY (snapshot_public_id, storage_path)
);

CREATE INDEX delivery_snapshot_assets_path_idx ON delivery_snapshot_assets(storage_path);
CREATE INDEX delivery_snapshot_assets_task_idx ON delivery_snapshot_assets(task_id);
