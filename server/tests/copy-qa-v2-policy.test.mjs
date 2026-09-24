import test from 'node:test';
import assert from 'node:assert/strict';
import { plannedSampleCount, rejectionTriggerCount, routeCopyApprovalV2 } from '../src/copy-qa-v2.mjs';

test('personal automatic batches sample the chosen members with ceiling rounding',()=>{
  assert.equal(plannedSampleCount(0,5000),0);
  assert.equal(plannedSampleCount(1,0),0);
  assert.equal(plannedSampleCount(3,2000),1);
  assert.equal(plannedSampleCount(10,2000),2);
  assert.equal(plannedSampleCount(3,10000),3);
});

test('rejection threshold is based on original sampled count',()=>{
  assert.equal(rejectionTriggerCount(0,5000),0);
  assert.equal(rejectionTriggerCount(1,5000),1);
  assert.equal(rejectionTriggerCount(3,5000),2);
  assert.equal(rejectionTriggerCount(4,7500),3);
  assert.equal(rejectionTriggerCount(4,10000),4);
});

for(const origin of ['SECOND_ASSIGNMENT','FINAL_REWORK']){
for(const enabled of [false,true]){
  test(`${origin} creates a full-inspection batch when ordinary sampling is ${enabled?'on':'off'}`,async()=>{
    const queries=[];
    const client={async query(sql,values=[]){
      const source=String(sql).replace(/\s+/gu,' ').trim();
      queries.push({sql:source,values});
      if(source==='SELECT * FROM workflow_quality_settings WHERE singleton = 1'){
        return {rows:[{version:1,copy_sampling_enabled:enabled,copy_sampling_rate_bps:0,
          copy_batch_return_threshold_bps:5000,blind_review_enabled:enabled}]};
      }
      if(source.startsWith("UPDATE tasks SET state='COPY_QC_PENDING'")){
        return {rows:[{id:101,state:'COPY_QC_PENDING',mandatory_copy_qc:values[3],
          mandatory_copy_qc_origin:values[4]}]};
      }
      if(source.startsWith('INSERT INTO copy_qa_batches_v2'))return {rows:[{id:88,public_id:'batch-88'}]};
      if(source.startsWith('INSERT INTO copy_qa_batch_members_v2'))return {rows:[]};
      throw new Error(`unexpected SQL: ${source}`);
    }};
    const result=await routeCopyApprovalV2(client,{
      task:{id:101,copy_qa_cycle:2,mandatory_copy_qc:true,
        mandatory_copy_qc_origin:origin},
      revision:{id:204},approval:{id:704,approved_by_account_id:41,content_sha256:'a'.repeat(64)},
      actor:{userId:41},aiDisclosureEnabled:true,
    });
    assert.equal(result.task.state,'COPY_QC_PENDING');
    assert.equal(result.task.mandatory_copy_qc,true);
    assert.equal(result.task.mandatory_copy_qc_origin,origin);
    assert.equal(queries.some(({sql})=>sql.includes("state='IMAGE_QUEUED'")),false);
    const batch=queries.find(({sql})=>sql.startsWith('INSERT INTO copy_qa_batches_v2'));
    assert.deepEqual(batch.values.slice(0,9),['PERSONAL_AUTO',41,true,enabled,10000,5000,1,1,1]);
    const member=queries.find(({sql})=>sql.startsWith('INSERT INTO copy_qa_batch_members_v2'));
    assert.deepEqual(member.values,[88,101,204,704,41,2,'a'.repeat(64),true,'PENDING']);
  });
}
}

test('mandatory copy review refuses a missing approver before changing task state',async()=>{
  const client={async query(sql){
    if(sql==='SELECT * FROM workflow_quality_settings WHERE singleton = 1'){
      return {rows:[{version:1,copy_sampling_enabled:false,copy_sampling_rate_bps:0}]};
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }};
  await assert.rejects(routeCopyApprovalV2(client,{
    task:{id:101,mandatory_copy_qc:true,mandatory_copy_qc_origin:'SECOND_ASSIGNMENT'},
    revision:{id:204},approval:{id:704,approved_by_account_id:null,content_sha256:'a'.repeat(64)},
    aiDisclosureEnabled:true,
  }),{code:'APPROVER_IDENTITY_MISSING'});
});
