import assert from 'node:assert/strict';
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { normalizePerformanceFilters } from '../../src/operator-performance.mjs';
import { readSqlOperatorSnapshot } from '../src/operator-performance-sql.mjs';

async function activeFixtureRecord() {
  for (const name of ['scalability-fixture-2026-10-01.json','scalability-benchmark-2026-10-01.json']) {
    try {
      const record = JSON.parse(await readFile(resolve('reports', name), 'utf8'));
      if (['running','ready'].includes(record.status)) return record;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('No active disposable fixture record exists');
}

export async function verifyScalableReport(pool) {
  const filters = normalizePerformanceFilters({ period: 'custom', from: '2026-09-20', to: '2026-09-20', activity: 'PRODUCTION' });
  const expected = Number((await pool.query("SELECT count(*) AS total FROM operator_performance_events WHERE event_key LIKE 'benchmark-submit:%'")).rows[0].total);
  assert.ok(expected > 50_000, 'the report fixture must cross the previous 50k boundary');
  const started = performance.now();
  const snapshot = await readSqlOperatorSnapshot(pool, filters, new Date().toISOString());
  assert.equal(snapshot.summary.submitted, expected);
  assert.equal(snapshot.summary.submissions, expected);
  assert.equal(snapshot.summary.COPY.submitted, expected);
  assert.equal(snapshot.people.reduce((sum,person) => sum + person.submissions, 0), expected);
  assert.equal(snapshot.rows.length, 0, 'aggregation must not download all source facts');
  assert.equal(snapshot.trend.reduce((sum,day) => sum + day.submitted, 0), expected);
  return { expectedFacts: expected, submitted: snapshot.summary.submitted, submissions: snapshot.summary.submissions,
    peopleSubmissions: snapshot.people.reduce((sum,person) => sum + person.submissions, 0), people: snapshot.people.length,
    sourceFactsDownloaded: snapshot.rows.length, trendSubmitted: snapshot.trend.reduce((sum,day) => sum + day.submitted, 0),
    durationMs: Math.round(performance.now() - started), payloadBytes: Buffer.byteLength(JSON.stringify(snapshot)) };
}

// Optional companion for a benchmark that was already running when reporting
// changes landed. Derive the port only from the helper's new temporary directory;
// require its creation time, data_directory and unique fixture application name.
// No external database URL or real development/production configuration is read.
export async function runningTemporaryFixture({ max = 1, statementTimeoutMs = 120_000,
  applicationName = 'xhs-isolated-report-check' } = {}) {
  assert.ok(Number.isSafeInteger(max) && max > 0 && max <= 30);
  assert.ok(Number.isSafeInteger(statementTimeoutMs) && statementTimeoutMs > 0 && statementTimeoutMs <= 120_000);
  const benchmark = await activeFixtureRecord();
  assert.equal(benchmark.safety.isolatedTemporaryPostgres, true);
  const from = Date.parse(benchmark.startedAt), candidates = [];
  for (const name of await readdir(tmpdir())) {
    if (!name.startsWith('xhs-personal-workspace-pg18-')) continue;
    const directory = join(tmpdir(), name), details = await stat(directory);
    if (details.birthtimeMs < from - 1000 || details.birthtimeMs > from + 30_000) continue;
    const dataDirectory = await realpath(join(directory, 'data'));
    try {
      const lines = (await readFile(join(dataDirectory, 'postmaster.pid'), 'utf8')).trim().split(/\r?\n/u);
      assert.equal(await realpath(lines[1]), dataDirectory);
      const port = Number(lines[3]);
      assert.ok(Number.isSafeInteger(port) && port > 0 && port < 65536);
      candidates.push({ dataDirectory, port });
    } catch { /* Stopped disposable clusters have no valid PID file. */ }
  }
  assert.equal(candidates.length, 1, 'must uniquely identify this benchmark helper cluster');
  const candidate = candidates[0];
  const pool = new pg.Pool({ host: '127.0.0.1', port: candidate.port, user: 'postgres', database: 'postgres', max,
    connectionTimeoutMillis: 5000, statement_timeout: statementTimeoutMs, application_name: applicationName });
  try {
    const dataDirectory = (await pool.query("SELECT current_setting('data_directory') AS directory")).rows[0].directory;
    assert.equal(await realpath(dataDirectory), candidate.dataDirectory);
    const fixture = await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='xhs-isolated-million-fixture') AS active");
    if (!fixture.rows[0].active) {
      // The loader's idle pool can close its last backend while it holds the
      // fixture for companions. The owned directory's unique creation time,
      // PID and SQL data_directory checks remain mandatory; also verify this
      // disposable postmaster started with the current fixture, not a restart.
      const started = Date.parse((await pool.query('SELECT pg_postmaster_start_time() AS started')).rows[0].started);
      assert.ok(started >= from - 1000 && started <= from + 30_000,
        'temporary postmaster must belong to this exact fixture initialization');
    }
    assert.equal(Number((await pool.query("SELECT count(*) AS total FROM app_users WHERE username LIKE 'bench%'")).rows[0].total), 30);
    return pool;
  } catch (error) { await pool.end(); throw error; }
}

export async function waitForFixture() {
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const benchmark = await activeFixtureRecord();
    if (benchmark.phases.some(phase => phase.name === 'vacuum and analyze temporary fixtures')) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 1000));
  }
  throw new Error('temporary fixture was not ready within 30 minutes');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let pool;
  try {
    await waitForFixture();
    pool = await runningTemporaryFixture();
    const result = await verifyScalableReport(pool);
    await writeFile(resolve('reports/scalability-report-2026-10-01.json'), `${JSON.stringify({ status: 'passed',
      isolatedTemporaryPostgres: true, measuredAt: new Date().toISOString(), ...result }, null, 2)}\n`);
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await pool?.end(); }
}
