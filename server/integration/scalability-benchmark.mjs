import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, release } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { startTemporaryPostgres18 } from '../tests/helpers/personal-postgres.mjs';
import { migrateDatabase } from '../src/database-migrations.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { verifyScalableReport } from './scalability-report-check.mjs';
import { verifyScalableQueries } from './scalability-query-check.mjs';

// This benchmark intentionally accepts no database URL. All SQL is restricted
// to the new disposable loopback cluster returned by the test helper.
const TASKS = 1_000_000;
const HISTORY = 60_001;
const CONCURRENCY = 30;
const fixtureOnly = process.argv.includes('--fixture');
const outputPath = resolve(fixtureOnly ? 'reports/scalability-fixture-2026-10-01.json' : 'reports/scalability-benchmark-2026-10-01.json');
const report = {
  startedAt: new Date().toISOString(), status: 'running',
  safety: { isolatedTemporaryPostgres: true, productionConnected: false, developmentConnected: false, modelCalls: 0 },
  environment: { node: process.version, platform: process.platform, osRelease: release(), cpu: cpus()[0]?.model,
    logicalCpus: cpus().length, memoryGiB: Number((totalmem() / 1024 ** 3).toFixed(2)) },
  fixture: { taskTarget: TASKS, historyVersionsTarget: HISTORY + 1, synthetic: true,
    notes: ['Bulk fixture loading disables user triggers and postpones nonunique indexes; foreign keys, unique indexes and CHECK constraints remain enabled.',
      'Traces use compressible synthetic payloads; assets contain metadata only, without real image files.',
      'First-read/cold measurements clear application caches only; the operating-system and PostgreSQL caches are not flushed.',
      'A single local machine runs database, HTTP server and clients; these results are not a production SLA.'] },
  phases: [], measurements: {}, assertions: {}, queryPlans: {},
};

async function save() {
  await mkdir(join(outputPath, '..'), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function phase(name, action) {
  console.log(`Starting ${name}`);
  const started = performance.now();
  const result = await action();
  report.phases.push({ name, durationMs: Math.round(performance.now() - started) });
  await save();
  console.log(`Completed ${name} (${report.phases.at(-1).durationMs} ms)`);
  return result;
}

function summary(samples) {
  const sorted = samples.toSorted((a, b) => a - b);
  const percentile = p => Number(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)].toFixed(2));
  return { requests: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
    minMs: Number(sorted[0].toFixed(2)), maxMs: Number(sorted.at(-1).toFixed(2)) };
}

// Correctness and latency are separate acceptance dimensions. These local
// engineering targets are explicit and are not a promised production SLA.
export function latencyAcceptance(measurements) {
  const targets = { assignedList: 1000, currentDetail: 1000, historyMetadata: 1000,
    queryPackages: 1000, personalWorkspace: 2000 };
  const routes = Object.entries(measurements.routes ?? {}).map(([route, value]) => ({
    route, targetP95Ms: targets[route], measuredP95Ms: value.p95Ms,
    passed: value.p95Ms <= targets[route],
  }));
  return { status: routes.length && routes.every(route => route.passed) ? 'passed' : 'failed',
    scope: 'local synthetic fixture; engineering targets, not a production SLA', routes };
}

async function timed(action) {
  const started = performance.now();
  const value = await action();
  return { value, ms: Number((performance.now() - started).toFixed(2)) };
}

function planSummary(plan) {
  const nodes = [];
  const visit = node => {
    nodes.push({ nodeType: node['Node Type'], relation: node['Relation Name'], index: node['Index Name'],
      actualRows: node['Actual Rows'], actualLoops: node['Actual Loops'], rowsRemoved: node['Rows Removed by Filter'],
      sharedHitBlocks: node['Shared Hit Blocks'], sharedReadBlocks: node['Shared Read Blocks'],
      sortMethod: node['Sort Method'], sortSpaceKb: node['Sort Space Used'] });
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(plan.Plan);
  return { planningMs: plan['Planning Time'], executionMs: plan['Execution Time'], nodes };
}

async function explain(pool, sql, parameters = []) {
  const result = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, parameters);
  return planSummary(result.rows[0]['QUERY PLAN'][0]);
}

