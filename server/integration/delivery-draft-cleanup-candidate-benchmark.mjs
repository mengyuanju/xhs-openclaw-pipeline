import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { startTemporaryPostgres18 } from '../tests/temporary-postgres18.mjs';
import { drainDeliveredCopyReviewDrafts } from '../src/delivery-draft-cleanup.mjs';

// The default measures the current implementation. --baseline replays the
// recorded pre-fix SQL without changing the original evidence file.
const boundedMode = !process.argv.includes('--baseline');
const reportPath = resolve(boundedMode
  ? 'reports/delivery-draft-cleanup-candidate-million-bounded.json'
  : 'reports/delivery-draft-cleanup-candidate-million-baseline-rerun.json');
const report = {
  createdAt: new Date().toISOString(),
  mode: boundedMode ? 'CURRENT_MODULE' : 'RECORDED_BASELINE_SQL',
  isolatedTemporaryPostgresOnly: true,
  businessDatabaseAccessed: false,
  simulationLimitations: [
    'Minimal matching relation fields and candidate indexes; no application triggers, foreign keys, model calls or business data.',
    'One million narrow synthetic REVIEWED CONTENT tasks and matching READY entries; real tasks are wider and have additional indexes.',
    'EXPLAIN ANALYZE runs inside a transaction that is rolled back; its statement timeout is extended to 60 seconds for measurement.',
    'Warm local PostgreSQL execution plans are evidence of candidate query shape, not a 30-user production latency guarantee.',
  ],
  scenarios: [],
};

function planNodes(node, result = []) {
  result.push({ type: node['Node Type'], relation: node['Relation Name'], index: node['Index Name'],
    actualRows: node['Actual Rows'], loops: node['Actual Loops'], removedByFilter: node['Rows Removed by Filter'],
    sharedHitBlocks: node['Shared Hit Blocks'], sharedReadBlocks: node['Shared Read Blocks'] });
  for (const child of node.Plans ?? []) planNodes(child, result);
  return result;
}

async function persist() {
  await mkdir(resolve('reports'), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}

async function originalCandidatePlan(realPool) {
  const baseline = JSON.parse(await readFile(resolve('reports/delivery-draft-cleanup-candidate-million.json'), 'utf8'));
  const { sql, values } = baseline.scenarios[0].original;
  const client = await realPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='60s'");
    const plan = (await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, values)).rows[0]['QUERY PLAN'][0];
    return { sql, values, executionMs: plan['Execution Time'], planningMs: plan['Planning Time'], nodes: planNodes(plan.Plan), plan };
  } finally { await client.query('ROLLBACK'); client.release(); }
}

async function boundedCandidatePlans(realPool) {
  const queries = [];
  const wrappedPool = { connect: async () => {
    const client = await realPool.connect();
    return { release: () => client.release(), async query(sql, values) {
      if (String(sql).trimStart().startsWith('SELECT') &&
          (String(sql).includes('copy_review_drafts') || String(sql).includes('FROM tasks task'))) {
        await client.query("SET LOCAL statement_timeout='60s'");
        const plan = (await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, values)).rows[0]['QUERY PLAN'][0];
        const result = await client.query(sql, values);
        queries.push({ sql, values, rowsReturned: result.rows.length, executionMs: plan['Execution Time'],
          planningMs: plan['Planning Time'], nodes: planNodes(plan.Plan), plan });
        return result;
      }
      return client.query(sql === 'COMMIT' ? 'ROLLBACK' : sql, values);
    } };
  } };
  const drainResult = await drainDeliveredCopyReviewDrafts(wrappedPool, { limit: 1, maxDurationMs: 5000 });
  assert.ok(queries.length > 0, 'Captured candidate SQL emitted by the module');
  assert.equal(drainResult.deleted, 0, 'All synthetic drafts must remain protected');
  return { drainResult, executionMs: queries.reduce((sum, query) => sum + query.executionMs, 0), queries };
}

