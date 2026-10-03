import assert from 'node:assert/strict';
import test from 'node:test';
import {startTemporaryPostgres18} from './helpers/personal-postgres.mjs';
import {PostgresControlPlaneRepository} from '../src/postgres-repository.mjs';
import {readTaskTotal,taskListFactClient} from '../src/task-list-facts.mjs';

test('PostgreSQL commit tracking retains unrelated counts and invalidates real stage and reassignment facts',{
 skip:process.env.RUN_OPERATOR_PERFORMANCE_POSTGRES!=='1',timeout:120_000,
},async()=>{
 const database=await startTemporaryPostgres18(),repository=new PostgresControlPlaneRepository({connectionString:database.connectionString});
 try{
  await repository.initialize();const db=repository.pool;
  await db.query("INSERT INTO executor_nodes(id,name) VALUES('scope-test','Scope test')");
  await db.query("INSERT INTO app_users(username,display_name,role,password_hash,status,created_at) SELECT name,name,'USER','fake-only','ACTIVE','2026-01-01' FROM unnest(ARRAY['scope-a','scope-b','scope-creator'])name");
  const tasks=(await db.query("INSERT INTO tasks(query,state,created_by_node_id,created_by_user_id,assigned_to_user_id,assigned_at,assignment_source) SELECT 'Scope '||name,'COPY_REVIEW_PENDING','scope-test','scope-creator',name,'2026-09-01','MANUAL' FROM unnest(ARRAY['scope-a','scope-b'])name RETURNING id,assigned_to_user_id")).rows;
  const task=tasks.find(row=>row.assigned_to_user_id==='scope-a').id;
  let reads=0;const countPool={async query(...args){reads++;return db.query(...args);}};
  const specs=[['base','SELECT count(*) AS total FROM tasks WHERE task_kind=\'CONTENT\'',[]],
   ['a',"SELECT count(*) AS total FROM tasks WHERE assigned_to_user_id=$1 AND current_stage='IMAGE_RETRY_EXHAUSTED'",['scope-a']],
   ['b',"SELECT count(*) AS total FROM tasks WHERE assigned_to_user_id=$1 AND current_stage='IMAGE_RETRY_EXHAUSTED'",['scope-b']],
   ['creator',"SELECT count(*) AS total FROM tasks WHERE created_by_user_id=$1 AND current_stage='IMAGE_RETRY_EXHAUSTED'",['scope-creator']]];
  const read=([key,sql,values])=>readTaskTotal(countPool,sql,values,{key,ttl:5000,now:()=>100,fresh:false});
  for(const spec of specs)await read(spec);assert.equal(reads,4);
  const raw=await db.connect(),writer=taskListFactClient(raw,countPool);
  try{
   await writer.query('BEGIN');await writer.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[task]);
   await writer.query("UPDATE tasks SET current_stage='IMAGE_RETRY_EXHAUSTED',progress_percent=10,last_activity_at=now(),updated_at=now() WHERE id=$1",[task]);await writer.query('COMMIT');
   assert.equal(Number((await read(specs[0])).result.rows[0].total),2);
   assert.equal(Number((await read(specs[1])).result.rows[0].total),1);
   assert.equal(Number((await read(specs[2])).result.rows[0].total),0);
   assert.equal(Number((await read(specs[3])).result.rows[0].total),1);assert.equal(reads,6);
   await writer.query('BEGIN');await writer.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[task]);
   await writer.query("UPDATE tasks SET assigned_to_user_id='scope-b',assigned_at=now() WHERE id=$1 RETURNING *",[task]);await writer.query('COMMIT');
   assert.equal(Number((await read(specs[1])).result.rows[0].total),0);
   assert.equal(Number((await read(specs[2])).result.rows[0].total),1);assert.equal(reads,8);
  }finally{await writer.query('ROLLBACK');raw.release();}
 }finally{await repository.close();await database.stop();}
});
