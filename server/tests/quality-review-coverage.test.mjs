import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { recordQualityReviewCoverage } from '../src/quality-review-coverage.mjs';
import { createCopyQaBatchV2, decideCopyQaItemV2 } from '../src/copy-qa-v2.mjs';
import { batchReturnImageQa, releaseEscalatedImageFreezes } from '../src/image-quality-control.mjs';

const reviewer={userId:91,username:'quality-reviewer',role:'REVIEWER',credentialVersion:1};
const admin={userId:1,username:'admin',role:'ADMIN',credentialVersion:1};
const settings={version:1,copy_sampling_enabled:true,copy_sampling_rate_bps:2000,
  copy_batch_return_threshold_bps:5000,image_reviewer_batch_return_enabled:true};
const empty={rows:[],rowCount:0};
const compact=sql=>String(sql).replace(/\s+/gu,' ').trim();

function coverageFrom(values){
  const [eventKey,accountId,taskId,stage,reviewItemKey,kind,at,operationKey,data]=values;
  return {eventKey,accountId,taskId,stage,reviewItemKey,kind,at,operationKey,data:JSON.parse(data)};
}

test('coverage uses operation and item identity, retains repeated operations and strips content',async()=>{
  const stored=new Map();
  const client={async query(sql,values){
    assert.match(sql,/COALESCE\(\$7::timestamptz,now\(\)\)/u);
    if(stored.has(values[0]))return empty;
    stored.set(values[0],coverageFrom(values));return {rows:[],rowCount:1};
  }};
  const fact={accountId:91,taskId:12,stage:'IMAGE',reviewItemKey:'IMAGE:legacy:3:12',
    kind:'BATCH_RETURN',operationKey:'IMAGE:legacy:3:BATCH_RETURN:first',
    data:{freezeId:3,samplingItemId:8,copyRevisionId:4,exclusion:null,
      query:'private source',note:'private note',content:{copy:'private copy'}}};
  assert.equal(await recordQualityReviewCoverage(client,fact),true);
  assert.equal(await recordQualityReviewCoverage(client,fact),false);
  assert.equal(await recordQualityReviewCoverage(client,{...fact,
    operationKey:'IMAGE:legacy:3:BATCH_RETURN:second'}),true);
  assert.equal(stored.size,2);
  assert.deepEqual(stored.values().next().value.data,
    {freezeId:3,samplingItemId:8,copyRevisionId:4,exclusion:null});
});

