-- The unique constraint already provides this exact ordered btree index.
-- Refuse removal if a locally modified schema no longer has an equivalent constraint.
SET LOCAL lock_timeout = '1s';
DO $$
BEGIN
  IF to_regclass('public.delivery_batch_items_batch_idx') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_index redundant
      JOIN pg_class redundant_class ON redundant_class.oid=redundant.indexrelid
      JOIN pg_index retained ON retained.indrelid=redundant.indrelid
      JOIN pg_class retained_class ON retained_class.oid=retained.indexrelid
      JOIN pg_constraint retained_constraint ON retained_constraint.conindid=retained.indexrelid
        AND retained_constraint.contype='u'
      WHERE redundant.indexrelid='public.delivery_batch_items_batch_idx'::regclass
        AND redundant.indrelid='public.delivery_batch_items'::regclass
        AND NOT redundant.indisunique AND redundant.indisvalid
        AND retained.indisunique AND retained.indisvalid AND retained.indisready
        AND retained.indnkeyatts=redundant.indnkeyatts AND retained.indnatts=redundant.indnatts
        AND retained.indkey=redundant.indkey AND retained.indclass=redundant.indclass
        AND retained.indcollation=redundant.indcollation AND retained.indoption=redundant.indoption
        AND retained.indexprs IS NOT DISTINCT FROM redundant.indexprs
        AND retained.indpred IS NOT DISTINCT FROM redundant.indpred
        AND retained_class.relam=redundant_class.relam
        AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conindid=redundant.indexrelid)
    ) THEN
      RAISE EXCEPTION 'delivery batch ordinary index has no equivalent unique constraint index';
    END IF;
    DROP INDEX public.delivery_batch_items_batch_idx;
  END IF;
END;
$$;
