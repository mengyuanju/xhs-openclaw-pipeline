-- Manual image edits have their own queue; ordinary IMAGE execution cannot claim them.
ALTER TABLE image_runs ALTER COLUMN execution_id DROP NOT NULL;
ALTER TABLE assets ADD COLUMN parent_asset_id bigint REFERENCES assets(id),
  ADD COLUMN asset_role text NOT NULL DEFAULT 'DELIVERY',
  ADD COLUMN edit_metadata jsonb NOT NULL DEFAULT '{}';

CREATE TABLE image_edit_requests (
  id uuid PRIMARY KEY, task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  request_id uuid NOT NULL, source_image_run_id uuid NOT NULL REFERENCES image_runs(id),
  source_asset_id bigint NOT NULL REFERENCES assets(id), copy_revision_id bigint NOT NULL REFERENCES copy_revisions(id),
  source_sha256 char(64) NOT NULL, target_page integer NOT NULL CHECK(target_page BETWEEN 1 AND 5),
  operation text NOT NULL CHECK(operation IN ('TEXT','COMPOSITE','AI_FUSION','AI_FULL','AI_LOCAL','RESTORE')),
  config jsonb NOT NULL, status text NOT NULL CHECK(status IN ('DRAFT','QUEUED','RUNNING','PREVIEW_READY','ACCEPTED','REJECTED','FAILED','CANCELLED')),
  version integer NOT NULL DEFAULT 1, attempts integer NOT NULL DEFAULT 0,
  claimed_by text, lease_token uuid, lease_expires_at timestamptz,
  requeue_reason text NOT NULL DEFAULT 'IMAGE_MANUAL_EDIT',
  created_by text NOT NULL, error text, validation jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id, request_id)
);
CREATE INDEX image_edit_queue_idx ON image_edit_requests(created_at) WHERE status = 'QUEUED';
CREATE TABLE image_edit_reference_assets (
  request_id uuid NOT NULL REFERENCES image_edit_requests(id) ON DELETE CASCADE,
  asset_id bigint NOT NULL REFERENCES assets(id), purpose text NOT NULL, sort_order integer NOT NULL,
  sha256 char(64) NOT NULL, PRIMARY KEY(request_id, asset_id)
);
CREATE TABLE image_edit_results (
  request_id uuid PRIMARY KEY REFERENCES image_edit_requests(id) ON DELETE CASCADE,
  asset_id bigint NOT NULL REFERENCES assets(id), image_run_id uuid NOT NULL REFERENCES image_runs(id),
  mask_asset_id bigint REFERENCES assets(id), validation jsonb NOT NULL, adopted boolean NOT NULL DEFAULT false
);
CREATE TABLE image_edit_events (
  id bigserial PRIMARY KEY, task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  edit_id uuid REFERENCES image_edit_requests(id) ON DELETE CASCADE,
  action text NOT NULL, actor text NOT NULL, reason text NOT NULL, request_id uuid,
  detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id, request_id)
);
CREATE TABLE image_run_asset_members (
  image_run_id uuid NOT NULL REFERENCES image_runs(id) ON DELETE CASCADE,
  asset_id bigint NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  PRIMARY KEY(image_run_id, asset_id)
);
-- Readers use membership for edited runs while retaining legacy run membership.
CREATE VIEW image_run_asset_view AS
 SELECT a.id, a.task_id, m.image_run_id, a.media_type, a.byte_size, a.sha256,
   a.storage_path, a.original_name, a.created_at, a.image_production_chain_id,
   a.artifact_key, a.origin_image_run_id, a.active, a.parent_asset_id, a.asset_role, a.edit_metadata
 FROM image_run_asset_members m JOIN assets a ON a.id = m.asset_id
 UNION ALL
 SELECT a.id, a.task_id, a.image_run_id, a.media_type, a.byte_size, a.sha256,
   a.storage_path, a.original_name, a.created_at, a.image_production_chain_id,
   a.artifact_key, a.origin_image_run_id, a.active, a.parent_asset_id, a.asset_role, a.edit_metadata
 FROM assets a WHERE a.asset_role = 'DELIVERY'
 AND NOT EXISTS(SELECT 1 FROM image_run_asset_members m WHERE m.image_run_id = a.image_run_id AND m.asset_id = a.id);