async function alternativePlan(pool, original, { lateral = false } = {}) {
  const sql = original.sql
    .replace('SELECT task.id FROM tasks task', `WITH draft_tasks AS MATERIALIZED (
      SELECT DISTINCT task_id FROM copy_review_drafts
      WHERE task_id>$1 AND NOT(task_id=ANY($2::bigint[]))
    ) SELECT task.id FROM draft_tasks candidates ${lateral
      ? 'CROSS JOIN LATERAL (SELECT * FROM tasks WHERE id=candidates.task_id OFFSET 0) task'
      : 'JOIN tasks task ON task.id=candidates.task_id'}`)
    .replace('AND EXISTS(SELECT 1 FROM copy_review_drafts draft WHERE draft.task_id=task.id)', '');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='60s'");
    const plan = (await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, original.values)).rows[0]['QUERY PLAN'][0];
    return { sql, executionMs: plan['Execution Time'], planningMs: plan['Planning Time'], nodes: planNodes(plan.Plan), plan };
  } finally { await client.query('ROLLBACK'); client.release(); }
}

async function scenario(pool, name) {
  if (boundedMode) {
    const bounded = await boundedCandidatePlans(pool);
    report.scenarios.push({ name, bounded });
    await persist();
    console.log(JSON.stringify({ name, boundedMs: bounded.executionMs, drainResult: bounded.drainResult,
      queries: bounded.queries.map(query => ({ executionMs: query.executionMs, rowsReturned: query.rowsReturned,
        relationScans: query.nodes.filter(node => node.relation) })) }));
    return;
  }
  const original = await originalCandidatePlan(pool);
  const alternative = await alternativePlan(pool, original);
  const lateral = await alternativePlan(pool, original, { lateral: true });
  report.scenarios.push({ name, counts: (await pool.query(`SELECT
    (SELECT count(*) FROM tasks)::integer AS tasks,
    (SELECT count(*) FROM copy_review_drafts)::integer AS drafts,
    (SELECT count(*) FROM delivery_entries)::integer AS deliveries`)).rows[0], original, alternative, lateral });
  await persist();
  console.log(JSON.stringify({ name, originalMs: original.executionMs, alternativeMs: alternative.executionMs, lateralMs: lateral.executionMs,
    originalNodes: original.nodes.map(({ type, relation, actualRows, loops, removedByFilter }) => ({ type, relation, actualRows, loops, removedByFilter })) }));
}

