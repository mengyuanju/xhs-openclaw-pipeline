import assert from 'node:assert/strict';
import test from 'node:test';
import {readTaskTotal,taskListFactClient,taskListFactVersion} from '../src/task-list-facts.mjs';

function fixture(){
 let reads=0;const records=new Map([[7,{id:7,assigned_to_user_id:'a',created_by_user_id:'creator'}],[8,{id:8,assigned_to_user_id:'b',created_by_user_id:'other'}]]);
 const pool={async query(){reads++;return {rows:[{total:1}],rowCount:1};}};
 const client=taskListFactClient({async query(sql,values=[]){
  if(sql.includes('FOR UPDATE'))return{rows:records.has(values[0])?[records.get(values[0])]:[],rowCount:1};
  return{command:sql==='COMMIT'?'COMMIT':sql==='ROLLBACK'?'ROLLBACK':'UPDATE',rows:[],rowCount:sql.includes('zero')?0:1};
 }},pool);
 const read=(key,sql,values=[])=>readTaskTotal(pool,sql,values,{key,ttl:5000,now:()=>100,fresh:false});
 const progress=async(id=7)=>{await client.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[id]);await client.query('UPDATE tasks SET current_stage=$2,progress_percent=$3,progress_message=$4,last_activity_at=now(),updated_at=now() WHERE id=$1',[id,'COPY_WRITING',1,'progress']);};
 return{pool,client,read,progress,get reads(){return reads;}};
}

test('progress preserves base counts and unrelated accounts while stage, stale and activity-date dependencies advance',async()=>{
 const f=fixture();
 const cases=[['global','SELECT count(*) AS total FROM tasks',[]],
 ['a','SELECT count(*) AS total FROM tasks WHERE assigned_to_user_id=$1',['a']],
 ['b','SELECT count(*) AS total FROM tasks WHERE assigned_to_user_id=$1',['b']],
 ['aStage',"SELECT count(*) AS total FROM tasks WHERE assigned_to_user_id=$1 AND current_stage='IMAGE_RETRY_EXHAUSTED'",['a']],
 ['bStage',"SELECT count(*) AS total FROM tasks WHERE assigned_to_user_id=$1 AND current_stage='IMAGE_RETRY_EXHAUSTED'",['b']],
 ['creatorStage',"SELECT count(*) AS total FROM tasks WHERE created_by_user_id=$1 AND current_stage='IMAGE_RETRY_EXHAUSTED'",['creator']],
 ['aDate','SELECT count(*) AS total FROM tasks WHERE assigned_to_user_id=$1 AND greatest(created_at,updated_at,last_activity_at)>$2',['a','2026-10-01']],
 ['globalStale',"SELECT count(*) AS total FROM tasks WHERE last_activity_at<now()-interval '30 minutes'",[]]];
 for(const args of cases)await f.read(...args);assert.equal(f.reads,8);
 await f.client.query('BEGIN');await f.progress();await f.client.query('COMMIT');
 const changed=[];for(const args of cases){const before=f.reads;await f.read(...args);if(f.reads!==before)changed.push(args[0]);}
 assert.deepEqual(changed,['aStage','creatorStage','aDate','globalStale']);assert.equal(f.reads,12);
});

test('one transaction unions task owners; rolled-back savepoints and zero-row writes do not advance scopes',async()=>{
 const f=fixture(),sql='SELECT count(*) AS total FROM tasks WHERE assigned_to_user_id=$1 AND current_stage=$2';
 const a=()=>f.read('a',sql,['a','RUNNING']),b=()=>f.read('b',sql,['b','RUNNING']);await a();await b();
 await f.client.query('BEGIN');await f.progress(7);await f.client.query('SAVEPOINT second');await f.progress(8);
 await f.client.query('ROLLBACK TO SAVEPOINT second');await f.client.query('COMMIT');await a();await b();assert.equal(f.reads,3);
 await f.client.query('BEGIN');await f.progress(7);await f.progress(8);await f.client.query('COMMIT');await a();await b();assert.equal(f.reads,5);
 await f.client.query('BEGIN');await f.progress();await f.client.query('ROLLBACK');await a();await b();assert.equal(f.reads,5);
 await f.client.query('UPDATE tasks SET current_stage=$2 WHERE id=$1 /* zero */',[7,'FAILED']);await a();assert.equal(f.reads,5);
});

test('unidentified reassignment invalidates both old and new ownership filters conservatively',async()=>{
 const f=fixture(),sql='SELECT count(*) AS total FROM tasks WHERE assigned_to_user_id=$1';
 await f.read('a',sql,['a']);await f.read('b',sql,['b']);
 await f.client.query('UPDATE tasks SET assigned_to_user_id=$2 WHERE id=$1',[7,'b']);
 await f.read('a',sql,['a']);await f.read('b',sql,['b']);assert.equal(f.reads,4);
});

test('a committed change prevents an old in-flight total from replacing a fresh calculation',async()=>{
 let release,reads=0;const pool={async query(){reads++;if(reads===1)return new Promise(resolve=>{release=resolve;});return{rows:[{total:2}],rowCount:1};}};
 const read=()=>readTaskTotal(pool,'SELECT count(*) AS total FROM tasks WHERE state=$1',['COPY_RUNNING'],{key:'same',ttl:5000,now:()=>100,fresh:false});
 const first=read();await Promise.resolve();const client=taskListFactClient({async query(){return{command:'UPDATE',rowCount:1,rows:[]};}},pool);
 await client.query('UPDATE tasks SET state=$1',['COPY_RUNNING']);assert.equal((await read()).result.rows[0].total,2);
 release({rows:[{total:1}],rowCount:1});await first;assert.equal((await read()).result.rows[0].total,2);assert.equal(reads,2);assert.equal(taskListFactVersion(pool),1);
});

test('OR target predicates and SET subqueries cannot narrow affected task IDs or fields',async()=>{
 const f=fixture(),aSql='SELECT count(*) AS total FROM tasks WHERE assigned_to_user_id=$1 AND state=$2';
 const b=()=>f.read('b',aSql,['b','COPY_RUNNING']);await b();
 await f.client.query('BEGIN');await f.client.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[7]);
 await f.client.query("UPDATE tasks SET state=$2 WHERE id=$1 OR state='COPY_QUEUED'",[7,'COPY_RUNNING']);
 await f.client.query('COMMIT');await b();assert.equal(f.reads,2,'rowCount=1 does not prove the id branch matched');
 await f.client.query('UPDATE tasks SET input=(SELECT input FROM tasks WHERE id=$1),state=$2 WHERE id=$3',[7,'COPY_RUNNING',8]);
 await b();assert.equal(f.reads,3,'the WHERE inside SET cannot hide the later state assignment');
 await f.client.query("UPDATE tasks SET progress_message='WHERE SELECT fake',state=$2 WHERE id=$1",[8,'COPY_RUNNING']);
 await b();assert.equal(f.reads,4,'a literal WHERE must not hide a later assignment');
});

test('an unowned OR count branch cannot be narrowed to one username',async()=>{
 const f=fixture(),sql="SELECT count(*) AS total FROM tasks WHERE assigned_to_user_id=$1 OR current_stage='IMAGE_RETRY_EXHAUSTED'";
 await f.read('mixed',sql,['b']);await f.client.query('BEGIN');await f.progress(7);await f.client.query('COMMIT');
 await f.read('mixed',sql,['b']);assert.equal(f.reads,2);
});
