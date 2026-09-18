-- Original batches stay immutable and unique by content version. Confirmation
-- is per member; aggregate archives never consume the original version key.
CREATE TABLE delivery_item_owners (
  item_id bigint PRIMARY KEY REFERENCES delivery_batch_items(id) ON DELETE RESTRICT,
  account_id bigint NOT NULL,
  username varchar(50) NOT NULL
);
CREATE INDEX delivery_item_owners_account_idx ON delivery_item_owners(account_id, item_id);

INSERT INTO delivery_item_owners(item_id, account_id, username)
SELECT i.id, u.id, u.username FROM delivery_batch_items i
JOIN delivery_batches b ON b.id=i.delivery_batch_id
JOIN tasks t ON t.id=i.task_id
LEFT JOIN LATERAL (
  SELECT e.assignee_user_id, e.created_at FROM task_assignment_events e
  WHERE e.task_id=i.task_id AND e.created_at<=b.created_at
  ORDER BY e.created_at DESC,e.id DESC LIMIT 1
) assignment ON true
JOIN app_users u ON u.username=CASE WHEN assignment.created_at IS NOT NULL THEN assignment.assignee_user_id
  WHEN t.assigned_at<=b.created_at THEN t.assigned_to_user_id END
  AND u.created_at<COALESCE(assignment.created_at,t.assigned_at);

CREATE FUNCTION capture_delivery_item_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO delivery_item_owners(item_id,account_id,username)
  SELECT NEW.id,u.id,u.username FROM tasks t JOIN app_users u
    ON u.username=t.assigned_to_user_id AND u.created_at<t.assigned_at WHERE t.id=NEW.task_id;
  RETURN NEW;
END; $$;
CREATE TRIGGER delivery_item_owner_snapshot AFTER INSERT ON delivery_batch_items
FOR EACH ROW EXECUTE FUNCTION capture_delivery_item_owner();

CREATE TABLE delivery_item_confirmations (
  item_id bigint PRIMARY KEY REFERENCES delivery_batch_items(id) ON DELETE RESTRICT,
  actor_account_id bigint NOT NULL,
  actor_username varchar(50) NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  source varchar(30) NOT NULL CHECK (source IN ('ITEM','LEGACY_BATCH'))
);
CREATE INDEX delivery_item_confirmations_date_idx ON delivery_item_confirmations(confirmed_at,item_id);
CREATE INDEX delivery_item_confirmations_actor_idx ON delivery_item_confirmations(actor_account_id,confirmed_at);
INSERT INTO delivery_item_confirmations(item_id,actor_account_id,actor_username,confirmed_at,source)
SELECT i.id,b.delivered_by_account_id,b.delivered_by_username,b.delivered_at,'LEGACY_BATCH'
FROM delivery_batch_items i JOIN delivery_batches b ON b.id=i.delivery_batch_id WHERE b.status='DELIVERED';

