import assert from 'node:assert/strict';
import test from 'node:test';

import { loadMigrations } from '../src/database-migrations.mjs';

async function migration(id) {
  const result = (await loadMigrations()).find((item) => item.id === id);
  assert.ok(result, `missing migration ${id}`);
  return result.sql;
}

test('query-package deletion detaches durable production history instead of cascading tasks', async () => {
  const sql = await migration('0024_query_packages');
  assert.match(sql, /CREATE TABLE query_packages/u);
  assert.match(sql, /CREATE TABLE query_package_items/u);
  assert.match(sql, /CREATE TABLE production_batches/u);
  assert.match(sql, /public_id uuid NOT NULL UNIQUE/u);
  assert.match(sql, /source_query_package_id bigint REFERENCES query_packages\(id\) ON DELETE SET NULL/u);
  assert.match(sql, /source_query_package_item_id bigint REFERENCES query_package_items\(id\) ON DELETE SET NULL/u);
  assert.match(sql, /production_batch_id bigint REFERENCES production_batches\(id\) ON DELETE SET NULL/u);
  assert.match(sql, /query_snapshot varchar\(500\) NOT NULL/u);
  assert.match(sql, /source_query_package_name varchar\(200\)/u);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+tasks|TRUNCATE\s+tasks/u);
  assert.doesNotMatch(
    sql,
    /ALTER TABLE tasks[\s\S]*REFERENCES query_packages\(id\) ON DELETE CASCADE/u,
  );
});

test('copy sampling migration is opt-in and introduces one canonical pending state', async () => {
  const sql = await migration('0025_copy_sampling');
  assert.match(sql, /'COPY_QC_PENDING'/u);
  assert.doesNotMatch(sql, /COPY_SAMPLE_HOLD|COPY_QA_PENDING/u);
  assert.match(sql, /query_package_worker_import_enabled boolean NOT NULL DEFAULT false/u);
  assert.match(sql, /copy_sampling_enabled boolean NOT NULL DEFAULT false/u);
  assert.match(sql, /blind_review_enabled boolean NOT NULL DEFAULT false/u);
  assert.match(sql, /reviewer_batch_return_enabled boolean NOT NULL DEFAULT false/u);
  assert.match(sql, /copy_sampling_rate_bps integer NOT NULL DEFAULT 0/u);
  assert.match(sql, /CHECK \(copy_sampling_rate_bps BETWEEN 0 AND 10000\)/u);
});

test('a frozen sample binds final approval evidence and persists the whole population', async () => {
  const sql = await migration('0025_copy_sampling');
  assert.match(sql, /CREATE TABLE copy_approval_events/u);
  assert.match(sql, /copy_revision_id bigint NOT NULL REFERENCES copy_revisions\(id\)/u);
  assert.match(sql, /assessment_id bigint REFERENCES human_quality_assessments\(id\)/u);
  assert.match(sql, /content_sha256 char\(64\) NOT NULL/u);
  assert.match(sql, /CREATE UNIQUE INDEX copy_approval_events_one_revision_idx\s+ON copy_approval_events\(task_id, copy_revision_id\)/u,
    'ON CONFLICT(task_id, copy_revision_id) needs an exactly matching unique index');
  assert.match(sql, /CREATE TABLE copy_sampling_freezes/u);
  assert.match(sql, /algorithm_version varchar\(80\) NOT NULL/u);
  assert.match(sql, /snapshot_sha256 char\(64\) NOT NULL/u);
  assert.match(sql, /blind_review_enabled boolean NOT NULL/u);
  assert.match(sql, /CREATE TABLE copy_sampling_strata/u);
  assert.match(sql, /final_approver_account_id bigint NOT NULL/u);
  assert.match(sql, /quota integer NOT NULL/u);
  assert.match(sql, /CREATE TABLE copy_sampling_items/u);
  assert.match(sql, /approval_event_id bigint NOT NULL REFERENCES copy_approval_events\(id\)/u);
  assert.match(sql, /selected boolean NOT NULL/u);
  assert.match(sql, /rank_hash char\(64\) NOT NULL/u);
  assert.match(sql, /sample_kind varchar\(20\) NOT NULL DEFAULT 'RANDOM'/u);
  assert.match(sql, /parent_item_id bigint REFERENCES copy_sampling_items\(id\) ON DELETE SET NULL/u);
  assert.match(sql, /ADD COLUMN mandatory_copy_qc boolean NOT NULL DEFAULT false/u);
  assert.match(sql, /ADD COLUMN mandatory_copy_qc_origin varchar\(30\)/u);
});

