-- RUNNING image-edit lease renewals do not change report membership, quality,
-- or the PREVIEW_READY timestamp used for waiting time. Other business changes
-- and timestamp changes outside RUNNING continue to invalidate exact facts.
DROP TRIGGER report_fact_version_update ON image_edit_requests;
CREATE FUNCTION advance_image_edit_report_fact_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM new_report_rows changed FULL JOIN old_report_rows previous USING(id)
    WHERE (to_jsonb(changed)-ARRAY['claimed_by','lease_token','lease_expires_at','updated_at'])
      IS DISTINCT FROM (to_jsonb(previous)-ARRAY['claimed_by','lease_token','lease_expires_at','updated_at'])
      OR changed.status<>'RUNNING' AND changed.updated_at IS DISTINCT FROM previous.updated_at) THEN
    INSERT INTO report_fact_versions(source,shard) VALUES(TG_TABLE_NAME,pg_backend_pid()%64)
      ON CONFLICT(source,shard) DO UPDATE SET revision=report_fact_versions.revision+1;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER report_fact_version_update
  AFTER UPDATE ON image_edit_requests REFERENCING NEW TABLE AS new_report_rows OLD TABLE AS old_report_rows
  FOR EACH STATEMENT EXECUTE FUNCTION advance_image_edit_report_fact_version();