async function loadFixture(pool) {
  const deferredIndexes = await phase('postpone temporary fixture nonunique indexes', async () => {
    const indexes = (await pool.query(`SELECT index_class.relname AS name,pg_get_indexdef(indexes.indexrelid) AS sql
      FROM pg_index indexes JOIN pg_class index_class ON index_class.oid=indexes.indexrelid
      JOIN pg_class table_class ON table_class.oid=indexes.indrelid
      JOIN pg_namespace ns ON ns.oid=table_class.relnamespace
      WHERE ns.nspname='public' AND NOT indexes.indisunique AND table_class.relname=ANY($1::text[])
      ORDER BY index_class.relname`, [['tasks','task_executions','copy_revisions','image_runs','assets','query_package_items',
        'production_batch_items','model_call_traces','operator_performance_events','operator_stage_events','operator_stage_current']])).rows;
    for (const index of indexes) {
      assert.match(index.name, /^[a-z_][a-z0-9_]*$/u);
      await pool.query(`DROP INDEX "${index.name}"`);
    }
    return indexes;
  });
  await phase('fixture settings and actors', async () => {
    await pool.query(`CREATE FUNCTION benchmark_uuid(value text) RETURNS uuid
      LANGUAGE sql IMMUTABLE STRICT AS $$
        SELECT overlay(overlay(md5(value) placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid
      $$`);
    await pool.query("INSERT INTO executor_nodes(id,name) VALUES ('benchmark-node','synthetic benchmark')");
    await pool.query("UPDATE app_users SET must_change_password=false,created_at='2025-01-01Z' WHERE username='admin'");
    await pool.query(`INSERT INTO app_users(username,display_name,role,password_hash,must_change_password,created_at)
      SELECT 'bench'||lpad(g::text,2,'0'),'Benchmark '||g,'USER','synthetic unusable hash',false,'2025-01-01Z'
      FROM generate_series(1,30) g`);
    // The fixture never bypasses internal constraint triggers.
    for (const table of ['tasks','task_executions','copy_revisions','image_runs','assets','operator_performance_events','operator_stage_events']) {
      await pool.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    }
  });
  await phase('1,000 query packages and batches', async () => {
    await pool.query(`INSERT INTO query_packages(id,name,status,created_by_account_id,created_by_username,
      client_batch_code,created_at,updated_at)
      SELECT g,'Benchmark package '||g,'PARTIALLY_USED',1,'admin',md5(g::text),
        '2026-09-01Z'::timestamptz+g*interval '1 second','2026-09-01Z'::timestamptz+g*interval '1 second'
      FROM generate_series(1,1000) g`);
    await pool.query(`INSERT INTO production_batches(id,public_id,query_package_id,query_package_name,
      client_batch_code,created_by_account_id,created_by_username,request_id,request_fingerprint)
      SELECT g,benchmark_uuid('batch-'||g),g,'Benchmark package '||g,md5(g::text),1,'admin',
        benchmark_uuid('request-'||g),repeat(md5(g::text),2) FROM generate_series(1,1000) g`);
  });
  await phase('1,000,000 query package items', () => pool.query(`INSERT INTO query_package_items(
      id,query_package_id,row_number,raw_query,query,status,screening_decision,
      screening_assigned_to_account_id,screening_assigned_to_username)
    SELECT g,(g-1)/1000+1,((g-1)%1000)+1,'scale task '||g||' searchable-pattern',
      'scale task '||g||' searchable-pattern','TASK_CREATED','SELECTED',u.id,u.username
    FROM generate_series(1,$1::integer) g JOIN app_users u ON u.username='bench'||lpad(((g-1)%30+1)::text,2,'0')`, [TASKS]));
  await phase('1,000,000 tasks', () => pool.query(`INSERT INTO tasks(id,query,input,state,created_by_node_id,
      copy_executor_node_id,created_by_user_id,assigned_to_user_id,assignment_source,assigned_at,created_at,updated_at,
      priority_sort_at,queue_entered_at,personal_stage_entered_at,source_query_package_id,
      source_query_package_item_id,source_query_package_name,production_batch_id,source_client_batch_code)
    SELECT g,'scale task '||g||' searchable-pattern','{}'::jsonb,
      CASE g%5 WHEN 0 THEN 'COPY_QUEUED' WHEN 1 THEN 'COPY_REVIEW_PENDING' WHEN 2 THEN 'IMAGE_QUEUED' ELSE 'MANUAL_ARCHIVE' END,
      'benchmark-node','benchmark-node','admin','bench'||lpad(((g-1)%30+1)::text,2,'0'),'MANUAL',
      '2026-09-01Z'::timestamptz+g*interval '1 second','2026-09-01Z'::timestamptz+g*interval '1 second',
      '2026-09-01Z'::timestamptz+g*interval '1 second','2026-09-01Z'::timestamptz+g*interval '1 second'-interval '1000 minutes',
      '2026-09-01Z'::timestamptz+g*interval '1 second','2026-09-01Z'::timestamptz+g*interval '1 second',
      (g-1)/1000+1,g,'Benchmark package '||((g-1)/1000+1),(g-1)/1000+1,md5(((g-1)/1000+1)::text)
    FROM generate_series(1,$1::integer) g`, [TASKS]));
  await phase('1,400,000 executions', async () => {
    await pool.query(`INSERT INTO task_executions(id,task_id,kind,node_id,status,stage,snapshot,started_at,finished_at)
      SELECT benchmark_uuid('copy-'||g),g,'COPY','benchmark-node','SUCCEEDED','COPY_DONE','{}',
        '2026-09-01Z'::timestamptz+g*interval '1 second','2026-09-01Z'::timestamptz+g*interval '1 second'+interval '10 seconds'
      FROM generate_series(1,$1::integer) g`, [TASKS]);
    await pool.query(`INSERT INTO task_executions(id,task_id,kind,node_id,status,stage,snapshot,image_production_chain_id,
      started_at,finished_at)
      SELECT benchmark_uuid('image-exec-'||g),g,'IMAGE','benchmark-node','SUCCEEDED','IMAGE_DONE','{}',benchmark_uuid('chain-'||g),
        '2026-09-01Z'::timestamptz+g*interval '1 second','2026-09-01Z'::timestamptz+g*interval '1 second'+interval '20 seconds'
      FROM generate_series(1,$1::integer) g WHERE g%5 IN (3,4)`, [TASKS]);
  });
  await phase('1,060,001 copy revisions', async () => {
    await pool.query(`INSERT INTO copy_revisions(id,task_id,execution_id,revision,content,revision_origin,approved_at,created_at)
      SELECT g,g,benchmark_uuid('copy-'||g),1,jsonb_build_object('title','Synthetic title','body','Synthetic body',
        'imagePlan',jsonb_build_object('imageCount',3,'pages',jsonb_build_array(jsonb_build_object('page',1,'prompt','synthetic')))),
        'GENERATION',CASE WHEN g%5 IN (2,3,4) THEN '2026-09-01Z'::timestamptz+g*interval '1 second' END,
        '2026-09-01Z'::timestamptz+g*interval '1 second' FROM generate_series(1,$1::integer) g`, [TASKS]);
    await pool.query(`INSERT INTO copy_revisions(id,task_id,revision,content,revision_origin,created_at)
      SELECT $1::bigint+g,1,g+1,jsonb_build_object('title','Historical synthetic '||g,'body',repeat('synthetic content ',100)),
        'COPY_EDIT','2026-09-20T00:00:00Z'::timestamptz+g*interval '1 microsecond'
      FROM generate_series(1,$2::integer) g`, [TASKS,HISTORY]);
  });
  await phase('400,000 image runs', () => pool.query(`INSERT INTO image_runs(id,task_id,execution_id,copy_revision_id,
      status,result,image_production_chain_id,created_at,finished_at)
    SELECT benchmark_uuid('image-run-'||g),g,benchmark_uuid('image-exec-'||g),g,'COMPLETED',
      jsonb_build_object('synthetic',true,'images',jsonb_build_array(
        jsonb_build_object('page',1,'deliveryAssetId',g*10+1),jsonb_build_object('page',2,'deliveryAssetId',g*10+2),
        jsonb_build_object('page',3,'deliveryAssetId',g*10+3))),benchmark_uuid('chain-'||g),
      '2026-09-01Z'::timestamptz+g*interval '1 second','2026-09-01Z'::timestamptz+g*interval '1 second'+interval '20 seconds'
    FROM generate_series(1,$1::integer) g WHERE g%5 IN (3,4)`, [TASKS]));
  await phase('1,200,000 asset metadata rows', () => pool.query(`INSERT INTO assets(id,task_id,image_run_id,media_type,
      byte_size,sha256,storage_path,original_name,image_production_chain_id,artifact_key,origin_image_run_id,created_at)
    SELECT g*10+page,g,benchmark_uuid('image-run-'||g),'image/png',1000000,repeat(md5(g::text),2),
      'synthetic/'||g||'/'||page||'.png',page||'.png',benchmark_uuid('chain-'||g),'page-'||page,benchmark_uuid('image-run-'||g),
      '2026-09-01Z'::timestamptz+g*interval '1 second'
    FROM generate_series(1,$1::integer) g CROSS JOIN generate_series(1,3) page WHERE g%5 IN (3,4)`, [TASKS]));
  await phase('1,000,000 batch items and task current pointers', async () => {
    await pool.query(`INSERT INTO production_batch_items(id,production_batch_id,source_query_package_item_id,query_snapshot,task_id)
      SELECT g,(g-1)/1000+1,g,'scale task '||g||' searchable-pattern',g FROM generate_series(1,$1::integer) g`, [TASKS]);
    await pool.query(`UPDATE tasks SET current_copy_revision_id=id,
      current_image_run_id=CASE WHEN id%5 IN (3,4) THEN benchmark_uuid('image-run-'||id) END,
      image_production_chain_id=CASE WHEN id%5 IN (3,4) THEN benchmark_uuid('chain-'||id) END`);
    await pool.query("UPDATE task_executions SET status='RUNNING',finished_at=NULL WHERE id=benchmark_uuid('copy-1')");
    await pool.query("UPDATE tasks SET state='COPY_RUNNING',current_execution_id=benchmark_uuid('copy-1') WHERE id=1");
  });
  await phase('1,000,000 synthetic model traces', () => pool.query(`INSERT INTO model_call_traces(id,task_id,execution_id,
      sequence,stage,provider,operation,model,status,prompt,request,response,started_at,finished_at,duration_ms)
    SELECT benchmark_uuid('trace-'||g),g,benchmark_uuid('copy-'||g),1,'COPY','FAKE','COPY','fake-model','SUCCEEDED',
      repeat(md5(g::text),32),'synthetic request','synthetic response',
      '2026-09-01Z'::timestamptz+g*interval '1 second','2026-09-01Z'::timestamptz+g*interval '1 second'+interval '1 second',1000
    FROM generate_series(1,$1::integer) g`, [TASKS]));
  await phase('60,001 reporting facts and 1,000,000 stage projections', async () => {
    await pool.query(`INSERT INTO operator_performance_events(event_key,task_id,account_id,stage,kind,occurred_at,data)
      SELECT 'benchmark-submit:'||g,g,u.id,'COPY','SUBMIT','2026-09-20Z'::timestamptz+g*interval '1 microsecond',
        jsonb_build_object('username',u.username,'copyRevisionId',g,'simulated',false)
      FROM generate_series(1,$1::integer) g JOIN app_users u ON u.username='bench'||lpad(((g-1)%30+1)::text,2,'0')`, [HISTORY]);
    await pool.query(`INSERT INTO operator_stage_events(task_id,account_id,username,stage,phase,state,occurred_at,baseline)
      SELECT t.id,u.id,u.username,CASE WHEN t.state LIKE 'COPY_%' THEN 'COPY' ELSE 'IMAGE' END,
        CASE WHEN t.state LIKE '%_QUEUED' THEN 'MACHINE_QUEUE' WHEN t.state LIKE '%_RUNNING' THEN 'MACHINE_RUNNING' ELSE 'HUMAN' END,
        t.state,t.created_at,true FROM tasks t JOIN app_users u ON u.username=t.assigned_to_user_id`);
    await pool.query('INSERT INTO operator_stage_current SELECT * FROM operator_stage_events');
    for (const table of ['tasks','task_executions','copy_revisions','image_runs','assets','operator_performance_events','operator_stage_events']) {
      await pool.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    }
    // Explicit IDs were used only to keep the large synthetic fixture deterministic.
    for (const table of ['tasks','copy_revisions','assets','query_packages','query_package_items','production_batches','production_batch_items']) {
      await pool.query(`SELECT setval(pg_get_serial_sequence('${table}','id'),(SELECT max(id) FROM ${table}))`);
    }
  });
  await phase('rebuild all temporary fixture nonunique indexes', async () => {
    for (const index of deferredIndexes) await pool.query(index.sql);
  });
  await phase('vacuum and analyze temporary fixtures', () => pool.query('VACUUM (ANALYZE)'));
}

