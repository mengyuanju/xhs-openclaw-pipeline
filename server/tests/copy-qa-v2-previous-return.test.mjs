import assert from 'node:assert/strict';
import test from 'node:test';

import { listCopyQaBatchItemsV2, listCopyQaWorkItemsV2 } from '../src/copy-qa-v2.mjs';

const ITEM_ID='71717171-7171-4717-8717-717171717171';
const BATCH_ID='81818181-8181-4818-8818-818181818181';
const HASH='a'.repeat(64);
const reviewer={userId:91,username:'qa-reviewer',role:'REVIEWER',credentialVersion:1};

function row(patch={}) {
  return {
    id:71,public_id:ITEM_ID,batch_public_id:BATCH_ID,batch_display_name:'质检批次',
    blind_review_enabled:true,task_id:991,copy_revision_id:902,approver_account_id:64,
    approver_username:'SECRET-APPROVER',query:'SECRET-QUERY',source_query_package_name:'SECRET-PACKAGE',
    content:{copy:{title:'修正后文案',body:'正文',tags:[]},imagePlan:[],
      qualityReturn:{returnedByUsername:'SECRET-RETURNER',baseRevisionId:901}},
    content_sha256:HASH,status:'PENDING',selected:true,mandatory_copy_qc:true,
    created_at:new Date('2026-09-24T03:00:00Z'),
    previous_return_event_id:51,previous_return_event_at:new Date('2026-09-23T01:00:00Z'),
    previous_member_reason_codes:['TITLE_AI_TONE','CUSTOM:71717171-7171-4717-8717-717171717171'],
    previous_member_reason_snapshots:[{code:'CUSTOM:71717171-7171-4717-8717-717171717171',group:'PLAN',label:'封面卖点不清'}],
    previous_member_note:'请重写标题',previous_member_decided_at:new Date('2026-09-23T01:00:00Z'),
    previous_legacy_reason_codes:null,previous_legacy_note:null,previous_legacy_reviewed_at:null,
    previous_return_snapshot:null,
    ...patch,
  };
}

function poolWithRows(rows) {
  const queries=[];
  return {queries,pool:{async query(sql,values=[]){
    const statement=String(sql);
    queries.push({sql:statement,values});
    if(statement.includes('SELECT * FROM app_users WHERE id=$1'))return {rows:[{id:91,copy_qc_enabled:true}]};
    if(statement.includes('SELECT * FROM copy_qa_batches_v2 WHERE public_id=$1')){
      return {rows:[{id:18,public_id:BATCH_ID,display_name:'质检批次',status:'INSPECTING',
        mode:'PERSONAL_AUTO',member_count:1,sample_count:1,full_inspection:true,return_trigger_count:1,
        blind_review_enabled:true}]};
    }
    return {rows};
  }}};
}

test('V2 work queue exposes only the previous verdict content to blind reviewers',async()=>{
  const {pool,queries}=poolWithRows([row()]);
  const page=await listCopyQaWorkItemsV2(pool,{sampleKind:'MANDATORY_RECHECK',limit:2},reviewer);
  assert.equal(page.hasMore,false);
  assert.equal(page.total,1);
  const item=page.items[0];
  assert.equal(item.qaVersion,2);
  assert.equal(item.sampleKind,'MANDATORY_RECHECK');
  assert.equal(item.capabilities.canReturnSingle,true);
  assert.deepEqual(item.previousReturn,{
    reasonLabels:['标题 · AI感严重','图文规划 · 封面卖点不清'],note:'请重写标题',returnedAt:'2026-09-23T01:00:00.000Z',
  });
  assert.deepEqual(Object.keys(item.previousReturn),['reasonLabels','note','returnedAt']);
  assert.equal(item.approvedRevision.content.copy.title,'修正后文案');
  const serialized=JSON.stringify(item);
  for(const secret of ['SECRET-APPROVER','SECRET-RETURNER','SECRET-QUERY','SECRET-PACKAGE','991','902']){
    assert.equal(serialized.includes(secret),false,secret);
  }
  const statement=queries.at(-1);
  assert.deepEqual(statement.values,['MANDATORY_RECHECK',null,3,0]);
  assert.match(statement.sql,/event\.task_id=member\.task_id AND event\.quality_cycle=member\.quality_cycle/u);
  assert.match(statement.sql,/event\.created_at < member\.created_at/u);
  assert.match(statement.sql,/batch\.status='INSPECTING'/u);
  assert.match(statement.sql,/task\.current_copy_revision_id=member\.copy_revision_id AND task\.priority_paused=false/u);
  assert.ok(statement.sql.indexOf("$1::text='ALL'")<statement.sql.indexOf('LIMIT $3'));
});

