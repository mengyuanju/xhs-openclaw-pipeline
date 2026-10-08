import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { httpBenchmark } from './scalability-benchmark.mjs';
import { runningTemporaryFixture, waitForFixture } from './scalability-report-check.mjs';

// Reads use only the strictly identified, owned disposable fixture. There is no
// option to target a configured development/production URL.
const report = { startedAt: new Date().toISOString(), status: 'running', isolatedTemporaryPostgres: true,
  poolMax: 10, simultaneousUsers: 30, measurements: {} };
let pool;
try {
  await waitForFixture();
  pool = await runningTemporaryFixture({ max: 10, statementTimeoutMs: 30_000, applicationName: 'xhs-isolated-http-10' });
  report.statementTimeout = (await pool.query("SELECT current_setting('statement_timeout') AS value")).rows[0].value;
  assert.equal(report.statementTimeout, '30s');
  const actors = (await pool.query("SELECT id,username,role,credential_version FROM app_users WHERE username LIKE 'bench%' ORDER BY username")).rows;
  for (const name of ['firstRead','repeatedRead']) {
    console.log(`Starting 30-user ${name} with pool 10`);
    report.measurements[name] = await httpBenchmark(pool, actors, 10);
    await writeFile(resolve('reports/scalability-http-2026-10-01.json'), `${JSON.stringify(report, null, 2)}\n`);
    assert.equal(report.measurements[name].failures.length, 0);
    console.log(JSON.stringify({ name, combined: report.measurements[name].combined,
      routes: report.measurements[name].routes, errors: report.measurements[name].failures.length }));
  }
  report.status = 'passed';
  report.correctnessStatus = 'passed';
  report.latencyAcceptance = { status: Object.values(report.measurements).every(
    measurement => measurement.latencyAcceptance.status === 'passed') ? 'passed' : 'failed',
    phases: Object.fromEntries(Object.entries(report.measurements).map(([name, measurement]) => [name, measurement.latencyAcceptance])) };
  console.log(`Correctness ${report.correctnessStatus}; latency ${report.latencyAcceptance.status}.`);
} catch (error) { report.status = 'failed'; report.error = error.message; console.error(error.message); process.exitCode = 1; }
finally {
  await pool?.end(); report.finishedAt = new Date().toISOString();
  await writeFile(resolve('reports/scalability-http-2026-10-01.json'), `${JSON.stringify(report, null, 2)}\n`);
}
