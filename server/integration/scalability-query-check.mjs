import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { runningTemporaryFixture, waitForFixture } from './scalability-report-check.mjs';

function summarizePlan(plan) {
  const nodes = [];
  const visit = node => {
    nodes.push({ type: node['Node Type'], index: node['Index Name'], relation: node['Relation Name'],
      actualRows: node['Actual Rows'], loops: node['Actual Loops'], sortMethod: node['Sort Method'],
      readBlocks: node['Shared Read Blocks'], hitBlocks: node['Shared Hit Blocks'], heapFetches: node['Heap Fetches'] });
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(plan.Plan);
  return { planningMs: plan['Planning Time'], executionMs: plan['Execution Time'], nodes };
}

export async function verifyScalableQueries(pool) {
  const query = pool.query.bind(pool);
  const repository = new PostgresControlPlaneRepository({ pool });
  const actor = { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 };
  const cases = {}, plans = {};
  let captured;
  pool.query = (...args) => {
    if (typeof args[0] === 'string' && /FROM tasks page_task|WITH package_page AS MATERIALIZED/u.test(args[0])) captured = args;
    return query(...args);
  };
  try {
    for (const [name,filters,expected] of [
      ['stateFilteredExact', { state: 'COPY_REVIEW_PENDING' }, 199_999],
      ['rareTextSearch', { query: 'scale task 999999 searchable-pattern' }, 1],
      ['commonTextSearch', { query: 'searchable-pattern' }, 1_000_000],
      ['globalQueryDeduplication', { deduplicateQuery: true }, 1_000_000],
    ]) {
      captured = null;
      const started = performance.now();
      const result = await repository.listTasks({ ...filters, includeTotal: true, refreshTotal: true, countCacheIdentity: actor, limit: 50 });
      assert.equal(result.total, expected, `${name} total must remain exact`);
      cases[name] = { total: result.total, items: result.items.length, durationMs: Math.round(performance.now() - started) };
      if (captured) {
        const [sql,parameters] = captured;
        const explanation = await query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, parameters);
        plans[name] = summarizePlan(explanation.rows[0]['QUERY PLAN'][0]);
      }
    }
    captured = null;
    const started = performance.now();
    const packages = await repository.listQueryPackages({ limit: 20 }, { actor });
    assert.equal(packages.length, 20);
    assert.ok(packages.every(item => item.counts.total === 1000));
    cases.queryPackagePage = { items: packages.length, durationMs: Math.round(performance.now() - started) };
    if (captured) {
      const [sql,parameters] = captured;
      const explanation = await query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, parameters);
      plans.queryPackagePage = summarizePlan(explanation.rows[0]['QUERY PLAN'][0]);
    }
    const executionId = (await query("SELECT benchmark_uuid('copy-1') AS id")).rows[0].id;
    const progressSamples = [];
    for (let percent = 1; percent <= 10; percent++) {
      const started = performance.now();
      await repository.updateProgress(executionId, { stage: 'BENCHMARK_PROGRESS', progressPercent: percent,
        message: 'Synthetic progress benchmark', details: { synthetic: true } });
      progressSamples.push(Number((performance.now() - started).toFixed(2)));
    }
    cases.progressUpdates = { updates: progressSamples.length, durationsMs: progressSamples,
      meanMs: Number((progressSamples.reduce((sum,value) => sum + value, 0) / progressSamples.length).toFixed(2)) };
    return { cases, plans };
  } finally { pool.query = query; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let pool;
  const result = { isolatedTemporaryPostgres: true, status: 'running', startedAt: new Date().toISOString() };
  try {
    await waitForFixture();
    pool = await runningTemporaryFixture();
    Object.assign(result, await verifyScalableQueries(pool), { status: 'passed' });
    console.log(JSON.stringify(result.cases));
  } catch (error) { Object.assign(result, { status: 'failed', error: error.message }); console.error(error.message); process.exitCode = 1; }
  finally {
    await pool?.end(); result.finishedAt = new Date().toISOString();
    await writeFile(resolve('reports/scalability-queries-2026-10-01.json'), `${JSON.stringify(result, null, 2)}\n`);
  }
}
