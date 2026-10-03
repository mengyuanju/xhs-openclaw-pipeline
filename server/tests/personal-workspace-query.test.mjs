import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePersonalFilters } from '../../src/personal-workspace.mjs';
import { invalidatePersonalWorkspaceCounts, personalCurrentQuery, readPersonalCurrentPage } from '../src/personal-workspace-query.mjs';
import { personalFactsSql, readPersonalWorkspace } from '../src/personal-workspace.mjs';
import { taskListFactClient } from '../src/task-list-facts.mjs';

const now = Date.parse('2026-10-01T12:00:00+08:00');
const actor = { userId: 11, username: 'worker', role: 'USER', credentialVersion: 1 };
const filters = input => normalizePersonalFilters(input, now);
const source = options => personalFactsSql('false', options);

test('a million-row personal list fetches and hydrates only the requested page', async () => {
  const calls = [], ids = [999_981, 999_982];
  let loaded;
  const client = { release() {}, async query(sql, values) {
    calls.push({ sql, values });
    if (sql.includes('FROM filtered f')) return { rows: [{ ALL: 1_000_001, copyInitial: 1_000_001 }] };
    if (sql.startsWith('SELECT id FROM')) return { rows: ids.map(id => ({ id })) };
    if (sql.startsWith('SELECT task.id')) {
      assert.deepEqual(values[1], ids);
      assert.equal(values[4], false, 'fact hydration must not include all related tasks');
      return { rows: ids.map(id => ({ id, query: `task ${id}`, state: 'COPY_REVIEW_PENDING',
        created_at: new Date(now), queue_entered_at: new Date(now), priority_sort_at: new Date(now),
        is_assigned: true, has_access: true })) };
    }
    return { rows: [] };
  } };
  const pool = { async connect() { return client; } };
  const page = await readPersonalWorkspace(pool, actor, { page: '50000', pageSize: '20' }, {
    blindSql: 'false', loadTasks: async (_client, taskIds) => { loaded = taskIds; return taskIds.map(id => ({ id })); },
  });
  assert.equal(page.total, 1_000_001);
  assert.equal(page.offset, 999_980);
  assert.equal(page.items.length, 2);
  assert.deepEqual(loaded, ids);
  const pageQuery = calls.find(call => call.sql.startsWith('SELECT id FROM'));
  assert.deepEqual(pageQuery.values.slice(-2), [20, 999_980]);
  assert.doesNotMatch(pageQuery.sql, /copy_revisions|image_edit_requests|LATERAL/u);
  assert.ok(calls.some(call => call.sql === "SET LOCAL statement_timeout='15s'"));
});

test('counts share the same actor/scope budget while page and category can change', async () => {
  let counts = 0;
  const pool = {}, client = { async query(sql) {
    if (sql.includes('FROM filtered f')) { counts++; return { rows: [{ ALL: 5, review: 3, copyInitial: 3 }] }; }
    return { rows: [{ id: 1 }] };
  } };
  const read = (identity, input, at = now) => readPersonalCurrentPage(client, pool,
    { actor: identity, filters: filters(input), factsSql: source }, { now: at });
  assert.equal((await read(actor, {})).total, 5);
  assert.equal((await read(actor, { category: 'review', page: 2 })).total, 3);
  assert.equal(counts, 1);
  await read({ ...actor, userId: 12 }, {});
  await read({ ...actor, credentialVersion: 2 }, {});
  await read(actor, { personalScope: 'CREATED' });
  assert.equal(counts, 4, 'ownership and credential identities must not share counts');
  invalidatePersonalWorkspaceCounts(pool);
  await read(actor, {});
  assert.equal(counts, 5);
  await read(actor, {}, now + 5_001);
  assert.equal(counts, 6);
});

test('concurrent reads share one count calculation and failed counts remain failures', async () => {
  let counts = 0, finish;
  const result = new Promise(resolve => { finish = resolve; });
  const client = { async query(sql) {
    if (sql.includes('FROM filtered f')) { counts++; return result; }
    return { rows: [] };
  } };
  const pool = {};
  const reads = Array.from({ length: 30 }, () => readPersonalCurrentPage(client, pool,
    { actor, filters: filters({}), factsSql: source }, { now }));
  await Promise.resolve();
  assert.equal(counts, 1);
  finish({ rows: [{ ALL: 0 }] });
  assert.ok((await Promise.all(reads)).every(page => page.total === 0));
  invalidatePersonalWorkspaceCounts(pool);
  await assert.rejects(readPersonalCurrentPage({ async query() { throw Error('count failed'); } }, pool,
    { actor, filters: filters({}), factsSql: source }, { now }), /count failed/u);
});

