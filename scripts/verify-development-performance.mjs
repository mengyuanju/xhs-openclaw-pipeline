import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import JSZip from 'jszip';
import { developmentConfigurations } from './apply-development-scaling.mjs';
import { databaseIdentity } from './start-development.mjs';
import { normalizePerformanceFilters } from '../src/operator-performance.mjs';
import { readSqlOperatorSnapshot } from '../server/src/operator-performance-sql.mjs';
import { readSqlAnnotationJobReport } from '../server/src/annotation-job-report-query.mjs';

// Reads existing development data. Only download-derived temporary ZIPs may be created by HTTP.
const { dev, prod } = developmentConfigurations();
assert.equal(databaseIdentity(dev.connectionString).database, 'xhs_control');
assert.notEqual(databaseIdentity(dev.connectionString).database, databaseIdentity(prod.connectionString).database);
const pool = new pg.Pool({ connectionString: dev.connectionString, max: 2, statement_timeout: 30_000 });
const origin = 'http://127.0.0.1:4311';
const report = { developmentOnly: true, businessWrites: false, modelCalls: 0, checks: [], comparisons: [], http: [] };
let client;
try {
  client = await pool.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, 'xhs_control');
  const admin = (await client.query("SELECT id,username,role,credential_version FROM app_users WHERE role='ADMIN' AND status='ACTIVE' AND NOT must_change_password ORDER BY id LIMIT 1")).rows[0];
  assert.ok(admin);
  const clock = (await client.query('SELECT at,at::text AS cutoff FROM (SELECT clock_timestamp() AS at) c')).rows[0];
  const asOf = clock.at.toISOString();
  for (const input of [{ period: '7d' }, { period: '7d', activity: 'PRODUCTION', stage: 'COPY' }, { period: '7d', activity: 'QA' }]) {
    const filters = normalizePerformanceFilters(input);
    const started = performance.now();
    const projected = await readSqlOperatorSnapshot(client, filters, asOf, clock.cutoff);
    const canonical = await readSqlOperatorSnapshot(client, filters, asOf, clock.cutoff, { useProjections: false });
    assert.deepEqual(projected, canonical);
    report.comparisons.push({ input, fullResponseEqual: true, durationMs: Math.round(performance.now() - started) });
  }
  const annotationFilters = normalizePerformanceFilters({ period: '7d', activity: 'PRODUCTION' });
  assert.deepEqual(await readSqlAnnotationJobReport(client, annotationFilters, asOf, undefined, clock.cutoff),
    await readSqlAnnotationJobReport(client, annotationFilters, asOf, undefined, clock.cutoff, { useProjections: false }));
  report.checks.push('Existing development personnel and annotation report data match canonical SQL in one read-only snapshot');
  report.projections = (await client.query('SELECT count(*)::integer AS tasks,count(*) FILTER(WHERE revision=projected_revision)::integer AS ready FROM report_projection_tasks')).rows[0];
  const asset = (await client.query("SELECT a.id FROM assets a JOIN tasks t ON t.id=a.task_id WHERE t.task_kind='CONTENT' AND a.content_cleared_at IS NULL AND a.media_type='image/png' ORDER BY a.id DESC LIMIT 1")).rows[0];
  const delivery = (await client.query("SELECT t.id FROM tasks t JOIN delivery_entries d ON d.task_id=t.id AND d.status='READY' WHERE t.state='REVIEWED' AND t.task_kind='CONTENT' ORDER BY t.id DESC LIMIT 1")).rows[0];
  await client.query('COMMIT'); client.release(); client = undefined;
  const headers = { 'x-actor-user-id': String(admin.id), 'x-actor-username': admin.username,
    'x-actor-role': admin.role, 'x-actor-credential-version': String(admin.credential_version) };
  async function get(path) {
    const started = performance.now(), response = await fetch(origin + path, { headers, signal: AbortSignal.timeout(60_000) });
    assert.ok(response.ok, `${path}: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    report.http.push({ path, durationMs: Math.round(performance.now() - started), bytes: bytes.length });
    return { response, bytes, data: response.headers.get('content-type')?.includes('json') ? JSON.parse(bytes).data : undefined };
  }
  const first = await get('/v1/admin/operator-performance?period=7d&refresh=true');
  const repeat = await get('/v1/admin/operator-performance?period=7d');
  assert.equal(first.data.asOf, repeat.data.asOf, 'cached response retains its actual fact cutoff');
  assert.equal(first.data.metricVersion, repeat.data.metricVersion);
  const csv = await get(`/v1/admin/operator-performance/export?snapshotToken=${encodeURIComponent(first.data.snapshotToken)}`);
  assert.match(csv.response.headers.get('content-type'), /csv/u); assert.ok(csv.bytes.length > 10);
  await get('/v1/admin/annotation-job-report?period=7d&refresh=true');
  const paths = ['/v1/tasks?limit=20&includeTotal=true', '/v1/delivery-pool?limit=20&includeTotal=true',
    '/v1/personal-workspace/tasks?personalScope=ASSIGNED&pageSize=20', '/v1/admin/operator-performance?period=7d',
    '/v1/admin/annotation-job-report?period=7d'];
  const started = performance.now();
  await Promise.all(Array.from({ length: 30 }, (_, index) => get(paths[index % paths.length])));
  report.concurrentRead = { requests: 30, distinctAccounts: 1, durationMs: Math.round(performance.now() - started), scope: 'existing development data and authenticated administrator; 30 distinct-user writes verified separately in isolated PostgreSQL' };
  if (asset) {
    const thumbnail = await get(`/v1/assets/${asset.id}?variant=thumbnail`);
    assert.match(thumbnail.response.headers.get('content-type'), /^image\//u);
    report.checks.push('Existing image asset thumbnail endpoint returns a real image');
  }
  if (delivery) {
    const archive = await get(`/v1/tasks/${delivery.id}/archive`);
    assert.match(archive.response.headers.get('content-disposition'), /^attachment/u);
    const zip = await JSZip.loadAsync(archive.bytes);
    assert.ok(Object.keys(zip.files).length > 1);
    report.archive = { taskId: Number(delivery.id), files: Object.keys(zip.files), bytes: archive.bytes.length };
    report.checks.push('Actual reviewed development task downloads a valid complete ZIP');
  }
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = String(error.message).replace(/postgres(?:ql)?:\/\/[^\s]+/gu, '[database URL]'); process.exitCode = 1;
} finally {
  if (client) { await client.query('ROLLBACK').catch(() => {}); client.release(); }
  await pool.end(); report.completedAt = new Date().toISOString();
  await writeFile('reports/performance-round2-development-verification.json', JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ passed: report.passed, comparisons: report.comparisons.length, requests: report.http.length, archive: Boolean(report.archive), error: report.error }));
