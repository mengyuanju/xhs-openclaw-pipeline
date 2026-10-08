import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { readSqlOperatorSnapshot } from '../src/operator-performance-sql.mjs';
import { normalizePerformanceFilters } from '../../src/operator-performance.mjs';

test('typed personnel summaries preserve canonical fields on an isolated medium synthetic fixture',{
  skip:process.env.RUN_OPERATOR_PERFORMANCE_POSTGRES!=='1',timeout:180_000,
},async()=>{
  const database=await startTemporaryPostgres18();
  const repository=new PostgresControlPlaneRepository({connectionString:database.connectionString});
  try {
    await repository.initialize();const pool=repository.pool;
    const account=(await pool.query(`INSERT INTO app_users(username,display_name,role,password_hash,status,created_at)
      VALUES('summary-bench','汇总测试人员','USER','fake-only','ACTIVE','2026-01-01') RETURNING id`)).rows[0].id;
    await pool.query("INSERT INTO executor_nodes(id,name) VALUES('summary-bench-node','Synthetic test executor')");
    const tasks=(await pool.query(`INSERT INTO tasks(query,state,created_by_node_id,created_by_user_id,assigned_to_user_id,assigned_at,assignment_source)
      SELECT '合成汇总任务 '||n,'COPY_REVIEW_PENDING','summary-bench-node','summary-bench','summary-bench','2026-09-20','MANUAL'
      FROM generate_series(1,500)n RETURNING id`)).rows.map(row=>row.id);
    await pool.query('DELETE FROM operator_stage_events WHERE task_id=ANY($1::bigint[])',[tasks]);
    await pool.query(`INSERT INTO operator_stage_events(task_id,account_id,username,stage,phase,state,occurred_at)
      SELECT task_id,$2,'summary-bench','COPY','HUMAN','COPY_REVIEW_PENDING','2026-09-20T00:00:00Z'
      FROM unnest($1::bigint[])task_id`,[tasks,account]);
    await pool.query(`INSERT INTO operator_performance_events(event_key,task_id,account_id,stage,kind,occurred_at,data)
      SELECT 'summary-bench:'||task_id||':'||n,task_id,$2,'COPY',CASE WHEN n%2=1 THEN 'SUBMIT' ELSE 'QUALITY' END,
        '2026-09-20T00:00:00Z'::timestamptz+n*interval '5 minutes',
        jsonb_build_object('username','summary-bench','displayName','汇总测试人员','outcome','PASS',
          'sampleKind','RANDOM','first',true,'firstSubmission',n=1,'rework',n=3,
          'submittedAt','2026-09-20T00:00:00Z'::timestamptz+(n-1)*interval '5 minutes',
          'query',repeat('用于验证详情字段不进入汇总缓存的合成文本。',80))
      FROM unnest($1::bigint[])task_id CROSS JOIN generate_series(1,4)n`,[tasks,account]);
    await pool.query('ANALYZE');
    const filters=normalizePerformanceFilters({period:'custom',from:'2026-09-20',to:'2026-09-20'});
    const asOf='2026-09-20T22:00:00.123456Z',samples={canonical:[],typedSummary:[]};
    let canonical;
    for(let round=0;round<4;round++)for(const summaryOnly of round%2?[true,false]:[false,true]) {
      const started=performance.now();
      const report=await readSqlOperatorSnapshot(pool,filters,asOf,asOf,{useProjections:false,summaryOnly});
      if(round>0)samples[summaryOnly?'typedSummary':'canonical'].push(Number((performance.now()-started).toFixed(3)));
      if(!summaryOnly)canonical=report;else assert.deepEqual(report,canonical,'every public field matches the canonical SQL');
    }
    const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
    await writeFile(new URL('../../reports/optimization-personnel-summary-benchmark.json',import.meta.url),JSON.stringify({
      isolatedTemporaryPostgres:true,developmentConnected:false,productionConnected:false,modelCalls:0,
      tasks:tasks.length,seededFacts:tasks.length*4,allPublicFieldsEqual:true,
      samplesMs:samples,medianMs:{canonical:median(samples.canonical),typedSummary:median(samples.typedSummary)},
      limitation:'One local synthetic fixture; warm database/system caches; does not predict million-task or production latency.',
    },null,2));
  } finally {await repository.close();await database.stop();}
});