function copyFixture({decision='PASS',remaining=2,mandatory=false,priorReturn=false,
  fullInspection=false}={}){
  const member={id:10,public_id:randomUUID(),task_id:101,copy_revision_id:201,
    approval_event_id:301,approver_account_id:41,quality_cycle:2,
    content_sha256:'a'.repeat(64),selected:true,status:'PENDING'};
  const siblings=Array.from({length:remaining},(_,i)=>({...member,id:11+i,public_id:randomUUID(),
    task_id:102+i,copy_revision_id:202+i,approval_event_id:302+i,selected:false,status:'NOT_SELECTED'}));
  const members=[member,...siblings],coverage=[],qa=[],verdicts=[],queries=[],returns=[];
  const batch={id:8,status:'INSPECTING',full_inspection:fullInspection,return_trigger_count:1};
  const replay=new Map();
  const client={release(){},async query(sql,values=[]){
    const q=compact(sql);queries.push(q);
    if(['BEGIN','COMMIT','ROLLBACK'].includes(q)||q.includes('set_config')||q.includes('pg_advisory'))return empty;
    if(q.startsWith('SELECT * FROM app_users'))return {rows:[{id:91,copy_qc_enabled:true,role:'REVIEWER'}]};
    if(q.startsWith('SELECT * FROM copy_qa_decision_requests_v2'))return {rows:replay.has(values[1])?[replay.get(values[1])]:[]};
    if(q.startsWith('SELECT batch_id FROM copy_qa_batch_members_v2'))return {rows:[{batch_id:8}]};
    if(q.startsWith('SELECT * FROM copy_qa_batches_v2'))return {rows:[batch]};
    if(q.startsWith('SELECT * FROM copy_qa_batch_members_v2 WHERE public_id'))return {rows:[member]};
    if(q.startsWith('SELECT * FROM copy_qa_batch_members_v2 WHERE batch_id'))return {rows:members.filter(row=>
      q.includes("status='NOT_SELECTED'")?row.status==='NOT_SELECTED':['PENDING','NOT_SELECTED'].includes(row.status))};
    if(q.startsWith('SELECT approval.approved_by_username')){
      assert.match(q,/previous.member_id IS DISTINCT FROM \$4/u);
      return {rows:[{approved_by_username:'annotator',production_batch_id:4,
        mandatory_copy_qc:mandatory,prior_return:priorReturn}]};
    }
    if(q.startsWith('SELECT * FROM tasks')){
      const row=members.find(item=>item.task_id===values[0]);
      return {rows:[{id:row.task_id,state:'COPY_QC_PENDING',current_copy_revision_id:row.copy_revision_id,
        mandatory_copy_qc:mandatory}]};
    }
    if(q.startsWith('SELECT count(*) AS count FROM copy_qa_return_events_v2'))return {rows:[{count:0}]};
    if(q.startsWith('INSERT INTO copy_qa_return_events_v2')){returns.push(values);return empty;}
    if(q.startsWith('UPDATE copy_qa_batch_members_v2 SET status=$2')){
      members.find(row=>row.id===values[0]).status=values[1];return empty;
    }
    if(q.startsWith("UPDATE copy_qa_batch_members_v2 SET status='PASSED'")){member.status='PASSED';return empty;}
    if(q.startsWith("UPDATE copy_qa_batch_members_v2 SET status='RELEASED'")){
      siblings.forEach(row=>{row.status='RELEASED';});return empty;
    }
    if(q.startsWith('INSERT INTO account_quality_events')){verdicts.push({sql:q,values});return empty;}
    if(q.startsWith('INSERT INTO quality_review_activity_events')){qa.push({sql:q,values});return empty;}
    if(q.startsWith('INSERT INTO quality_review_coverage_events')){coverage.push(coverageFrom(values));return empty;}
    if(q.startsWith('SELECT * FROM copy_revisions'))return {rows:[{content:{copy:{title:'copy'}}}]};
    if(q.startsWith('INSERT INTO copy_revisions'))return {rows:[{id:500+values[0]}]};
    if(q.startsWith('SELECT count(*) FILTER'))return {rows:[{
      pending:members.filter(row=>row.selected&&row.status==='PENDING').length,
      returned:members.filter(row=>row.status==='RETURNED').length}]};
    if(q.startsWith('UPDATE copy_qa_batches_v2')){batch.status=q.includes("status='AUTO_RETURNED'")?'AUTO_RETURNED':values[1];return empty;}
    if(q.startsWith('UPDATE tasks'))return {rows:[],rowCount:1};
    if(q.startsWith('INSERT INTO copy_qa_decision_requests_v2')){
      replay.set(values[1],{fingerprint:values[2],response:values[3]});return empty;
    }
    throw new Error(`Unexpected SQL: ${q}`);
  }};
  const requestId=randomUUID();
  return {pool:{connect:async()=>client},member,batch,coverage,qa,verdicts,queries,returns,
    input:{requestId,decision,revisionToken:member.content_sha256,note:decision==='RETURN'?'需修改':''}};
}

test('copy last direct pass credits only unselected released members to the triggering reviewer',async()=>{
  const f=copyFixture();
  await decideCopyQaItemV2(f.pool,f.member.public_id,f.input,reviewer);
  assert.deepEqual(f.coverage.map(row=>[row.taskId,row.accountId,row.kind]),
    [[102,91,'BATCH_RELEASE'],[103,91,'BATCH_RELEASE']]);
  assert.equal(f.qa.length,1);
  const data=f.qa[0].values[3];
  assert.equal(data.sampleKind,'RANDOM');
  assert.equal(data.copyRevisionId,201);
  assert.equal(data.reviewItemKey,'COPY:v2:10');
  assert.match(f.qa[0].sql,/now\(\)/u);
  await decideCopyQaItemV2(f.pool,f.member.public_id,f.input,reviewer);
  assert.equal(f.qa.length,1);assert.equal(f.coverage.length,2);
});

for(const reason of ['mandatory','priorReturn'])test(`copy direct event retains recheck classification from ${reason}`,async()=>{
  const f=copyFixture({remaining:0,fullInspection:true,[reason]:true});
  await decideCopyQaItemV2(f.pool,f.member.public_id,f.input,reviewer);
  assert.equal(f.qa[0].values[3].sampleKind,'MANDATORY_RECHECK');
});