const cluster = await startTemporaryPostgres18('xhs-draft-cleanup-plan-pg18-');
const pool = new pg.Pool({ connectionString: cluster.connectionString, max: 2 });
try {
  report.postgresVersion = (await pool.query('SELECT version() AS version')).rows[0].version;
  await pool.query(`CREATE TABLE tasks (
      id bigint PRIMARY KEY, state text NOT NULL, task_kind text NOT NULL,
      input jsonb NOT NULL, current_copy_revision_id bigint, current_image_run_id uuid,
      image_qc_legacy_accepted boolean NOT NULL, image_qc_released_approval_event_id bigint
    );
    CREATE INDEX tasks_content_state_idx ON tasks(state,id) WHERE task_kind='CONTENT';
    CREATE TABLE delivery_entries (id bigint PRIMARY KEY,task_id bigint NOT NULL,
      status text NOT NULL,copy_revision_id bigint NOT NULL,image_run_id uuid NOT NULL);
    CREATE UNIQUE INDEX delivery_entries_one_ready_task_idx ON delivery_entries(task_id) WHERE status='READY';
    CREATE TABLE image_approval_events (id bigint PRIMARY KEY,task_id bigint NOT NULL,
      copy_revision_id bigint NOT NULL,image_run_id uuid NOT NULL);
    CREATE TABLE copy_review_drafts (id bigserial PRIMARY KEY,task_id bigint NOT NULL,
      base_copy_revision_id bigint NOT NULL,reviewer_account_id bigint NOT NULL,draft_version integer NOT NULL,
      UNIQUE(task_id,base_copy_revision_id,reviewer_account_id,draft_version));
    CREATE INDEX copy_review_drafts_history_idx ON copy_review_drafts(task_id,base_copy_revision_id,reviewer_account_id,id DESC);`);
  await pool.query(`INSERT INTO tasks SELECT id,'REVIEWED','CONTENT','{}',id,
    '00000000-0000-4000-8000-000000000001',true,NULL FROM generate_series(1,1000000) id`);
  await pool.query(`INSERT INTO delivery_entries SELECT id,id,'READY',id,
    '00000000-0000-4000-8000-000000000001' FROM generate_series(1,1000000) id`);
  await pool.query('ANALYZE tasks; ANALYZE delivery_entries; ANALYZE image_approval_events; ANALYZE copy_review_drafts');
  await scenario(pool, 'one-million-reviewed-no-drafts');

  await pool.query("UPDATE tasks SET state='COPY_REVIEW_PENDING' WHERE id BETWEEN 1 AND 10");
  await pool.query("UPDATE tasks SET input='{\"testRun\":true}' WHERE id BETWEEN 11 AND 20");
  await pool.query('UPDATE delivery_entries SET copy_revision_id=0 WHERE task_id BETWEEN 21 AND 30');
  await pool.query('INSERT INTO copy_review_drafts(task_id,base_copy_revision_id,reviewer_account_id,draft_version) SELECT id,id,1,1 FROM generate_series(1,30) id');
  await pool.query('ANALYZE tasks; ANALYZE delivery_entries; ANALYZE copy_review_drafts');
  await scenario(pool, 'one-million-reviewed-thirty-protected-drafts');

  // GC deletion can leave recently stale statistics until auto-analyze catches up.
  await pool.query('INSERT INTO copy_review_drafts(task_id,base_copy_revision_id,reviewer_account_id,draft_version) SELECT id,id,1,1 FROM generate_series(31,20000) id');
  await pool.query('ANALYZE copy_review_drafts');
  await pool.query('DELETE FROM copy_review_drafts WHERE task_id>30');
  await scenario(pool, 'one-million-reviewed-thirty-protected-drafts-stale-20000-row-statistics');

  // Active drafts are often on recent tasks, so also test IDs near the end.
  await pool.query('DELETE FROM copy_review_drafts');
  await pool.query("UPDATE tasks SET state='REVIEWED',input='{}' WHERE id BETWEEN 1 AND 30");
  await pool.query('UPDATE delivery_entries SET copy_revision_id=task_id WHERE task_id BETWEEN 1 AND 30');
  await pool.query("UPDATE tasks SET state='COPY_REVIEW_PENDING' WHERE id BETWEEN 999971 AND 999980");
  await pool.query("UPDATE tasks SET input='{\"testRun\":true}' WHERE id BETWEEN 999981 AND 999990");
  await pool.query('UPDATE delivery_entries SET copy_revision_id=0 WHERE task_id BETWEEN 999991 AND 1000000');
  await pool.query('INSERT INTO copy_review_drafts(task_id,base_copy_revision_id,reviewer_account_id,draft_version) SELECT id,id,1,1 FROM generate_series(999971,1000000) id');
  await pool.query('ANALYZE tasks; ANALYZE delivery_entries; ANALYZE copy_review_drafts');
  await scenario(pool, 'one-million-reviewed-thirty-protected-recent-drafts');

  await pool.query('INSERT INTO copy_review_drafts(task_id,base_copy_revision_id,reviewer_account_id,draft_version) SELECT id,id,1,1 FROM generate_series(1,20000) id');
  await pool.query('ANALYZE copy_review_drafts');
  await pool.query('DELETE FROM copy_review_drafts WHERE task_id<=20000');
  await scenario(pool, 'one-million-reviewed-thirty-protected-recent-drafts-stale-low-id-statistics');
  report.completedAt = new Date().toISOString();
  await persist();
} catch (error) {
  report.failedAt = new Date().toISOString(); report.error = error.message; await persist(); throw error;
} finally { await pool.end(); await cluster.stop(); }
