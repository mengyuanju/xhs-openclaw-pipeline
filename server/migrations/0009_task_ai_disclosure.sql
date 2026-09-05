ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS ai_disclosure_enabled boolean NOT NULL DEFAULT true;

