import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { runningTemporaryFixture } from './scalability-report-check.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { readOperatorPerformance } from '../src/operator-performance.mjs';

// This entry point intentionally accepts no database URL. The helper verifies
// the owned, newly created million-row fixture before any synthetic writes.
const pool=await runningTemporaryFixture({max:10,statementTimeoutMs:30_000,applicationName:'xhs-isolated-report-concurrency'});
const measurements={isolatedTemporaryPostgres:true,measurementScope:'authenticated-role server report API and repository task list',
  startedAt:new Date().toISOString(),poolMax:10,heavyQuerySlots:2};
const repository=new PostgresControlPlaneRepository({pool});
try {
  const actors=(await pool.query(`INSERT INTO app_users(username,display_name,role,password_hash,status)
    SELECT 'report-proof-admin-'||n,'Synthetic report administrator '||n,'ADMIN','fake-only','ACTIVE' FROM generate_series(1,30) n
    ON CONFLICT(username) DO UPDATE SET role='ADMIN' RETURNING id,username,role`)).rows
    .map(row=>({userId:Number(row.id),username:row.username,role:row.role}));
  let connectionLeases=0,aggregateQueries=0,firstQuery;
  const nativeConnect=pool.connect.bind(pool),observed=new WeakSet();
  const reportPool={connect:async()=>{
    connectionLeases++;
    const client=await nativeConnect();
    if(!observed.has(client)) {
      const query=client.query.bind(client);
      client.query=(sql,...args)=>{
        if(typeof sql==='string'&&sql.includes('repaired_facts AS')){aggregateQueries++;firstQuery?.();firstQuery=null;}
        return query(sql,...args);
      };
      observed.add(client);
    }
    return client;
  }};
  const input={period:'custom',from:'2026-09-20',to:'2026-09-20',activity:'PRODUCTION'};
  const statistics=values=>{const rows=values.toSorted((a,b)=>a-b);return {requests:rows.length,p95Ms:Math.round(rows[Math.ceil(rows.length*.95)-1]),maxMs:Math.round(rows.at(-1))};};
  const timedList=async()=>{
    const started=performance.now(),rows=await repository.listTasks({sortBy:'createdAt',sortOrder:'desc',limit:50});
    assert.equal(rows.length,50);return performance.now()-started;
  };
  let started=performance.now();
  const began=new Promise(resolve=>{firstQuery=resolve;});
  const sameRequests=Promise.all(actors.map(actor=>readOperatorPerformance(reportPool,actor,input)));
  await began;
  const normalDuringSame=await Promise.all(Array.from({length:30},timedList));
  const snapshots=await sameRequests;
  assert.equal(connectionLeases,1);assert.equal(aggregateQueries,1);
  assert.ok(snapshots.every(report=>report.summary.submissions===60001));
  assert.equal(new Set(snapshots.map(report=>report.snapshotToken)).size,30);
  assert.ok(statistics(normalDuringSame).p95Ms<=2000,'identical reports protect ordinary interactive reads');
  measurements.sameScope={administrators:30,durationMs:Math.round(performance.now()-started),reportConnectionLeases:connectionLeases,
    fullAggregateQueries:aggregateQueries,submissions:60001,ordinaryReads:statistics(normalDuringSame)};
  started=performance.now();
  const cached=await readOperatorPerformance(reportPool,actors[0],input);
  assert.equal(cached.summary.submissions,60001);
  measurements.cachedReportMs=Math.round(performance.now()-started);
  const accountId=snapshots[0].people.items.find(person=>person.submissions>0).accountId;
  started=performance.now();
  const detail=await readOperatorPerformance(reportPool,actors[0],{snapshotToken:snapshots[0].snapshotToken,metric:'submitted'},
    {kind:'detail',accountId,currentPageSize:25});
  assert.equal(detail.refreshed,false);
  assert.equal(detail.total,snapshots[0].people.items.find(person=>person.accountId===accountId).submissions);
  assert.ok(detail.current.length<=25);
  measurements.personDetail={durationMs:Math.round(performance.now()-started),total:detail.total,currentTotal:detail.currentTotal,pageRows:detail.items.length,currentRows:detail.current.length};
  connectionLeases=0;aggregateQueries=0;
  started=performance.now();
  const differentBegan=new Promise(resolve=>{firstQuery=resolve;});
  const differentRequests=Promise.allSettled(actors.map((actor,index)=>readOperatorPerformance(reportPool,actor,
    {...input,query:index===0?'bench':`synthetic-scope-${index}`})));
  await differentBegan;
  const normalDuringDifferent=await Promise.all(Array.from({length:30},timedList));
  const outcomes=await differentRequests;
  const passed=outcomes.filter(result=>result.status==='fulfilled');
  const busy=outcomes.filter(result=>result.status==='rejected'&&result.reason.code==='REPORT_BUSY');
  assert.equal(passed.length,2);assert.equal(busy.length,28);assert.equal(connectionLeases,2);assert.equal(aggregateQueries,2);
  assert.ok(statistics(normalDuringDifferent).p95Ms<=2000,'bounded heavy reporting protects ordinary interactive reads');
  measurements.differentScopes={administrators:30,durationMs:Math.round(performance.now()-started),completed:passed.length,
    expectedBusy:busy.length,unexpectedErrors:outcomes.length-passed.length-busy.length,reportConnectionLeases:connectionLeases,
    fullAggregateQueries:aggregateQueries,ordinaryReads:statistics(normalDuringDifferent)};
  measurements.status='passed';
  console.log(JSON.stringify(measurements));
} catch(error) {measurements.status='failed';measurements.error=error.message;throw error;}
finally {await writeFile('reports/scalability-report-concurrency-2026-10-02.json',JSON.stringify(measurements,null,2));await pool.end();}
