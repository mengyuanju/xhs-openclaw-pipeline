import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';

test('current copy ancestry bounds content payloads while preserving long chains, cycles and nearest return', {
  skip: process.env.RUN_SCALABLE_POSTGRES !== '1', timeout: 120_000,
}, async () => {
  let sql;
  const capture = new PostgresControlPlaneRepository({ pool: { async query(source) {
    if (String(source).includes('THEN revision.content END')) sql = source;
    return { rows: [] };
  } } });
  await capture.getTask(1, { historyMode: 'current' });
  assert.ok(sql);
  const database = await startTemporaryPostgres18();
  const pool = new pg.Pool({ connectionString: database.connectionString, statement_timeout: 10_000 });
  try {
    await pool.query(`CREATE TABLE tasks(id bigint PRIMARY KEY,current_copy_revision_id bigint,
        current_image_run_id uuid,image_rework_source_run_id uuid);
      CREATE TABLE copy_revisions(id bigint PRIMARY KEY,task_id bigint NOT NULL,revision bigint NOT NULL,
        parent_revision_id bigint,revision_origin text,content_cleared_at timestamptz,
        execution_id uuid,content jsonb NOT NULL DEFAULT '{"copy":{"title":"Original"},"imagePlan":[]}',
        approved_at timestamptz,approval_mode text,approved_by_node_id text,
        copy_content_changed_from_machine boolean DEFAULT false,copy_rework_satisfied boolean DEFAULT false,
        created_at timestamptz DEFAULT now());
      CREATE TABLE image_runs(id uuid PRIMARY KEY,task_id bigint,copy_revision_id bigint,content_cleared_at timestamptz)`);
    await pool.query(`INSERT INTO tasks(id,current_copy_revision_id) VALUES(1,60001),(2,100003),(3,200003);
      INSERT INTO copy_revisions(id,task_id,revision,parent_revision_id,revision_origin,content)
        SELECT g,1,g,NULLIF(g-1,0),'HUMAN_EDIT',jsonb_build_object('copy',jsonb_build_object('title','Version '||g),
          'imagePlan','[]'::jsonb,'largePayload',repeat('x',4096)) FROM generate_series(1,60001) g;
      INSERT INTO copy_revisions(id,task_id,revision,parent_revision_id,revision_origin,content_cleared_at) VALUES
        (100001,2,1,100003,'HUMAN_EDIT',NULL),(100002,2,2,100001,'HUMAN_EDIT',NULL),(100003,2,3,100002,'HUMAN_EDIT',NULL),
        (200001,3,1,NULL,'GENERATION',NULL),(200002,3,2,200001,'QA_RETURN',NULL),(200003,3,3,200002,'HUMAN_EDIT',NULL);
      UPDATE copy_revisions SET content='{"copy":{"title":"Original"},"imagePlan":[],"qualityReturn":{"target":"COPY"}}'
        WHERE id=200002;
      UPDATE copy_revisions SET content='{"copy":{"title":"Edited"},"imagePlan":[]}' WHERE id=200003;
      INSERT INTO image_runs VALUES('11111111-1111-4111-8111-111111111111',1,30000,NULL);
      UPDATE tasks SET current_image_run_id='11111111-1111-4111-8111-111111111111' WHERE id=1`);
    const started = performance.now();
    const long = (await pool.query(sql, [1])).rows;
    const longReadMs = Number((performance.now() - started).toFixed(2));
    assert.equal(long.length, 60001, 'parent ancestry is not silently truncated at an arbitrary cap');
    assert.equal(new Set(long.map(row => row.id)).size, 60001);
    assert.deepEqual(long.filter(row => row.content != null).map(row => row.id), ['60001','30000'],
      'only the current copy and pinned current-image copy download full JSON content');
    const fullPayloadBytes = Buffer.byteLength(JSON.stringify(long.filter(row => row.content != null).map(row => row.content)));
    assert.ok(fullPayloadBytes < 10_000, '60k ancestors must not download their combined 240MB source payload');
    assert.deepEqual((await pool.query(sql, [2])).rows.map(row => row.id), ['100003','100002','100001'],
      'cycles terminate without accumulating repeated path arrays');
    assert.deepEqual((await pool.query(sql, [3])).rows.map(row => row.id), ['200003','200002'],
      'the nearest return starts the current rework round');
    await pool.query(`INSERT INTO image_runs VALUES('22222222-2222-4222-8222-222222222222',3,200001,NULL);
      UPDATE tasks SET image_rework_source_run_id='22222222-2222-4222-8222-222222222222' WHERE id=3`);
    assert.deepEqual((await pool.query(sql,[3])).rows.filter(row => row.content != null).map(row => row.id),
      ['200003','200002','200001'], 'the rework source image preserves its older pinned copy outside the current return chain');
    const repository = new PostgresControlPlaneRepository({ pool: { async query(source, values) {
      if (String(source).includes('THEN revision.content END')) return pool.query(source, values);
      if (String(source).includes('WITH task AS')) return { rows: [{ id: 3,current_copy_revision_id: 200003,
        state: 'COPY_REVIEW_PENDING',mandatory_copy_qc: true,created_at: new Date(),updated_at: new Date() }] };
      return { rows: [] };
    } } });
    const detail = await repository.getTask(3, { historyMode: 'current' });
    assert.equal(detail.copyRevisions[0].content.copy.title, 'Edited');
    assert.equal(detail.copyRevisions[1].content.copy.title, 'Original');
    assert.equal(detail.copyRevisions[0].copyReworkSatisfied, true, 'live diff uses the original complete baseline content');
    assert.equal(detail.copyRevisions[0].reworkTarget, 'COPY');
    await mkdir(resolve('reports'),{ recursive: true });
    await writeFile(resolve('reports/scalability-current-lineage-2026-10-01.json'),`${JSON.stringify({
      status: 'passed',isolatedTemporaryPostgres: true,measuredAt: new Date().toISOString(),
      ancestorRows: long.length,longReadMs,fullContentIds: ['60001','30000'],fullContentBytes: fullPayloadBytes,
      sourceContentBytesAtLeast: 60_001 * 4096,cyclesTerminate: true,nearestReturnBaselinePreserved: true,
      currentImagePinnedCopyPreserved: true,reworkSourceImagePinnedCopyPreserved: true,
      liveReworkDiffSatisfied: detail.copyRevisions[0].copyReworkSatisfied,
    },null,2)}\n`);
  } finally { await pool.end(); await database.stop(); }
});