test('copy batch return records the exact extra affected scope and a single batch action',async()=>{
  const f=copyFixture({decision:'RETURN'});
  await decideCopyQaItemV2(f.pool,f.member.public_id,f.input,reviewer);
  assert.deepEqual(f.coverage.map(row=>[row.reviewItemKey,row.kind]),
    [['COPY:v2:11','BATCH_RETURN'],['COPY:v2:12','BATCH_RETURN']]);
  assert.equal(f.qa.length,2);
  assert.equal(f.qa[0].values[3].sampleKind,'RANDOM','the newly inserted own return is not prior history');
  assert.equal(f.qa[1].values[0],'copy-v2-batch-return:8');
  assert.deepEqual(f.qa[1].values[2].affectedTaskIds,[102,103]);
  assert.equal(f.qa[1].values[2].affectedCount,2);
  assert.equal(f.qa[1].values[2].operationKey,f.coverage[0].operationKey);
});

test('copy threshold still records a batch action when no members remain affected',async()=>{
  const f=copyFixture({decision:'RETURN',remaining:0});
  await decideCopyQaItemV2(f.pool,f.member.public_id,f.input,reviewer);
  assert.equal(f.coverage.length,0);
  assert.equal(f.qa[1].values[2].affectedCount,0);
  assert.deepEqual(f.qa[1].values[2].affectedTaskIds,[]);
});

test('zero-sample copy completion belongs to the system rather than the batch creator',async()=>{
  const coverage=[];
  const member={id:5,task_id:101,copy_revision_id:201,approver_account_id:41,quality_cycle:0};
  const client={release(){},async query(sql,values=[]){
    const q=compact(sql);
    if(['BEGIN','COMMIT','ROLLBACK'].includes(q)||q.includes('pg_advisory'))return empty;
    if(q.startsWith('SELECT * FROM app_users'))return {rows:[{id:1,role:'ADMIN'}]};
    if(q.startsWith('SELECT * FROM workflow_quality_settings'))return {rows:[settings]};
    if(q.startsWith('SELECT * FROM copy_qa_batches_v2'))return empty;
    if(q.startsWith('SELECT task.id AS task_id'))return {rows:[{task_id:101,copy_revision_id:201,
      copy_qa_cycle:0,account_id:41,approval_event_id:301,content_sha256:'a'.repeat(64)}]};
    if(q.startsWith('INSERT INTO copy_qa_batches_v2'))return {rows:[{id:8,public_id:randomUUID()}]};
    if(q.startsWith('SELECT * FROM copy_qa_batch_members_v2'))return {rows:[member]};
    if(q.startsWith('INSERT INTO quality_review_coverage_events')){coverage.push(coverageFrom(values));return empty;}
    if(q.startsWith('UPDATE tasks'))return {rowCount:1,rows:[]};
    if(q.startsWith('UPDATE ')||q.startsWith('INSERT INTO copy_qa_batch_members_v2'))return empty;
    throw new Error(`Unexpected SQL: ${q}`);
  }};
  await createCopyQaBatchV2({connect:async()=>client},{requestId:randomUUID(),
    mode:'PERSONAL_MANUAL',accountId:41,taskIds:[101],sampleTaskIds:[]},admin);
  assert.equal(coverage.length,1);assert.equal(coverage[0].accountId,null);
});

