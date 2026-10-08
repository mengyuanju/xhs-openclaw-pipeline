import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { startTemporaryPostgres18 } from './temporary-postgres18.mjs';
import { normalizePersonalFilters, PERSONAL_WORK_CATEGORIES, selectPersonalTasks } from '../../src/personal-workspace.mjs';
import { personalFactFromRow } from '../src/personal-workspace.mjs';
import { readPersonalCurrentPage } from '../src/personal-workspace-query.mjs';

const now = Date.parse('2026-10-01T12:00:00+08:00');
const actor = { userId: 11, username: 'worker', role: 'USER' };
const columns = `id bigint,query text,state text,current_stage text,created_at timestamptz,
  queue_entered_at timestamptz,priority_sort_at timestamptz,priority_mode text,priority_paused boolean,
  source_query_package_name text,mandatory_copy_qc boolean,mandatory_image_qc boolean,
  mandatory_copy_qc_origin text,revision_origin text,is_created boolean,is_assigned boolean,has_access boolean,
  rework_target text,rework_source text,rework_rounds bigint,plan_status text,plan_ready_at timestamptz,
  queued bigint,running bigint,ready bigint,failed bigint,preview_ready_at timestamptz,
  delivery_ready boolean,assigned_to_user_id text,created_by_user_id text`;

function fixtureRows() {
  const states = ['COPY_QUEUED','COPY_RUNNING','COPY_REVIEW_PENDING','COPY_QC_PENDING','COPY_FAILED',
    'IMAGE_QUEUED','IMAGE_RUNNING','IMAGE_FAILED','MANUAL_ARCHIVE','IMAGE_QC_PENDING','IMAGE_REWORK_PENDING','REVIEWED','CANCELLED'];
  const rows = states.flatMap((state, index) => [false, true].map((returned, variant) => ({
    id: index * 2 + variant + 1, query: `query ${index}`, state, current_stage: state,
    created_at: new Date(now - (index + variant) * 3_600_000).toISOString(),
    queue_entered_at: new Date(now - (index + variant) * 7_200_000).toISOString(),
    priority_sort_at: new Date(now - (index + variant) * 60_000).toISOString(),
    priority_mode: variant ? 'PAUSE' : 'SYSTEM', priority_paused: !!variant,
    source_query_package_name: '词包_%', mandatory_copy_qc: returned, mandatory_image_qc: returned,
    mandatory_copy_qc_origin: returned ? 'QA_RETURN' : null, revision_origin: returned ? 'QA_RETURN' : 'GENERATION',
    is_created: true, is_assigned: true, has_access: true, assigned_to_user_id: 'worker', created_by_user_id: 'worker',
    rework_target: index % 3 ? 'COPY' : 'BOTH', rework_source: null, rework_rounds: variant ? 3 : 0,
    plan_status: null, plan_ready_at: null, queued: 0, running: 0, ready: 0, failed: 0,
    preview_ready_at: null, delivery_ready: returned,
  })));
  const add = patch => rows.push({ ...rows[4], id: rows.length + 1, query: `extra ${rows.length + 1}`, ...patch });
  add({ revision_origin: 'FINAL_REWORK', rework_source: null, rework_target: 'BOTH' });
  add({ revision_origin: 'QA_RETURN', plan_status: 'RUNNING' });
  add({ revision_origin: 'QA_RETURN', plan_status: 'SUCCEEDED', plan_ready_at: new Date(now - 60_000).toISOString() });
  add({ revision_origin: 'QA_RETURN', ready: 1, running: 1, preview_ready_at: new Date(now - 90_000_000).toISOString() });
  add({ revision_origin: 'QA_RETURN', failed: 1, queued: 1 });
  add({ current_stage: 'IMAGE_RETRY_EXHAUSTED', revision_origin: 'QA_RETURN' });
  add({ queue_entered_at: null });
  add({ queue_entered_at: new Date(now + 3_600_000).toISOString() });
  add({ query: '\t\u00a0同 Query\u3000\n', source_query_package_name: null });
  add({ query: '同\tQuery' });
  add({ query: '100%_literal\\x' });
  return rows;
}

test('SQL personal pagination matches legacy classification, filters, per-category dedup and order', {
  skip: process.env.RUN_PERSONAL_WORKSPACE_POSTGRES !== '1', timeout: 120_000,
}, async () => {
  const database = await startTemporaryPostgres18();
  const pool = new pg.Pool({ connectionString: database.connectionString, max: 2 });
  try {
    const rows = fixtureRows(), facts = rows.map(personalFactFromRow);
    const json = JSON.stringify(rows).replaceAll("'", "''");
    const factsSql = ({ additionalWhere = '' } = {}) => `SELECT task.*
      FROM jsonb_to_recordset('${json}'::jsonb) task(${columns})
      CROSS JOIN (SELECT $1::bigint AS account,$2::bigint[] AS ids,$3::varchar AS role,$4::varchar AS scope,$5::boolean AS current) typed
      WHERE true ${additionalWhere}`;
    const cases = [
      ...[...PERSONAL_WORK_CATEGORIES, 'queued', 'running', 'COPY_REVIEW_PENDING', 'MANUAL_ARCHIVE']
        .flatMap(category => [false, true].map(deduplicateQuery => ({ category, deduplicateQuery, pageSize: 3, page: 2 }))),
      ...['priority:desc','createdAt:desc','createdAt:asc','id:desc','id:asc','waiting:desc'].map(sort => ({ sort, pageSize: 4, page: 3 })),
      { reworkType: 'BOTH' }, { reworkType: 'COPY' }, { reworkType: 'IMAGE' },
      { reworkProgress: 'PROCESSING' }, { reworkProgress: 'CONFIRM' }, { reworkProgress: 'EDIT' },
      { reworkSource: 'FINAL_REWORK' }, { reworkSource: 'COPY_QA' }, { reworkSource: 'IMAGE_QA' },
      { longWaiting: true }, { repeated: true }, { query: '#5' }, { query: 'query 1' },
      { query: '%_literal\\' }, { queryPackageName: '_%' }, { priorityMode: 'PAUSE' },
      { createdFrom: '2026-10-01', createdTo: '2026-10-01' },
      { category: 'rework', sort: 'priority:desc', pageSize: 2, page: 9999 },
      { category: 'ALL', deduplicateQuery: true, sort: 'id:asc', pageSize: 100 },
    ];
    for (const input of cases) {
      const filters = normalizePersonalFilters(input, now);
      const expected = selectPersonalTasks(facts, [], filters, now);
      const actual = await readPersonalCurrentPage(pool, pool, { actor, filters, factsSql }, { now, ttlMs: 0 });
      assert.deepEqual(actual.ids, expected.items.map(item => item.id), `page ${JSON.stringify(input)}`);
      assert.deepEqual(actual.counts, expected.counts, `counts ${JSON.stringify(input)}`);
      assert.equal(actual.total, expected.total, `total ${JSON.stringify(input)}`);
      assert.equal(actual.offset, expected.offset, `offset ${JSON.stringify(input)}`);
    }
  } finally { await pool.end(); await database.stop(); }
});