export async function verifyHistory(repository) {
  const ids = new Set();
  let cursor = null, pages = 0;
  const started = performance.now();
  do {
    const page = await repository.listTaskHistory(1, { kind: 'copyRevisions', limit: 100, cursor });
    for (const item of page.items) {
      assert.equal(Object.hasOwn(item, 'content'), false);
      assert.equal(ids.has(item.id), false, 'history pagination must not duplicate rows');
      ids.add(item.id);
    }
    cursor = page.nextCursor;
    pages++;
  } while (cursor);
  assert.equal(ids.size, HISTORY + 1, 'history must not truncate at 50,000');
  assert.ok(ids.has(1) && ids.has(TASKS + HISTORY));
  return { expected: HISTORY + 1, seen: ids.size, pages, duplicates: 0, durationMs: Math.round(performance.now() - started),
    cursorPreservesMicroseconds: true };
}

export async function httpBenchmark(pool, actors, poolMax) {
  const repository = new PostgresControlPlaneRepository({ pool });
  const storageRoot = await mkdtemp(join(tmpdir(), 'xhs-scale-storage-'));
  const app = createControlPlaneApp({ repository, storageRoot, xhsSearchMachineToken: null,
    previewClient: null, previewUrlResolver: null, logger: { info() {}, error() {} } });
  const server = await new Promise(resolveServer => {
    const started = app.listen(0, '127.0.0.1', () => resolveServer(started));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const samples = new Map(), failures = [];
  let maxPoolWaiting = 0, maxPoolClients = 0;
  const monitor = setInterval(() => {
    maxPoolWaiting = Math.max(maxPoolWaiting, pool.waitingCount);
    maxPoolClients = Math.max(maxPoolClients, pool.totalCount);
  }, 20);
  const started = performance.now();
  try {
    await Promise.all(actors.map(async (actor, userIndex) => {
      const taskId = userIndex + 1;
      const routes = [
        ['assignedList', '/v1/tasks?personal=true&personalScope=ASSIGNED&limit=50&includeTotal=true'],
        ['currentDetail', `/v1/tasks/${taskId}?historyMode=current`],
        ['historyMetadata', `/v1/tasks/${taskId}/history/copyRevisions?limit=20`],
        ['queryPackages', '/v1/query-packages?limit=20'],
        ['personalWorkspace', '/v1/personal-workspace/tasks?personalScope=ASSIGNED&pageSize=50'],
      ];
      for (let round = 0; round < 10; round++) {
        const [kind,path] = routes[round % routes.length];
        const requestStarted = performance.now();
        try {
          const response = await fetch(`${baseUrl}${path}`, { headers: {
            'X-Actor-User-Id': String(actor.id), 'X-Actor-Username': actor.username, 'X-Actor-Role': actor.role,
            'X-Actor-Credential-Version': String(actor.credential_version),
          }, signal: AbortSignal.timeout(60_000) });
          const body = await response.json();
          if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${body.error?.message ?? body.error?.code}`);
          if (kind === 'assignedList') {
            assert.equal(body.data.total, userIndex < TASKS % CONCURRENCY ? Math.ceil(TASKS / CONCURRENCY) : Math.floor(TASKS / CONCURRENCY));
            assert.equal(body.data.items.length, 50);
          }
          if (kind === 'historyMetadata') assert.ok(Array.isArray(body.data.items));
          if (kind === 'currentDetail') assert.equal(body.data.history.mode, 'current');
          if (kind === 'personalWorkspace') {
            assert.equal(body.data.total, userIndex < TASKS % CONCURRENCY ? Math.ceil(TASKS / CONCURRENCY) : Math.floor(TASKS / CONCURRENCY));
            assert.equal(body.data.items.length, 50);
          }
          if (kind === 'queryPackages') {
            assert.equal(body.data.length, 20);
            assert.ok(body.data.every(item => item.counts.total === 1000));
          }
          if (!samples.has(kind)) samples.set(kind, []);
          samples.get(kind).push(performance.now() - requestStarted);
        } catch (error) { failures.push({ userIndex, kind, message: error.message }); }
      }
    }));
    const elapsedMs = Math.round(performance.now() - started);
    const allSamples = [...samples.values()].flat();
    const measurement = { poolMax, simultaneousUsers: actors.length, attemptedRequests: actors.length * 10,
      elapsedMs, requestsPerSecond: Number((allSamples.length * 1000 / elapsedMs).toFixed(2)),
      maxPoolWaiting, maxPoolClients, combined: allSamples.length ? summary(allSamples) : null,
      routes: Object.fromEntries([...samples].map(([key,values]) => [key,summary(values)])), failures };
    return { ...measurement, correctnessStatus: failures.length ? 'failed' : 'passed',
      latencyAcceptance: latencyAcceptance(measurement) };
  } finally {
    clearInterval(monitor);
    server.closeAllConnections();
    await new Promise(resolveServer => server.close(resolveServer));
    assert.ok(storageRoot.startsWith(join(tmpdir(), 'xhs-scale-storage-')));
    await rm(storageRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

let temporary, loadPool;
const readPools = [];
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
try {
  await save();
  temporary = await phase('start isolated PostgreSQL 18', () => startTemporaryPostgres18());
  const url = new URL(temporary.connectionString);
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(Number(url.port) > 0);
  loadPool = new pg.Pool({ connectionString: temporary.connectionString, max: 2, statement_timeout: 0,
    connectionTimeoutMillis: 5000, idleTimeoutMillis: 0, application_name: 'xhs-isolated-million-fixture' });
  report.environment.postgres = (await loadPool.query('SELECT version() AS version')).rows[0].version;
  report.environment.postgresSettings = (await loadPool.query(`SELECT name,setting,unit FROM pg_settings
    WHERE name IN ('shared_buffers','work_mem','effective_cache_size','max_connections') ORDER BY name`)).rows;
  await phase('apply full schema and migrations', () => migrateDatabase(loadPool));
  await loadFixture(loadPool);
  report.fixture.rowCounts = {};
  for (const table of ['tasks','copy_revisions','task_executions','image_runs','assets','model_call_traces',
    'query_packages','query_package_items','production_batch_items','operator_performance_events','operator_stage_current']) {
    report.fixture.rowCounts[table] = Number((await loadPool.query(`SELECT count(*) AS total FROM ${table}`)).rows[0].total);
  }
  assert.equal(report.fixture.rowCounts.tasks, TASKS);
  report.fixture.databaseBytes = Number((await loadPool.query('SELECT pg_database_size(current_database()) AS bytes')).rows[0].bytes);
  if (fixtureOnly) {
    report.status = 'ready';
    await save();
    console.log('Isolated fixture ready for agent queries; awaiting the matching fixture stop record.');
    const deadline = Date.now() + 60 * 60_000;
    while (Date.now() < deadline) {
      try {
        const stop = JSON.parse(await readFile(resolve('reports/scalability-fixture-stop.json'), 'utf8'));
        if (stop.startedAt === report.startedAt && stop.stop === true) break;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolveWait => setTimeout(resolveWait, 1000));
    }
    report.status = 'passed';
  } else {
  // The unbounded loading connection is never reused for application reads.
  // Verify the same 30-second statement limit as the ordinary default server.
  const validationPool = new pg.Pool({ connectionString: temporary.connectionString, max: 10,
    statement_timeout: 30_000, connectionTimeoutMillis: 5000, application_name: 'xhs-isolated-scale-validation' });
  readPools.push(validationPool);
  const repository = new PostgresControlPlaneRepository({ pool: validationPool });
  const admin = { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 };
  const fresh = await phase('first read with exact million total', () => timed(() => repository.listTasks({
    includeTotal: true, refreshTotal: true, countCacheIdentity: admin, limit: 50,
  })));
  assert.equal(fresh.value.total, TASKS);
  const populateCache = await timed(() => repository.listTasks({ includeTotal: true, countCacheIdentity: admin, limit: 50 }));
  const warm = await timed(() => repository.listTasks({ includeTotal: true, countCacheIdentity: admin, limit: 50 }));
  const freshWarm = await timed(() => repository.listTasks({ includeTotal: true, refreshTotal: true, countCacheIdentity: admin, limit: 50 }));
  report.measurements.millionTaskTotals = { firstApplicationCacheColdMs: fresh.ms, populateApplicationCacheMs: populateCache.ms,
    cachedTotalWarmMs: warm.ms,
    uncachedExactTotalWarmMs: freshWarm.ms, exactTotal: fresh.value.total, pageSize: fresh.value.items.length };
  report.assertions.historyBeyond50k = await phase('verify every historical version beyond 50k', () => verifyHistory(repository));
  report.assertions.reportBeyond50k = await phase('verify report facts beyond 50k', () => verifyScalableReport(validationPool));
  report.measurements.filteredQueries = await phase('verify filtered queries and primary-key progress', () => verifyScalableQueries(validationPool));
  report.queryPlans.priorityPage = await explain(validationPool, `SELECT id FROM tasks WHERE task_kind='CONTENT'
    ORDER BY priority_paused,priority_sort_at,id LIMIT 51`);
  report.queryPlans.ownerPriorityPage = await explain(validationPool, `SELECT id FROM tasks
    WHERE task_kind='CONTENT' AND assigned_to_user_id='bench01' ORDER BY priority_paused,priority_sort_at,id LIMIT 51`);
  report.queryPlans.historyPage = await explain(validationPool, `SELECT id,created_at FROM copy_revisions WHERE task_id=1
    AND content_cleared_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 101`);
  report.queryPlans.progressPrimaryKey = await explain(validationPool, `SELECT id FROM tasks
    WHERE id=1 AND current_execution_id=benchmark_uuid('copy-1')`);
  assert.ok(report.queryPlans.priorityPage.nodes.some(node => node.index === 'tasks_content_priority_page_idx'));
  assert.ok(report.queryPlans.historyPage.nodes.some(node => node.index === 'copy_revisions_history_page_idx'));
  const actors = (await validationPool.query("SELECT id,username,role,credential_version FROM app_users WHERE username LIKE 'bench%' ORDER BY username")).rows;
  for (const poolMax of process.argv.includes('--compare-pool-20') ? [10,20] : [10]) {
    const pool = new pg.Pool({ connectionString: temporary.connectionString, max: poolMax, statement_timeout: 30_000,
      connectionTimeoutMillis: 5000, application_name: `xhs-isolated-scale-read-${poolMax}` });
    readPools.push(pool);
    report.measurements[`httpConcurrencyPool${poolMax}`] = await phase(`30 concurrent users with pool ${poolMax}`,
      () => httpBenchmark(pool, actors, poolMax));
  }
  report.status = Object.values(report.measurements).some(value => value.failures?.length) ? 'failed' : 'passed';
  report.correctnessStatus = report.status;
  report.latencyAcceptance = report.measurements.httpConcurrencyPool10.latencyAcceptance;
  assert.equal(report.status, 'passed', 'all HTTP requests and response checks must pass');
  }
} catch (error) {
  report.status = 'failed';
  report.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
  console.error(error.message);
} finally {
  for (const pool of readPools) await pool.end().catch(() => {});
  await loadPool?.end().catch(() => {});
  if (temporary) await temporary.stop();
  report.finishedAt = new Date().toISOString();
  report.safety.temporaryClusterStopped = Boolean(temporary);
  await save();
  console.log(`Benchmark correctness ${report.correctnessStatus ?? report.status}; latency ${report.latencyAcceptance?.status ?? 'not measured'}; report: ${outputPath}`);
}
}