test('image batch return records every affected member and keeps repeat requests distinct',async()=>{
  const freezeId=9,freezePublicId=randomUUID(),runId=randomUUID();
  const coverage=[],rows=[0,1].map(i=>({id:70+i,public_id:randomUUID(),task_id:101+i,
    freeze_id:freezeId,approval_event_id:80+i,copy_revision_id:201+i,
    current_copy_revision_id:201+i,image_run_id:runId,current_image_run_id:runId,
    selected:i===0,sample_kind:'RANDOM',submitter_account_id:i===0?41:1,simulated:i===0}));
  const client={release(){},async query(sql,values=[]){
    const q=compact(sql);
    if(['BEGIN','COMMIT','ROLLBACK'].includes(q)||q.includes('pg_advisory'))return empty;
    if(q.startsWith('SELECT id, username, role'))return {rows:[{id:1}]};
    if(q.startsWith('SELECT * FROM image_sampling_mutation_requests'))return empty;
    if(q.startsWith('SELECT * FROM workflow_quality_settings'))return {rows:[settings]};
    if(q.startsWith('SELECT value FROM global_settings'))return empty;
    if(q.startsWith('SELECT item.*, sampling_freeze.status'))return {rows};
    if(q.startsWith('INSERT INTO image_sampling_events'))return {rows:[{id:300}]};
    if(q.startsWith('INSERT INTO quality_review_coverage_events')){coverage.push(coverageFrom(values));return empty;}
    if(q.startsWith('UPDATE ')||q.startsWith('INSERT INTO image_sampling_mutation_requests'))return empty;
    throw new Error(`Unexpected SQL: ${q}`);
  }};
  const pool={connect:async()=>client};
  const input={freezePublicId,itemIds:rows.map(row=>row.public_id),confirmedCount:2,
    requestId:randomUUID(),reasonCodes:['LAYOUT'],note:'批次存在问题'};
  await batchReturnImageQa(pool,input,admin);
  await batchReturnImageQa(pool,{...input,requestId:randomUUID()},admin);
  assert.equal(new Set(coverage.map(row=>row.eventKey)).size,4);
  assert.equal(new Set(coverage.map(row=>row.operationKey)).size,2);
  assert.deepEqual(coverage.slice(0,2).map(row=>[row.reviewItemKey,row.data.exclusion]),
    [['IMAGE:legacy:9:101','SIMULATED'],['IMAGE:legacy:9:102','SELF_REVIEW']]);
  assert.ok(coverage.every(row=>row.data.sourceEventId===300));
});

test('image release coverage records successful new releases including passed members',async()=>{
  const freezeId=9,runId=randomUUID(),coverage=[],events=[];
  const asset={id:71,mediaType:'image/png',byteSize:10,sha256:'a'.repeat(64),
    originalName:'image.png',pageIndex:1};
  const sha=createHash('sha256').update(JSON.stringify([asset])).digest('hex');
  const approvals=[0,1,2].map(i=>({id:80+i,task_id:101+i,copy_revision_id:201+i,
    image_run_id:runId,item_id:90+i,item_status:i===0?'PASSED':'NOT_SELECTED',
    sample_kind:'RANDOM',image_set_sha256:sha,submitted_by_account_id:41,selected:i===0}));
  const client={async query(sql,values=[]){
    const q=compact(sql);
    if(q.startsWith('SELECT DISTINCT freeze_id'))return {rows:[{freeze_id:freezeId}]};
    if(q.startsWith('SELECT * FROM image_sampling_freezes'))return {rows:[{id:freezeId}]};
    if(q.startsWith('SELECT count(*)::integer AS count'))return {rows:[{count:0}]};
    if(q.startsWith('SELECT approval.*, item.id'))return {rows:approvals};
    if(q.startsWith('SELECT * FROM tasks')){
      const approval=approvals.find(row=>row.task_id===values[0]);
      return {rows:[{id:approval.task_id,state:approval.task_id===103?'REVIEWED':'IMAGE_QC_PENDING',
        current_copy_revision_id:approval.copy_revision_id,current_image_run_id:runId}]};
    }
    if(q.startsWith('SELECT asset.id'))return {rows:[{id:71,media_type:'image/png',byte_size:10,
      sha256:asset.sha256,original_name:'image.png',page_index:1,expected_page_count:1}]};
    if(q.startsWith("UPDATE tasks SET state = 'REVIEWED'")){
      const approval=approvals.find(row=>row.task_id===values[0]);
      return {rows:[{id:approval.task_id,current_copy_revision_id:approval.copy_revision_id,current_image_run_id:runId}]};
    }
    if(q.startsWith('SELECT task.input, task.image_qc_legacy_accepted'))return {rows:[{
      input:{testRun:true},image_qc_legacy_accepted:true}]};
    if(q.startsWith('INSERT INTO image_sampling_events')){events.push(values);return {rows:[{id:300}]};}
    if(q.startsWith('INSERT INTO quality_review_coverage_events')){coverage.push(coverageFrom(values));return empty;}
    if(q.startsWith('UPDATE '))return empty;
    throw new Error(`Unexpected SQL: ${q}`);
  }};
  await releaseEscalatedImageFreezes(client,4,reviewer);
  assert.deepEqual(coverage.map(row=>row.taskId),[101,102]);
  assert.equal(coverage[0].data.selected,true);
  assert.equal(coverage[0].data.sourceEventId,300);
  assert.equal(events[0][4].coverageRecorded,true);
  assert.equal(events[0][4].releasedCount,2);
  assert.ok(coverage.every(row=>row.operationKey.endsWith(events[0][3])));
});
