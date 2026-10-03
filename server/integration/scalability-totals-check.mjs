import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { verifyHistory } from './scalability-benchmark.mjs';
import { runningTemporaryFixture, waitForFixture } from './scalability-report-check.mjs';

const report = { status: 'running', startedAt: new Date().toISOString(), isolatedTemporaryPostgres: true,
  measurementScope: 'first application-cache read and repeated reads; OS/PG caches are not flushed' };
let pool;
try {
  await waitForFixture();
  pool = await runningTemporaryFixture({ max: 10,statementTimeoutMs: 30_000,applicationName: 'xhs-isolated-totals' });
  const repository = new PostgresControlPlaneRepository({ pool });
  const admin = { userId: 1,username: 'admin',role: 'ADMIN',credentialVersion: 1 };
  report.millionTaskTotals = {};
  for (const [name,refreshTotal] of [['firstApplicationCacheColdMs',true],['populateApplicationCacheMs',false],
    ['cachedTotalWarmMs',false],['uncachedExactTotalWarmMs',true]]) {
    const started = performance.now();
    const result = await repository.listTasks({ includeTotal: true,refreshTotal,countCacheIdentity: admin,limit: 50 });
    assert.equal(result.total,1_000_000); assert.equal(result.items.length,50);
    report.millionTaskTotals[name] = Number((performance.now()-started).toFixed(2));
  }
  report.millionTaskTotals.exactTotal = 1_000_000;
  report.historyBeyond50k = await verifyHistory(repository);
  report.status = 'passed';
  console.log(JSON.stringify(report));
} catch (error) { report.status = 'failed';report.error = error.message;console.error(error.message);process.exitCode = 1; }
finally {
  await pool?.end();report.finishedAt = new Date().toISOString();
  await writeFile(resolve('reports/scalability-totals-2026-10-01.json'),`${JSON.stringify(report,null,2)}\n`);
}
