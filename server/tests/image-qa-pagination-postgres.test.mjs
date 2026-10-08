import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { startTemporaryPostgres18 } from './temporary-postgres18.mjs';
import { listImageQaItems, disposeImageQualityTailDrain } from '../src/image-quality-control.mjs';

test('image QA pages and full counters agree with the legacy read on isolated PostgreSQL', {
  skip: process.env.RUN_POSTGRES_E2E !== '1', timeout: 180_000,
}, async () => {
  const postgres = await startTemporaryPostgres18('xhs-image-qa-page-');
  const pool = new Pool({ connectionString: postgres.connectionString });
  const admin = { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 };
  const reviewer = { userId: 2, username: 'reviewer', role: 'REVIEWER', credentialVersion: 1 };
  try {
    await pool.query(`
      CREATE TABLE app_users(id bigint PRIMARY KEY, username text, display_name text, role text,
        status text DEFAULT 'ACTIVE', credential_version integer DEFAULT 1, image_qc_enabled boolean DEFAULT true, created_at timestamptz DEFAULT now());
      INSERT INTO app_users(id,username,display_name,role) VALUES (1,'admin','管理员','ADMIN'),(2,'reviewer','审核人','REVIEWER');
      CREATE TABLE tasks(id bigint PRIMARY KEY, query text, priority_paused boolean, state text, source_query_package_name text, priority_sort_at timestamptz);
      CREATE TABLE image_runs(id bigint PRIMARY KEY,task_id bigint,result jsonb);
      CREATE TABLE image_sampling_freezes(id bigint PRIMARY KEY,public_id uuid,blind_review_enabled boolean,production_batch_id bigint);
      CREATE TABLE image_approval_events(id bigint PRIMARY KEY,task_id bigint,image_run_id bigint,submitted_at timestamptz,manual_modification_note text);
      CREATE TABLE workflow_quality_settings(singleton boolean PRIMARY KEY,image_reviewer_batch_return_enabled boolean);
      INSERT INTO workflow_quality_settings VALUES(true,true);
      CREATE TABLE image_sampling_items(id bigint PRIMARY KEY,public_id uuid,freeze_id bigint,approval_event_id bigint,task_id bigint,image_run_id bigint,
        copy_revision_id bigint,submitter_account_id bigint,submitter_username text,sample_kind text,selected boolean,status text,parent_item_id bigint,
        image_set_sha256 text,reason_codes text[],note text,reviewed_at timestamptz,rework_target text,copy_fields text[],problem_asset_ids bigint[],created_at timestamptz,updated_at timestamptz);
      CREATE TABLE image_sampling_events(id bigint PRIMARY KEY,action text,sampling_item_id bigint,freeze_id bigint,created_at timestamptz,details jsonb);
      CREATE TABLE image_edit_requests(task_id bigint,source_image_run_id bigint,status text);
      CREATE TABLE image_run_asset_view(id bigint PRIMARY KEY,task_id bigint,image_run_id bigint,media_type text,sha256 text,original_name text);
      INSERT INTO tasks SELECT n,'隔离任务 '||n,n%5=0,'IMAGE_QC_PENDING',NULL,'2026-10-02'::timestamptz+(n%7)*interval '1 second' FROM generate_series(1,70)n;
      INSERT INTO image_runs SELECT n,n,jsonb_build_object('images',jsonb_build_array(
        jsonb_build_object('assetId',n*10+1),jsonb_build_object('assetId',n*10+99,'deliveryAssetId',n*10+2),jsonb_build_object('assetId',n*10+3))) FROM generate_series(1,70)n;
      INSERT INTO image_sampling_freezes SELECT n,md5('freeze'||n)::uuid,true,1 FROM generate_series(1,70)n;
      INSERT INTO image_approval_events SELECT n,n,n,'2026-10-02',NULL FROM generate_series(1,70)n;
      INSERT INTO image_sampling_items(id,public_id,freeze_id,approval_event_id,task_id,image_run_id,copy_revision_id,submitter_account_id,submitter_username,
        sample_kind,selected,status,image_set_sha256,created_at,updated_at)
        SELECT n,md5('item'||n)::uuid,n,n,n,n,n,CASE WHEN n%3=0 THEN 2 ELSE 1 END,CASE WHEN n%3=0 THEN 'reviewer' ELSE 'admin' END,
          CASE WHEN n%2=0 THEN 'MANDATORY_RECHECK' ELSE 'RANDOM' END,n<>70,CASE WHEN n<=55 THEN 'PASSED' ELSE 'DISCARDED' END,repeat('a',64),'2026-10-02','2026-10-02'
        FROM generate_series(1,70)n;
      INSERT INTO image_run_asset_view SELECT n*10+page,n,n,'image/png',repeat('b',64),'image.png' FROM generate_series(1,70)n CROSS JOIN unnest(ARRAY[1,2,99])page;
    `);
    for (const [actor, personName] of [[admin, undefined], [admin, '管理员'], [admin, 'REVIEWER'], [reviewer, undefined]]) {
      const legacy = await listImageQaItems(pool, { status: 'PASSED', personName, limit: 200 }, actor);
      const expected = { total: legacy.items.length, mandatoryCount: legacy.items.filter(item => item.sampleKind === 'MANDATORY_RECHECK').length,
        assetCount: legacy.items.reduce((sum, item) => sum + item.assets.length, 0) };
      const pages = [];
      for (let offset = 0; offset < Math.max(1, expected.total); offset += 50) {
        const page = await listImageQaItems(pool, { status: 'PASSED', personName, limit: 50, offset, includeSummary: true }, actor);
        assert.deepEqual(page.summary, expected); assert.equal(page.offset, offset); assert.ok(page.items.length <= 50);
        pages.push(...page.items);
      }
      assert.deepEqual(pages.map(item => item.id), legacy.items.map(item => item.id));
      assert.deepEqual(pages.flatMap(item => item.assets), legacy.items.flatMap(item => item.assets));
      if (actor.role === 'REVIEWER') for (const item of pages) {
        assert.equal(item.blindReview, true); assert.equal(item.submitter, undefined); assert.equal(item.query, undefined);
      }
      const clamped = await listImageQaItems(pool, { status: 'PASSED', personName, limit: 50, offset: 999, includeSummary: true }, actor);
      assert.equal(clamped.offset, Math.floor((Math.max(1, expected.total) - 1) / 50) * 50);
      assert.deepEqual(clamped.summary, expected);
    }
    const zero = await listImageQaItems(pool, { status: 'RETURNED', limit: 50, offset: 999, includeSummary: true }, admin);
    assert.deepEqual(zero.summary, { total: 0, mandatoryCount: 0, assetCount: 0 }); assert.deepEqual(zero.items, []); assert.equal(zero.offset, 0);
    await assert.rejects(listImageQaItems(pool, { personName: 'admin', includeSummary: true }, reviewer), /管理员/u);
    const direct = await pool.query("SELECT count(*) AS count FROM image_sampling_items WHERE selected AND status='PASSED'");
    assert.equal(Number(direct.rows[0].count), 55);
  } finally {
    await disposeImageQualityTailDrain(pool); await pool.end(); await postgres.stop();
  }
});
