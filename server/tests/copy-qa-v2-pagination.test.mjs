import assert from 'node:assert/strict';
import test from 'node:test';
import { listCopyQaBatchesV2, listCopyQaBatchItemsV2 } from '../src/copy-qa-v2.mjs';

const batchId='81818181-8181-4818-8818-818181818181';
const itemId='71717171-7171-4717-8717-717171717171';
const actor={userId:91,username:'qa',role:'REVIEWER',credentialVersion:1};
function fixture(){
  const queries=[];
  const batch={id:18,public_id:batchId,display_name:'分页批次',status:'INSPECTING',mode:'PERSONAL_AUTO',member_count:500,
    sample_count:120,full_inspection:true,return_trigger_count:60,blind_review_enabled:true,created_at:'2026-10-02T00:00:00Z'};
  const pool={async query(sql,values){
    queries.push({sql,values});
    if(sql.includes('SELECT * FROM app_users'))return {rows:[{...actor,id:91,copy_qc_enabled:true}]};
    if(sql.startsWith('SELECT count(*) AS total'))return {rows:[{total:'45'}]};
    if(sql.includes('SELECT batch.*'))return {rows:[{...batch,pending_count:'110',passed_count:'5',returned_count:'1',discarded_count:'4',affected_count:'0'}]};
    if(sql.startsWith('SELECT * FROM copy_qa_batches_v2'))return {rows:[batch]};
    if(sql.startsWith('SELECT count(*) FILTER'))return {rows:[{total:'120',pending_count:'110',passed_count:'5',returned_count:'1',discarded_count:'4',affected_count:'0'}]};
    if(sql.startsWith('SELECT member.*'))return {rows:[{public_id:itemId,task_id:991,query:'PRIVATE-QUERY',content:{copy:{title:'文案标题',body:'正文'},qualityReturn:{returnedByUsername:'PRIVATE-RETURNER'}},
      status:'PENDING',approver_username:'PRIVATE-APPROVER',content_sha256:'a'.repeat(64),selected:true,created_at:'2026-10-02T00:00:00Z'}]};
    throw Error(`Unexpected query: ${sql}`);
  }};
  return {pool,queries};
}

test('V2 batch pagination bounds rows, clamps removed last pages and preserves complete counters',async()=>{
  const {pool,queries}=fixture();
  const result=await listCopyQaBatchesV2(pool,actor,'FINISHED',{limit:20,offset:999});
  assert.equal(result.total,45);assert.equal(result.offset,40);assert.equal(result.limit,20);
  assert.equal(result.items[0].pendingCount,110);assert.equal(result.items[0].discardedCount,4);
  assert.deepEqual(queries.at(-1).values,['FINISHED',20,40]);assert.match(queries.at(-1).sql,/LIMIT \$2 OFFSET \$3/u);
  assert.match(queries.at(-1).sql,/ORDER BY batch\.created_at DESC,batch\.id DESC/u);
  const legacy=await listCopyQaBatchesV2(pool,actor,'PENDING');assert.ok(Array.isArray(legacy));
  assert.deepEqual(queries.at(-1).values,['PENDING']);assert.doesNotMatch(queries.at(-1).sql,/LIMIT \$2/u);
});

test('V2 paginated detail keeps full-batch totals and blind redaction, including recheck history',async()=>{
  const {pool,queries}=fixture();
  const result=await listCopyQaBatchItemsV2(pool,batchId,actor,{limit:50,offset:500});
  assert.deepEqual(result.pagination,{total:120,limit:50,offset:100});
  assert.equal(result.batch.memberCount,500);assert.equal(result.batch.pendingCount,110);assert.equal(result.batch.discardedCount,4);
  assert.equal(result.items.length,1);assert.equal(result.items[0].taskId,null);assert.equal(result.items[0].query,null);assert.equal(result.items[0].approverUsername,null);
  assert.equal(result.items[0].content.copy.title,'文案标题');
  for(const text of ['PRIVATE-QUERY','PRIVATE-RETURNER','PRIVATE-APPROVER'])assert.equal(JSON.stringify(result).includes(text),false);
  const query=queries.at(-1);assert.deepEqual(query.values,[18,50,100]);
  assert.match(query.sql,/event\.task_id=member\.task_id AND event\.quality_cycle=member\.quality_cycle/u);
  assert.match(query.sql,/ORDER BY member\.id LIMIT \$2 OFFSET \$3/u);
  const legacy=await listCopyQaBatchItemsV2(pool,batchId,actor);assert.equal(legacy.pagination,undefined);
});

test('V2 pagination rejects unbounded parameters before querying and still checks active quality authorization',async()=>{
  const {pool,queries}=fixture();
  for(const options of [{limit:0},{limit:101},{limit:1.5},{offset:-1},{offset:1_000_001},{offset:'bad'}]){
    await assert.rejects(listCopyQaBatchesV2(pool,actor,'PENDING',options),TypeError);
    await assert.rejects(listCopyQaBatchItemsV2(pool,batchId,actor,options),TypeError);
  }
  assert.equal(queries.length,0);
  const denied={async query(){return {rows:[{id:91,role:'REVIEWER',copy_qc_enabled:false}]};}};
  await assert.rejects(listCopyQaBatchItemsV2(denied,batchId,actor,{limit:50,offset:0}),/权限已关闭/u);
});