test('fresh statistics bypass cached counts without evicting the page cache', async () => {
  let total=5,reads=0;
  const pool={},client={async query(sql){
    if(sql.includes('FROM filtered f')){reads++;return{rows:[{ALL:total}]};}
    return{rows:[{id:1}]};
  }};
  const input={actor,filters:filters({}),factsSql:source};
  assert.equal((await readPersonalCurrentPage(client,pool,input,{now})).total,5);
  total=9;
  assert.equal((await readPersonalCurrentPage(client,pool,input,{now,ttlMs:0,countsOnly:true})).total,9);
  assert.equal((await readPersonalCurrentPage(client,pool,input,{now})).total,5,'an unrelated fresh card does not reset page polling');
  assert.equal(reads,2);
});

test('literal search and Shanghai date bounds are parameterized before classification', () => {
  const query = personalCurrentQuery({ actor, filters: filters({ query: "x%' OR true--", createdFrom: '2026-09-30',
    createdTo: '2026-10-01', reworkType: 'BOTH', deduplicateQuery: true }), factsSql: source, now });
  assert.doesNotMatch(query.countSql, /x%' OR true--/u);
  assert.ok(query.values.includes("%x\\%' or true--%"));
  assert.ok(query.values.includes('2026-09-30T00:00:00+08:00'));
  assert.ok(query.values.includes('2026-10-01T00:00:00+08:00'));
  assert.match(query.countSql, /lower\(task\.query\) LIKE \$\d+ ESCAPE/u);
  assert.match(query.pageSql, /DISTINCT ON \(query_identity\)/u);
  assert.doesNotMatch(query.countSql, /LIMIT 50001/u);
});

test('progress only expires personal counts for the task creator and assignee',async()=>{
  let reads=0;const pool={},client={async query(){reads++;return{rows:[{ALL:0}]};}};
  const identities=[actor,{...actor,userId:12,username:'unrelated'},{...actor,userId:13,username:'creator'}];
  const read=identity=>readPersonalCurrentPage(client,pool,{actor:identity,filters:filters({personalScope:'ALL'}),factsSql:source},{now});
  for(const identity of identities)await read(identity);
  const writer=taskListFactClient({async query(sql){return sql.includes('FOR UPDATE')
    ? {rows:[{id:7,assigned_to_user_id:'worker',created_by_user_id:'creator'}],rowCount:1}
    : {rows:[],rowCount:1,command:sql==='COMMIT'?'COMMIT':'UPDATE'};}},pool);
  await writer.query('BEGIN');await writer.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[7]);
  await writer.query('UPDATE tasks SET current_stage=$2,last_activity_at=now(),updated_at=now() WHERE id=$1',[7,'COPY_WRITING']);
  await writer.query('COMMIT');
  const changed=[];for(const identity of identities){const before=reads;await read(identity);if(reads!==before)changed.push(identity.username);}
  assert.deepEqual(changed,['worker','creator']);assert.equal(reads,5);
});

test('old personal count flights cannot populate the cache after their scope changed',async()=>{
  let finish,reads=0;const pool={},client={async query(sql){if(!sql.includes('FROM filtered f'))return{rows:[]};reads++;return reads===1
    ? new Promise(resolve=>{finish=resolve;}) : {rows:[{ALL:0}]};}};
  const read=()=>readPersonalCurrentPage(client,pool,{actor,filters:filters({}),factsSql:source},{now});
  const first=read();await Promise.resolve();
  const writer=taskListFactClient({async query(){return{rowCount:1,rows:[],command:'UPDATE'};}},pool);
  await writer.query('UPDATE tasks SET state=$1',['CANCELLED']);await read();
  finish({rows:[{ALL:99}]});await first;assert.equal((await read()).total,0);assert.equal(reads,2);
});
