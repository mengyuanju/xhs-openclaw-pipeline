-- Background sweeps frequently execute statements that affect zero rows.
-- Transition tables let each source advance once per changed statement only.
CREATE FUNCTION advance_nonempty_report_fact_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed boolean;
BEGIN
  IF TG_OP='DELETE' THEN SELECT EXISTS(SELECT 1 FROM old_report_rows) INTO changed;
  ELSE SELECT EXISTS(SELECT 1 FROM new_report_rows) INTO changed;
  END IF;
  IF changed THEN
    INSERT INTO report_fact_versions(source,shard) VALUES(TG_TABLE_NAME,pg_backend_pid()%64)
    ON CONFLICT(source,shard) DO UPDATE SET revision=report_fact_versions.revision+1;
  END IF;
  RETURN NULL;
END $$;
DO $$
DECLARE source_name text;
BEGIN
  FOR source_name IN SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE t.tgname='report_fact_version' AND n.nspname='public' AND c.relkind='r' LOOP
    EXECUTE format('DROP TRIGGER report_fact_version ON %I',source_name);
    EXECUTE format('CREATE TRIGGER report_fact_version_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS new_report_rows FOR EACH STATEMENT EXECUTE FUNCTION advance_nonempty_report_fact_version()',source_name);
    EXECUTE format('CREATE TRIGGER report_fact_version_update AFTER UPDATE ON %I REFERENCING NEW TABLE AS new_report_rows FOR EACH STATEMENT EXECUTE FUNCTION advance_nonempty_report_fact_version()',source_name);
    EXECUTE format('CREATE TRIGGER report_fact_version_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS old_report_rows FOR EACH STATEMENT EXECUTE FUNCTION advance_nonempty_report_fact_version()',source_name);
  END LOOP;
END $$;