test('delivery migration creates a version-pinned ready record without rewriting reviewed tasks', async () => {
  const sql = await migration('0026_final_delivery');
  assert.match(sql, /CREATE TABLE delivery_entries/u);
  assert.match(sql, /copy_revision_id bigint NOT NULL REFERENCES copy_revisions\(id\)/u);
  assert.match(sql, /image_run_id uuid NOT NULL REFERENCES image_runs\(id\)/u);
  assert.match(sql, /delivery_entries_one_ready_task_idx/u);
  assert.match(sql, /WHERE task\.state = 'REVIEWED'/u);
  assert.ok(sql.includes("parent_revision_text ~ '^[1-9][0-9]{0,18}$'"));
  assert.match(sql, /parent_revision_text <= '9223372036854775807'/u);
  assert.match(sql, /WHERE human\.execution_id IS NULL/u,
    'machine revisions must never be marked as human copy edits during backfill');
  assert.match(sql, /ORDER BY generated\.revision DESC, generated\.id DESC/u,
    'legacy human revisions without lineage must compare with the nearest preceding machine revision');
  assert.match(sql, /THEN candidate\.parent_revision_text::bigint/u);
  assert.equal(sql.includes("(revision.content #>> '{manualReview,baseRevisionId}')::bigint"), false,
    'untrusted JSON must not be cast before a bigint range guard');
  assert.doesNotMatch(sql, /UPDATE\s+tasks|DELETE\s+FROM\s+tasks|TRUNCATE\s+tasks/u);
});

test('delivery archive integrity migration withdraws unarchivable legacy READY entries', async () => {
  const sql = await migration('0027_delivery_archive_integrity');
  assert.match(sql, /SET status = 'WITHDRAWN'/u);
  assert.match(sql, /LEFT JOIN copy_revisions AS revision ON revision\.id = delivery\.copy_revision_id/u,
    'validation must load the copy revision pinned by the delivery entry');
  assert.match(sql, /LEFT JOIN image_runs AS image_run ON image_run\.id = delivery\.image_run_id/u,
    'validation must load the image run pinned by the delivery entry');
  assert.match(sql, /task\.state AS task_state/u);
  assert.match(sql, /source\.task_state IS DISTINCT FROM 'REVIEWED'/u,
    'a READY delivery is invalid when its task has left the reviewed state');
  assert.match(sql, /source\.copy_revision_id IS DISTINCT FROM source\.current_copy_revision_id/u,
    'a READY entry must be withdrawn when its pinned copy is no longer current, including a NULL current pointer');
  assert.match(sql, /source\.image_run_id IS DISTINCT FROM source\.current_image_run_id/u,
    'a READY entry must be withdrawn when its pinned image run is no longer current, including a NULL current pointer');
  assert.match(sql, /source\.revision_task_id IS DISTINCT FROM source\.task_id/u);
  assert.match(sql, /source\.image_run_task_id IS DISTINCT FROM source\.task_id/u);
  assert.match(sql, /jsonb_typeof\(image_run\.result->'images'\)/u);
  assert.match(sql, /jsonb_array_elements/u);
  assert.match(sql, /LEFT JOIN assets AS asset/u);
  assert.match(sql, /source\.image_run_copy_revision_id IS DISTINCT FROM source\.copy_revision_id/u);
  assert.match(sql, /source\.image_run_status IS DISTINCT FROM 'COMPLETED'/u);
  assert.match(sql, /\[0-9\]\{0,18\}/u);
  assert.match(sql, /<= '9223372036854775807'/u);
  assert.match(sql, /WITH archivable_ready_deliveries AS/u);
  assert.match(sql, /source_task\.state = 'REVIEWED'/u,
    'anomaly suppression must not accept a READY row hidden from the delivery pool by task state');
  assert.match(sql, /delivery\.copy_revision_id = source_task\.current_copy_revision_id/u,
    'anomaly suppression must only accept READY delivery sources matching the current copy');
  assert.match(sql, /delivery\.image_run_id = source_task\.current_image_run_id/u,
    'anomaly suppression must only accept READY delivery sources matching the current image run');
  assert.match(sql, /revision\.approved_at IS NOT NULL/u);
  assert.match(sql, /image_run\.status = 'COMPLETED'/u);
  assert.match(sql, /FROM archivable_ready_deliveries AS delivery/u,
    'a merely present READY row must not suppress a migration anomaly');
  assert.match(sql, /READY_DELIVERY_SOURCE_NOT_ARCHIVABLE/u);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+tasks|TRUNCATE\s+tasks/u);
});

