import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runningTemporaryFixture, waitForFixture } from './scalability-report-check.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { personalFactsSql } from '../src/personal-workspace.mjs';
import { invalidatePersonalWorkspaceCounts, personalCurrentQuery } from '../src/personal-workspace-query.mjs';
import { normalizePersonalFilters } from '../../src/personal-workspace.mjs';

function nodes(plan,result=[]) {
  result.push({type:plan['Node Type'],relation:plan['Relation Name'],index:plan['Index Name'],
    rows:plan['Actual Rows'],loops:plan['Actual Loops'],totalMs:plan['Actual Total Time'],
    sharedHitBlocks:plan['Shared Hit Blocks'],sharedReadBlocks:plan['Shared Read Blocks'],heapFetches:plan['Heap Fetches']});
  for(const child of plan.Plans??[])nodes(child,result);return result;
}
const output=resolve('reports/scalability-personal-2026-10-01.json');
let pool;
try{
  await waitForFixture();
  pool=await runningTemporaryFixture({max:10,statementTimeoutMs:120000,applicationName:'xhs-isolated-personal-explain'});
  assert.equal(Number((await pool.query('SELECT count(*) AS total FROM tasks')).rows[0].total),1_000_000);
  const prepareIndexes=process.argv.includes('--prepare-indexes');
  if(prepareIndexes){
    await pool.query(await readFile(new URL('../migrations/0107_personal_count_covering_indexes.sql',import.meta.url),'utf8'));
    await pool.query('VACUUM (ANALYZE) tasks');
    await pool.query('VACUUM (ANALYZE) copy_revisions');
    for(const relation of ['operator_performance_events','operator_stage_current','task_assignment_events','task_assignment_records']){
      await pool.query(`ANALYZE ${relation}`);
    }
  }
  const actors=(await pool.query("SELECT id,username,role,credential_version FROM app_users WHERE username LIKE 'bench%' ORDER BY username")).rows;
  const plans=[];
  for(const username of ['bench01','bench02','bench03','bench05']){
    const user=actors.find(row=>row.username===username),actor={userId:Number(user.id),username:user.username,role:user.role,credentialVersion:user.credential_version};
    const filters=normalizePersonalFilters({personalScope:'ASSIGNED',pageSize:20});
    const query=personalCurrentQuery({actor,filters,factsSql:options=>personalFactsSql('false',options)});
    for(const kind of ['count','page']){
      const sql=kind==='count'?query.countSql:query.pageSql,values=kind==='count'?query.values:[...query.values,20,0];
      const plan=(await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`,values)).rows[0]['QUERY PLAN'][0];
      plans.push({username,kind,planningMs:plan['Planning Time'],executionMs:plan['Execution Time'],jit:plan.JIT,nodes:nodes(plan.Plan)});
    }
  }
  const repository=new PostgresControlPlaneRepository({pool});
  invalidatePersonalWorkspaceCounts(pool);
  const began=performance.now();
  const latencies=await Promise.all(actors.map(async user=>{
    const started=performance.now();
    const result=await repository.personalWorkspace({userId:Number(user.id),username:user.username,role:user.role,
      credentialVersion:user.credential_version},{personalScope:'ASSIGNED',pageSize:'20'});
    assert.ok(result.total>=33333 && result.total<=33334);assert.equal(result.items.length,20);
    return performance.now()-started;
  }));
  latencies.sort((a,b)=>a-b);
  const report={finishedAt:new Date().toISOString(),safety:{isolatedTemporaryPostgres:true,modelsCalled:false,rowsModified:0,
    preparedPersonalCoveringIndexes:prepareIndexes},
    measurementScope:'personal repository only; excludes mixed HTTP report/detail/history/package contention',
    plans,personalConcurrency:{users:30,poolMax:10,elapsedMs:Math.round(performance.now()-began),
      p50Ms:Math.round(latencies[Math.floor(latencies.length*.5)]),p95Ms:Math.round(latencies[Math.ceil(latencies.length*.95)-1]),
      maxMs:Math.round(latencies.at(-1))}};
  await writeFile(output,JSON.stringify(report,null,2)+'\n');
  process.stdout.write(JSON.stringify({output,plans:plans.map(({username,kind,executionMs})=>({username,kind,executionMs})),
    personalConcurrency:report.personalConcurrency})+'\n');
}finally{await pool?.end();}
