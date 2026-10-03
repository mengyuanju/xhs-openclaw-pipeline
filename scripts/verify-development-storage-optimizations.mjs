import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { developmentConfigurations } from './apply-development-scaling.mjs';
import { readBackup, rowBatches, packagePath, safeError } from '../server/scripts/database-common.mjs';
import { hydrateExecutionSnapshots } from '../server/src/execution-snapshot-storage.mjs';
import { hydrateCopyReviewDrafts } from '../server/src/copy-review-draft-archive.mjs';
import { getModelCall } from '../server/src/model-call-traces.mjs';

// Compare every pre-maintenance body without printing or copying application data.
const { dev, prod } = developmentConfigurations();
const application = JSON.parse(await readFile(resolve('reports/storage-optimizations-development.json'), 'utf8'));
assert.equal(application.target, dev.display);
assert.equal(application.developmentAfter?.database, 'xhs_control');
assert.ok(Object.values(application.developmentBefore.schema).every(value => value === false),
  'This verification requires the original pre-optimization hot-body backup');
const { root, manifest } = await readBackup(application.backup.folder);
assert.equal(manifest.databaseName, 'xhs_control');
const pool = new pg.Pool({ connectionString: dev.connectionString, max: 1,
  application_name: 'storage-roundtrip-read-only', options: '-c default_transaction_read_only=on' });
const client = await pool.connect();
const report = { startedAt: new Date().toISOString(), developmentOnly: true, readOnly: true,
  modelCalls: 0, checked: { snapshots: 0, modelCalls: 0, drafts: 0 }, concurrent: null, passed: false };

async function* batches(table, size = 50) {
  const entry = manifest.tables.find(item => item.schema === 'public' && item.name === table);
  assert.ok(entry, `Backup table missing: ${table}`);
  for await (const rows of rowBatches(packagePath(root, entry.file), size)) yield rows.map(row => JSON.parse(row));
}

try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, 'xhs_control');
  assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
  await client.query("SET LOCAL statement_timeout='30s'");
  for await (const before of batches('task_executions')) {
    const rows = await hydrateExecutionSnapshots(client, (await client.query(
      'SELECT * FROM task_executions WHERE id=ANY($1::uuid[])', [before.map(row => row.id)])).rows);
    const current = new Map(rows.map(row => [row.id, row]));
    for (const expected of before) {
      const actual = current.get(expected.id);
      assert.ok(actual, `Execution disappeared: ${expected.id}`);
      assert.ok(isDeepStrictEqual(actual.snapshot, expected.snapshot), `Execution snapshot roundtrip differs: ${expected.id}`);
      report.checked.snapshots++;
    }
  }
  for await (const before of batches('copy_review_drafts')) {
    const rows = await hydrateCopyReviewDrafts(client, (await client.query(
      'SELECT * FROM copy_review_drafts WHERE id=ANY($1::bigint[])', [before.map(row => row.id)])).rows);
    const current = new Map(rows.map(row => [String(row.id), row]));
    for (const expected of before) {
      const actual = current.get(String(expected.id));
      assert.ok(actual, `Draft disappeared: ${expected.id}`);
      assert.ok(isDeepStrictEqual(actual.content, expected.content), `Draft content roundtrip differs: ${expected.id}`);
      for (const key of ['base_copy_revision_id', 'reviewer_account_id', 'draft_version']) {
        assert.equal(String(actual[key]), String(expected[key]), `Draft metadata differs: ${expected.id}/${key}`);
      }
      report.checked.drafts++;
    }
  }
  for await (const before of batches('model_call_traces')) {
    for (const expected of before) {
      const actual = await getModelCall(client, expected.task_id, expected.id);
      for (const key of ['prompt', 'request', 'response', 'error', 'status', 'truncated']) {
        assert.ok(isDeepStrictEqual(actual[key], expected[key]), `Model call roundtrip differs: ${expected.id}/${key}`);
      }
      report.checked.modelCalls++;
    }
  }
  const admin = (await client.query(`SELECT id,username,role,credential_version FROM app_users
    WHERE role='ADMIN' AND status='ACTIVE' AND NOT must_change_password ORDER BY id LIMIT 1`)).rows[0];
  assert.ok(admin);
  const cold = (await client.query(`SELECT task_id,id FROM model_call_traces WHERE payload_archived ORDER BY id LIMIT 10`)).rows;
  const executions = (await client.query(`SELECT task_id,id FROM task_executions
    WHERE snapshot_prompts_hash IS NOT NULL AND content_cleared_at IS NULL ORDER BY id LIMIT 10`)).rows;
  assert.ok(cold.length && executions.length, 'Cold model calls and referenced execution snapshots are required for this probe');
  await client.query('COMMIT');
  const jobs = Array.from({ length: 30 }, (_, index) => {
    if (index % 3 === 0 && cold.length) {
      const row = cold[index % cold.length];
      return `/v1/tasks/${row.task_id}/model-calls/${row.id}`;
    }
    if (index % 3 === 1 && executions.length) {
      const row = executions[index % executions.length];
      return `/v1/tasks/${row.task_id}/history/executions/${row.id}`;
    }
    return '/v1/tasks?limit=20&includeTotal=true';
  });
  const started = performance.now();
  const timings = await Promise.all(jobs.map(async path => {
    const at = performance.now();
    const response = await fetch(`http://127.0.0.1:4311${path}`, { headers: {
      'X-Actor-User-Id': String(admin.id), 'X-Actor-Username': admin.username,
      'X-Actor-Role': admin.role, 'X-Actor-Credential-Version': String(admin.credential_version),
    }, signal: AbortSignal.timeout(60_000) });
    const body = await response.json();
    assert.ok(response.ok, `Read failed: ${path}: ${response.status}/${body.error?.code ?? ''}`);
    assert.ok(body.data);
    return performance.now() - at;
  }));
  timings.sort((left, right) => left - right);
  report.concurrent = { requests: 30, distinctAccounts: 1, elapsedMs: +(performance.now() - started).toFixed(2),
    p95Ms: +timings[Math.ceil(timings.length * .95) - 1].toFixed(2), maxMs: +timings.at(-1).toFixed(2),
    kinds: { coldModelDetails: 10, singleExecutionDetails: 10, taskLists: 10 },
    description: 'Actual development data; ten cold model details, ten individual restored execution snapshots and ten list requests' };
  report.passed = true;
} catch (error) {
  report.error = safeError(safeError(error, prod), dev);
  process.exitCode = 1;
} finally {
  await client.query('ROLLBACK').catch(() => {}); client.release(); await pool.end();
  report.completedAt = new Date().toISOString();
  await mkdir(resolve('reports'), { recursive: true });
  await writeFile(resolve('reports/storage-roundtrip-development.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report));