test('first inspection has no previous return; missing snapshots retain safe readable labels',async()=>{
  const ordinary=row({mandatory_copy_qc:false,previous_return_event_id:null,
    previous_return_snapshot:null,previous_member_reason_codes:null});
  const admin={...reviewer,userId:1,username:'admin',role:'ADMIN'};
  const first=await listCopyQaWorkItemsV2(poolWithRows([ordinary]).pool,{},admin);
  assert.equal(first.items[0].sampleKind,'RANDOM');
  assert.equal(first.items[0].previousReturn,null);
  assert.equal(first.items[0].taskId,991);
  const legacy=row({previous_member_reason_codes:null,previous_member_reason_snapshots:null,
    previous_member_note:null,previous_member_decided_at:null,
    previous_legacy_reason_codes:['FACT_ERROR'],previous_legacy_note:'数字需要核实',
    previous_return_snapshot:{reasonCodes:['FACT_ERROR'],note:'数字需要核实',returnedAt:'2026-09-22T02:00:00Z'}});
  const result=await listCopyQaWorkItemsV2(poolWithRows([legacy]).pool,{},reviewer);
  assert.deepEqual(result.items[0].previousReturn,{
    reasonLabels:['正文 · 事实或数据错误'],note:'数字需要核实',returnedAt:'2026-09-22T02:00:00.000Z',
  });
  const legacySnapshot=row({previous_return_snapshot:null,previous_member_reason_codes:null,
    previous_member_reason_snapshots:null,previous_member_note:null,previous_member_decided_at:null,
    previous_legacy_reason_codes:['CUSTOM:71717171-7171-4717-8717-717171717171'],
    previous_legacy_event_reason_codes:['CUSTOM:71717171-7171-4717-8717-717171717171'],
    previous_legacy_event_reason_snapshots:[{
      code:'CUSTOM:71717171-7171-4717-8717-717171717171',label:'历史中文问题标签',
    }],previous_legacy_event_note:'需修改封面',previous_legacy_event_at:new Date('2026-09-21T02:00:00Z')});
  const fromEvent=await listCopyQaWorkItemsV2(poolWithRows([legacySnapshot]).pool,{},reviewer);
  assert.deepEqual(fromEvent.items[0].previousReturn,{
    reasonLabels:['历史中文问题标签'],note:'需修改封面',returnedAt:'2026-09-21T02:00:00.000Z',
  });
  const snapshotsOnly=row({previous_return_snapshot:{reasonCodes:[],reasonSnapshots:[
    {code:'TITLE_MISSING_CORE_KEYWORD',group:'TITLE',label:'缺少核心关键词'},
    {group:'BODY',label:'旧记录仅存的正文问题'},
  ],note:null,returnedAt:null},previous_member_reason_codes:[],previous_member_reason_snapshots:[],
  previous_legacy_event_reason_codes:[],previous_legacy_reason_codes:[]});
  const fromSnapshots=await listCopyQaWorkItemsV2(poolWithRows([snapshotsOnly]).pool,{},reviewer);
  assert.deepEqual(fromSnapshots.items[0].previousReturn.reasonLabels,
    ['标题 · 缺少核心关键词','正文 · 旧记录仅存的正文问题']);
});

test('V2 batch detail includes the same previous return for a recheck',async()=>{
  const {pool}=poolWithRows([row()]);
  const detail=await listCopyQaBatchItemsV2(pool,BATCH_ID,reviewer);
  assert.equal(detail.items[0].sampleKind,'MANDATORY_RECHECK');
  assert.deepEqual(detail.items[0].previousReturn,{
    reasonLabels:['标题 · AI感严重','图文规划 · 封面卖点不清'],note:'请重写标题',returnedAt:'2026-09-23T01:00:00.000Z',
  });
  assert.equal(JSON.stringify(detail).includes('SECRET-RETURNER'),false);
});