CREATE TABLE delivery_item_download_events (
  id bigserial PRIMARY KEY,
  item_id bigint NOT NULL REFERENCES delivery_batch_items(id) ON DELETE RESTRICT,
  actor_account_id bigint NOT NULL,
  actor_username varchar(50) NOT NULL,
  downloaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_item_download_actor_idx ON delivery_item_download_events(item_id,actor_account_id);
INSERT INTO delivery_item_download_events(item_id,actor_account_id,actor_username,downloaded_at)
SELECT i.id,e.actor_account_id,e.actor_username,e.downloaded_at FROM delivery_batch_download_events e
JOIN delivery_batch_items i ON i.delivery_batch_id=e.delivery_batch_id;

CREATE FUNCTION mirror_delivery_batch_download() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO delivery_item_download_events(item_id,actor_account_id,actor_username,downloaded_at)
  SELECT id,NEW.actor_account_id,NEW.actor_username,NEW.downloaded_at
  FROM delivery_batch_items WHERE delivery_batch_id=NEW.delivery_batch_id;
  RETURN NEW;
END; $$;
CREATE TRIGGER delivery_batch_download_members AFTER INSERT ON delivery_batch_download_events
FOR EACH ROW EXECUTE FUNCTION mirror_delivery_batch_download();

CREATE FUNCTION mirror_delivery_batch_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO delivery_item_confirmations(item_id,actor_account_id,actor_username,confirmed_at,source)
  SELECT id,NEW.actor_account_id,NEW.actor_username,NEW.confirmed_at,'LEGACY_BATCH'
  FROM delivery_batch_items WHERE delivery_batch_id=NEW.delivery_batch_id ON CONFLICT DO NOTHING;
  RETURN NEW;
END; $$;
CREATE TRIGGER delivery_batch_confirmation_members AFTER INSERT ON delivery_batch_confirmation_events
FOR EACH ROW EXECUTE FUNCTION mirror_delivery_batch_confirmation();

CREATE TABLE delivery_archive_jobs (
  id bigserial PRIMARY KEY,
  request_id uuid NOT NULL,
  actor_account_id bigint NOT NULL,
  actor_username varchar(50) NOT NULL,
  kind varchar(20) NOT NULL CHECK (kind IN ('DOWNLOAD','ARCHIVE')),
  actor_role varchar(20) NOT NULL CHECK (actor_role IN ('ADMIN','USER')),
  status varchar(20) NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED')),
  selection jsonb NOT NULL,
  item_count integer NOT NULL CHECK (item_count BETWEEN 1 AND 2000),
  artifacts jsonb NOT NULL DEFAULT '[]',
  error text,
  run_token uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(actor_account_id,request_id)
);
CREATE INDEX delivery_archive_jobs_actor_idx ON delivery_archive_jobs(actor_account_id,created_at DESC,id DESC);
CREATE TABLE delivery_archive_items (
  job_id bigint NOT NULL REFERENCES delivery_archive_jobs(id) ON DELETE RESTRICT,
  item_id bigint NOT NULL REFERENCES delivery_batch_items(id) ON DELETE RESTRICT,
  snapshot jsonb NOT NULL,
  PRIMARY KEY(job_id,item_id)
);
CREATE INDEX delivery_archive_items_item_idx ON delivery_archive_items(item_id,job_id);
CREATE TABLE delivery_archive_download_events (
  id bigserial PRIMARY KEY,
  job_id bigint NOT NULL REFERENCES delivery_archive_jobs(id) ON DELETE RESTRICT,
  part integer NOT NULL CHECK (part>0),
  actor_account_id bigint NOT NULL,
  actor_username varchar(50) NOT NULL,
  downloaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_archive_downloads_job_idx ON delivery_archive_download_events(job_id,downloaded_at DESC);

CREATE TRIGGER delivery_item_owners_immutable BEFORE UPDATE OR DELETE ON delivery_item_owners
FOR EACH ROW EXECUTE FUNCTION protect_delivery_batch_history();
CREATE TRIGGER delivery_item_confirmations_immutable BEFORE UPDATE OR DELETE ON delivery_item_confirmations
FOR EACH ROW EXECUTE FUNCTION protect_delivery_batch_history();
CREATE TRIGGER delivery_item_downloads_immutable BEFORE UPDATE OR DELETE ON delivery_item_download_events
FOR EACH ROW EXECUTE FUNCTION protect_delivery_batch_history();
CREATE TRIGGER delivery_archive_items_immutable BEFORE UPDATE OR DELETE ON delivery_archive_items
FOR EACH ROW EXECUTE FUNCTION protect_delivery_batch_history();
CREATE TRIGGER delivery_archive_downloads_immutable BEFORE UPDATE OR DELETE ON delivery_archive_download_events
FOR EACH ROW EXECUTE FUNCTION protect_delivery_batch_history();

-- Keep personnel statistics tied to the member's actual first confirmer even
-- when a different person later confirms the rest of the original batch.
CREATE FUNCTION capture_delivery_member_performance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO operator_performance_events(event_key,task_id,account_id,stage,kind,occurred_at,data)
  SELECT 'delivered:'||i.delivery_batch_id||':'||i.id,i.task_id,NEW.actor_account_id,'IMAGE','DELIVERY',NEW.confirmed_at,
    jsonb_build_object('username',NEW.actor_username,'copyRevisionId',i.copy_revision_id,'imageRunId',i.image_run_id,
      'deliveryBatchId',i.delivery_batch_id,'query',i.query_snapshot,'batchId',t.production_batch_id,'createdAt',t.created_at,
      'displayName',COALESCE(u.display_name,NEW.actor_username),'role',u.role)
  FROM delivery_batch_items i LEFT JOIN tasks t ON t.id=i.task_id LEFT JOIN app_users u ON u.id=NEW.actor_account_id
  WHERE i.id=NEW.item_id ON CONFLICT(event_key) DO NOTHING;
  RETURN NEW;
END; $$;
CREATE TRIGGER delivery_member_performance AFTER INSERT ON delivery_item_confirmations
FOR EACH ROW EXECUTE FUNCTION capture_delivery_member_performance();
