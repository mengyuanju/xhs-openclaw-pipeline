-- Preserve inspection ancestry independently of mutable task/version rows.
-- No cascading foreign keys: reassignment and deletion must not rewrite history.
CREATE TABLE quality_inspection_links (
  stage text NOT NULL CHECK (stage IN ('COPY','IMAGE')),
  item_id bigint NOT NULL,
  task_id bigint NOT NULL,
  approval_id bigint NOT NULL,
  parent_item_id bigint,
  sample_kind text NOT NULL,
  submitter_id bigint,
  created_at timestamptz NOT NULL,
  PRIMARY KEY(stage,item_id)
);
CREATE INDEX quality_inspection_task_idx ON quality_inspection_links(task_id,stage);
CREATE INDEX quality_inspection_approval_idx ON quality_inspection_links(stage,approval_id);

CREATE FUNCTION preserve_quality_inspection_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO quality_inspection_links(stage,item_id,task_id,approval_id,parent_item_id,sample_kind,submitter_id,created_at)
  VALUES(CASE WHEN TG_TABLE_NAME='copy_sampling_items' THEN 'COPY' ELSE 'IMAGE' END,
    NEW.id,NEW.task_id,NEW.approval_event_id,NEW.parent_item_id,NEW.sample_kind,
    CASE WHEN TG_TABLE_NAME='copy_sampling_items' THEN (to_jsonb(NEW)->>'final_approver_account_id')::bigint
      ELSE (to_jsonb(NEW)->>'submitter_account_id')::bigint END,NEW.created_at)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_copy_inspection AFTER INSERT ON copy_sampling_items
  FOR EACH ROW EXECUTE FUNCTION preserve_quality_inspection_link();
CREATE TRIGGER preserve_image_inspection AFTER INSERT ON image_sampling_items
  FOR EACH ROW EXECUTE FUNCTION preserve_quality_inspection_link();

INSERT INTO quality_inspection_links
SELECT 'COPY',id,task_id,approval_event_id,parent_item_id,sample_kind,final_approver_account_id,created_at FROM copy_sampling_items
UNION ALL
SELECT 'IMAGE',id,task_id,approval_event_id,parent_item_id,sample_kind,submitter_account_id,created_at FROM image_sampling_items
ON CONFLICT DO NOTHING;
-- Deleted historical items are deliberately not reconstructed without ancestry.
