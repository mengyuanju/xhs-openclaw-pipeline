-- Forward repair for the known 0043 draft already recorded by the 2026-09-13
-- deployment. The schema probe in database-migrations.mjs additionally proves
-- that the draft produced the intended nullable timestamptz column.
ALTER TABLE public.xhs_query_search_nodes
  ADD COLUMN IF NOT EXISTS retired_at timestamptz;