test('delivery compatibility repair safely converges legacy lineage and archive checks', async () => {
  const sql = await migration('0029_final_delivery_compatibility_repair');
  assert.ok(sql.includes("parent_revision_text ~ '^[1-9][0-9]{0,18}$'"));
  assert.match(sql, /parent_revision_text <= '9223372036854775807'/u);
  assert.match(sql, /THEN candidate\.parent_revision_text::bigint/u);
  assert.match(sql, /WHERE id = '0026_final_delivery'/u,
    'origin repair must be bounded by the original migration timestamp');
  assert.match(sql, /revision\.created_at <= boundary\.applied_at/u);
  assert.match(sql, /SET copy_content_changed_from_machine = false/u,
    'legacy machine revisions must be reset to a non-human-edit state');
  assert.match(sql, /ORDER BY generated\.revision DESC, generated\.id DESC/u);
  assert.match(sql, /SET copy_content_changed_from_machine = evaluated\.changed_from_machine/u,
    'human flags must be recomputed, including clearing legacy false positives');
  assert.match(sql, /source\.task_state IS DISTINCT FROM 'REVIEWED'/u);
  assert.match(sql, /source\.copy_revision_id IS DISTINCT FROM source\.current_copy_revision_id/u);
  assert.match(sql, /source\.image_run_id IS DISTINCT FROM source\.current_image_run_id/u);
  assert.match(sql, /source\.image_run_copy_revision_id IS DISTINCT FROM source\.copy_revision_id/u);
  assert.match(sql, /READY_DELIVERY_SOURCE_NOT_ARCHIVABLE/u);
  assert.doesNotMatch(sql, /copy_rework_satisfied/u,
    'compatibility repair must not satisfy a pending mandatory rework');
  assert.doesNotMatch(sql, /UPDATE\s+tasks|DELETE\s+FROM\s+tasks|TRUNCATE\s+tasks/u);
});

test('delivery runtime integrity uses safe numeric asset identities and preserves anomaly time', async () => {
  const sql = await migration('0030_delivery_asset_runtime_integrity');
  assert.equal((sql.match(/<= '9007199254740991'/gu) ?? []).length, 2);
  assert.equal((sql.match(/\[0-9\]\{0,15\}/gu) ?? []).length, 2);
  assert.match(sql, /source\.task_state IS DISTINCT FROM 'REVIEWED'/u);
  assert.match(sql, /source\.image_run_copy_revision_id IS DISTINCT FROM source\.copy_revision_id/u);
  assert.match(sql, /delivery_migration_anomalies\.reason IS DISTINCT FROM EXCLUDED\.reason/u,
    'repeat integrity checks must preserve the first anomaly detection timestamp');
  assert.doesNotMatch(sql, /detected_at\s*=\s*EXCLUDED\.detected_at/u);
  assert.doesNotMatch(sql, /UPDATE\s+tasks|DELETE\s+FROM\s+tasks|TRUNCATE\s+tasks/u);
});

