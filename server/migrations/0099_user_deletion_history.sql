-- These IDs describe historical account identity, not a live assignment.
-- Keep the original non-null numeric ID after account deletion, as copy
-- approvals and mutation receipts already do. SET NULL or CASCADE would lose
-- attribution, sampling state, or the user's existing image artifacts.
ALTER TABLE image_approval_events
  DROP CONSTRAINT image_approval_events_submitted_by_account_id_fkey;
ALTER TABLE image_sampling_freezes
  DROP CONSTRAINT image_sampling_freezes_submitter_account_id_fkey;
ALTER TABLE image_sampling_items
  DROP CONSTRAINT image_sampling_items_submitter_account_id_fkey;
ALTER TABLE copy_image_plan_regeneration_jobs
  DROP CONSTRAINT copy_image_plan_regeneration_jobs_requested_by_account_id_fkey;
ALTER TABLE standalone_image_workspaces
  DROP CONSTRAINT standalone_image_workspaces_owner_id_fkey;

-- Late image-sampling tails can still freeze an approval after its submitter
-- has left. Their remainder must survive and remain writable for that ID.
ALTER TABLE image_sampling_remainders
  DROP CONSTRAINT image_sampling_remainders_submitter_account_id_fkey;

COMMENT ON COLUMN image_approval_events.submitted_by_account_id IS
  'Immutable historical app_users.id; retained without a foreign key after account deletion.';
COMMENT ON COLUMN image_sampling_freezes.submitter_account_id IS
  'Immutable historical submitter ID; account deletion preserves the frozen sampling population.';
COMMENT ON COLUMN image_sampling_items.submitter_account_id IS
  'Immutable historical submitter ID; account deletion preserves image quality history.';
COMMENT ON COLUMN image_sampling_remainders.submitter_account_id IS
  'Immutable historical submitter ID; retained for late sampling freezes after account deletion.';
COMMENT ON COLUMN copy_image_plan_regeneration_jobs.requested_by_account_id IS
  'Immutable historical requester ID; never inherited by a replacement account with the same username.';
COMMENT ON COLUMN standalone_image_workspaces.owner_id IS
  'Immutable owner account ID; preserved image artifacts remain inaccessible to replacement accounts.';
