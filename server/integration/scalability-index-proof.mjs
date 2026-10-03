import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { startTemporaryPostgres18 } from '../tests/helpers/personal-postgres.mjs';
import { taskQueryIdentitySql } from '../src/task-query-identity.mjs';

const identity = taskQueryIdentitySql();
const bytes = `octet_length(query) + octet_length(${identity})
  + octet_length(COALESCE(created_by_user_id, '')) + octet_length(COALESCE(assigned_to_user_id, ''))`;
const temporary = await startTemporaryPostgres18();
const pool = new pg.Pool({ connectionString: temporary.connectionString });
try {
  await pool.query(`CREATE TABLE tasks(id bigint PRIMARY KEY,query varchar(500) NOT NULL,
    created_at timestamptz NOT NULL,priority_paused boolean NOT NULL,priority_sort_at timestamptz NOT NULL,
    task_kind text NOT NULL,state text NOT NULL DEFAULT 'COPY_QUEUED',created_by_user_id text,
    assigned_to_user_id text,assigned_at timestamptz)`);
  await pool.query(`INSERT INTO tasks(id,query,created_at,priority_paused,priority_sort_at,task_kind)
    SELECT g,'scale task '||g,'2026-09-01Z'::timestamptz+g*interval '1 second',
      false,'2026-09-01Z'::timestamptz+g*interval '1 second','CONTENT' FROM generate_series(1,50000) g`);
  await pool.query(await readFile(new URL('../migrations/0105_scalable_dedup_covering_index.sql', import.meta.url), 'utf8'));
  // Legal 500-character Unicode Queries must fit the narrow branch.
  await pool.query(`INSERT INTO tasks(id,query,created_at,priority_paused,priority_sort_at,task_kind)
    SELECT 50001,(SELECT string_agg(chr(65536+((g*7919)%900000)),'') FROM generate_series(1,500) g),
      '2026-09-03Z',false,'2026-09-03Z','CONTENT'`);
  // The same normalized identity in both branches must select the latest row.
  await pool.query(`INSERT INTO tasks(id,query,created_at,priority_paused,priority_sort_at,task_kind,created_by_user_id)
    VALUES (50002,'  SCALE   TASK  1 ','2026-09-04Z',false,'2026-09-04Z','CONTENT',repeat('x',2300)),
      (50003,'near-byte-limit','2026-09-05Z',false,'2026-09-05Z','CONTENT',repeat('x',2268))`);
  const limits = (await pool.query(`SELECT id,${bytes} AS bytes FROM tasks WHERE id>=50001 ORDER BY id`)).rows;
  assert.ok(limits.find(row => row.id === '50001').bytes > 2300);
  assert.ok(limits.find(row => row.id === '50002').bytes > 2300);
  assert.equal(limits.find(row => row.id === '50003').bytes, 2298);
  await pool.query('VACUUM (ANALYZE) tasks');
  const branch = operator => `SELECT ${identity} AS query_identity,id,created_at,priority_paused,priority_sort_at
    FROM tasks WHERE task_kind='CONTENT' AND ${bytes} ${operator} 2300
    ORDER BY ${identity},created_at DESC,id DESC`;
  const sql = `SELECT DISTINCT ON(query_identity) query_identity,id,created_at,priority_paused,priority_sort_at
    FROM ((${branch('<=')}) UNION ALL (${branch('>')})) candidates
    ORDER BY query_identity,created_at DESC,id DESC`;
  const rows = (await pool.query(sql)).rows;
  assert.equal(rows.length, 50002);
  assert.equal(rows.find(row => row.query_identity === 'scale task 1').id, '50002');
  const plan = (await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`)).rows[0]['QUERY PLAN'][0];
  const nodes = [];
  const visit = node => {
    nodes.push({ type: node['Node Type'], index: node['Index Name'], rows: node['Actual Rows'], heapFetches: node['Heap Fetches'] });
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(plan.Plan);
  assert.ok(nodes.some(node => node.type === 'Index Only Scan' && node.index === 'tasks_content_query_identity_cover_idx'));
  const report = { status: 'passed', isolatedTemporaryPostgres: true, rows: rows.length,
    maximumUnicodeCharacters: 500, crossBranchLatestId: '50002', limits, executionMs: plan['Execution Time'], nodes };
  await writeFile(new URL('../../reports/scalability-index-proof-2026-10-01.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally { await pool.end(); await temporary.stop(); }