test('mutation receipt identities survive account deletion and cannot transfer by username', async () => {
  const sql = await migration('0028_mutation_receipt_actor_identity');
  assert.match(sql, /ALTER TABLE query_package_mutation_requests[\s\S]*ADD COLUMN actor_account_id bigint/u);
  assert.match(sql, /ALTER TABLE copy_sampling_mutation_requests[\s\S]*ADD COLUMN actor_account_id bigint/u);
  assert.match(sql, /actor\.created_at <= receipt\.created_at/u,
    'a same-name replacement created after a legacy receipt must not inherit it during backfill');
  assert.match(sql, /PRIMARY KEY\(actor_account_id, request_id\)/gu);
  assert.match(sql, /ALTER COLUMN actor_account_id SET NOT NULL/gu);
  assert.match(sql, /DROP CONSTRAINT production_batches_created_by_username_request_id_key/u);
  assert.match(sql, /UNIQUE\(created_by_account_id, request_id\)/u);
  assert.match(sql, /DROP CONSTRAINT copy_sampling_freezes_frozen_by_username_request_id_key/u);
  assert.match(sql, /UNIQUE\(frozen_by_account_id, request_id\)/u);
  assert.match(sql, /DROP CONSTRAINT query_package_deletion_audits_actor_username_request_id_key/u);
  assert.match(sql, /DROP CONSTRAINT query_package_lifecycle_audits_actor_username_request_id_key/u);
  assert.equal((sql.match(/UNIQUE\(actor_account_id, request_id\)/gu) ?? []).length, 2);
  assert.doesNotMatch(sql, /actor_account_id bigint REFERENCES app_users/u,
    'receipt account IDs are immutable history and must remain after hard account deletion');
});

test('legacy Query-package preassignment repair is fail-closed and fully audited', async () => {
  const sql = await migration('0033_query_package_preassignment_repair');

  assert.match(sql, /WITH candidates AS MATERIALIZED/u,
    'candidate selection and mutation must share one statement snapshot');
  assert.match(sql, /FOR UPDATE OF task/u,
    'candidate tasks must be locked before their assignment metadata is cleared');
  assert.match(sql, /task\.source_query_package_id IS NOT NULL/u);
  assert.match(sql, /task\.source_query_package_item_id IS NOT NULL/u);
  assert.match(sql, /task\.production_batch_id IS NOT NULL/u);
  assert.match(sql, /batch_item\.task_id = task\.id/u);
  assert.match(sql, /batch_item\.production_batch_id = task\.production_batch_id/u);
  assert.match(sql, /batch_item\.source_query_package_item_id = task\.source_query_package_item_id/u);
  assert.match(sql, /batch\.query_package_id = task\.source_query_package_id/u,
    'all Query-package and production-batch lineage must agree');

  assert.match(sql, /task\.assigned_to_user_id IS NOT NULL/u);
  assert.match(sql, /task\.assignment_source = 'MANUAL'/u);
  assert.match(sql, /task\.assigned_at = task\.created_at/u,
    'only the legacy creation-time assignment signature is safe to repair');
  assert.match(sql, /COALESCE\(task\.skip_copy_review, false\) = false/u);
  assert.match(sql, /NOT EXISTS \([\s\S]*FROM task_assignment_events AS assignment_event[\s\S]*assignment_event\.task_id = task\.id/u,
    'a later manual or automatic assignment must always win');
  assert.match(
    sql,
    /task\.state IN \('COPY_QUEUED', 'COPY_RUNNING', 'COPY_FAILED'\)[\s\S]*task\.state = 'COPY_REVIEW_PENDING'[\s\S]*task\.current_stage = 'COPY_REVIEW_PENDING'/u,
  );
  assert.doesNotMatch(sql, /'IMAGE_(?:QUEUED|RUNNING|FAILED)'|'DELIVERY_REVIEW_PENDING'|'COMPLETED'|'CANCELLED'/u,
    'the repair must not clear an owner after the copy-review boundary');

  assert.match(sql, /SET assigned_to_user_id = NULL,[\s\S]*assignment_source = NULL,[\s\S]*assigned_at = NULL/u,
    'the assignment metadata triplet must be cleared atomically');
  assert.match(sql, /WHEN task\.state = 'COPY_REVIEW_PENDING'[\s\S]*文案生成完成，等待分配负责人后审核/u);
  assert.match(sql, /INSERT INTO task_assignment_events/u);
  assert.match(sql, /cleared\.previous_assignee_user_id,[\s\S]*NULL,[\s\S]*'MANUAL'/u);
  assert.match(sql, /'migration-0033-query-preassignment'/u);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+tasks|TRUNCATE\s+tasks/u);
});
