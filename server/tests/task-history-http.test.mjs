import assert from 'node:assert/strict';
import test from 'node:test';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { normalizePerformanceFilters } from '../../src/operator-performance.mjs';

test('lazy task history preserves account access, post-read reassignment fencing and admin-only execution snapshots',async()=>{
  const user={id:2,username:'history-worker',role:'USER',status:'ACTIVE',credentialVersion:1};
  const headers={'X-Actor-User-Id':'2','X-Actor-Username':user.username,'X-Actor-Role':'USER','X-Actor-Credential-Version':'1'};
  let assignedId=2,reads=0,mode;
  const repository={
    getUserByUsername:async()=>user,
    getTaskAccess:async()=>({id:7,state:'COPY_REVIEW_PENDING',assignedToUserId:assignedId===2?user.username:'foreign',assignedToAccountId:assignedId,createdByUserId:'foreign',createdByAccountId:9}),
    getTask:async(id,options)=>{mode=options.historyMode;return{id:7,history:{mode},executions:[{snapshot:{private:'prompt'}}]};},
    listTaskHistory:async()=>{reads++;return{kind:'copyRevisions',items:[{id:1,revision:1}],hasMore:false,nextCursor:null};},
    getTaskHistoryItem:async()=>{reads++;assignedId=3;return{kind:'copyRevisions',item:{content:{private:'secret version'}}};},
  };
  const app=createControlPlaneApp({repository,storageRoot:'test-storage',logger:{info(){},error(){}}});
  const server=await new Promise(done=>{const listening=app.listen(0,'127.0.0.1',()=>done(listening));});
  const root=`http://127.0.0.1:${server.address().port}`;
  try{
    let response=await fetch(`${root}/v1/tasks/7?historyMode=current`,{headers});
    assert.equal(response.status,200);assert.equal(mode,'current');assert.equal((await response.json()).data.executions,undefined);
    response=await fetch(`${root}/v1/tasks/7?historyMode=invalid`,{headers});assert.equal(response.status,400);
    response=await fetch(`${root}/v1/tasks/7/history/executions`,{headers});assert.equal(response.status,403);assert.equal(reads,0);
    response=await fetch(`${root}/v1/tasks/7/history/executions/11111111-1111-4111-8111-111111111111`,{headers});assert.equal(response.status,403);assert.equal(reads,0);
    response=await fetch(`${root}/v1/tasks/7/history/copyRevisions?limit=20`,{headers});assert.equal(response.status,200);assert.equal(reads,1);
    response=await fetch(`${root}/v1/tasks/7/history/copyRevisions/1`,{headers});assert.equal(response.status,403);
    assert.doesNotMatch(await response.text(),/secret version/);
    response=await fetch(`${root}/v1/tasks/7/history/copyRevisions?limit=20`,{headers});assert.equal(response.status,403);assert.equal(reads,2);
    response=await fetch(`${root}/v1/admin/task-data-report/exports`,{headers});assert.equal(response.status,403);
  }finally{await new Promise(done=>server.close(done));await app.context.disposeControlPlaneResources();}
});

test('HTTP detail pagination is parsed separately from statistics filters and traces avoid full task history',async()=>{
  const admin={id:1,username:'admin',role:'ADMIN',status:'ACTIVE',credentialVersion:1};
  const headers={'X-Actor-User-Id':'1','X-Actor-Username':'admin','X-Actor-Role':'ADMIN','X-Actor-Credential-Version':'1'};
  let accessReads=0;
  const repository={
    getUserByUsername:async()=>admin,
    getTaskAccess:async()=>{accessReads++;return{id:7,state:'REVIEWED',taskKind:'CONTENT'};},
    getTask:async()=>{throw Error('Full historical content must not be read for trace metadata');},
    listModelCalls:async()=>({items:[],total:0,cleanup:{status:'COMPLETE'}}),
    operatorPerformance:async(actor,input,options)=>{
      normalizePerformanceFilters(input);
      if(!Number.isSafeInteger(options.currentPage)||options.currentPage<1
        ||!Number.isSafeInteger(options.currentPageSize)||options.currentPageSize<1||options.currentPageSize>100)throw new TypeError('当前待办页码无效');
      return{currentPage:options.currentPage,currentPageSize:options.currentPageSize};
    },
  };
  const app=createControlPlaneApp({repository,storageRoot:'test-storage',logger:{info(){},error(){}}});
  const server=await new Promise(done=>{const listening=app.listen(0,'127.0.0.1',()=>done(listening));});
  const root=`http://127.0.0.1:${server.address().port}`;
  try{
    for(const path of ['/v1/admin/operator-performance/tasks','/v1/admin/operator-performance/1/tasks']){
      const response=await fetch(`${root}${path}?metric=submitted&currentPage=2&currentPageSize=20`,{headers});
      assert.equal(response.status,200);assert.deepEqual((await response.json()).data,{currentPage:2,currentPageSize:20});
    }
    let response=await fetch(`${root}/v1/admin/operator-performance/tasks?currentPage=-1&currentPageSize=20`,{headers});assert.equal(response.status,400);
    response=await fetch(`${root}/v1/tasks/7/model-calls?limit=20`,{headers});assert.equal(response.status,200);assert.equal(accessReads,2);
  }finally{await new Promise(done=>server.close(done));await app.context.disposeControlPlaneResources();}
});

test('task action authorization avoids full history and fences reassignment after auxiliary reads',async()=>{
  const user={id:2,username:'action-worker',role:'USER',status:'ACTIVE',credentialVersion:1};
  const headers={'content-type':'application/json','X-Actor-User-Id':'2','X-Actor-Username':user.username,'X-Actor-Role':'USER','X-Actor-Credential-Version':'1'};
  let assignedId=2,changeOwner=false,blind=false,reads=0;
  const checkActor=({actor})=>assert.equal(actor.userId,2);
  const repository={
    getUserByUsername:async()=>user,
    getTaskAccess:async()=>({id:7,state:'COPY_REVIEW_PENDING',assignedToUserId:user.username,
      assignedToAccountId:assignedId,createdByUserId:'foreign',createdByAccountId:9,activeBlindQa:blind}),
    getTask:async()=>assert.fail('Action authorization must not load full task history'),
    listCopyReviewDrafts:async(id,options)=>{checkActor(options);reads++;return{drafts:[]};},
    saveCopyReviewDraft:async(id,input,options)=>{checkActor(options);return{created:true,draft:{id:1}};},
    createImagePlanRegeneration:async(id,input,options)=>{checkActor(options);return{created:true,job:{id:'job'}};},
    approveCopy:async(id,input,options)=>{checkActor(options);return{id:7,state:'IMAGE_QUEUED'};},
    getImagePlanRegeneration:async()=>{reads++;if(changeOwner)assignedId=3;return{private:'secret planning job'};},
    pool:{query:async sql=>{
      assert.match(sql,/FROM image_edit_requests/u);reads++;
      if(changeOwner)assignedId=3;
      return{rows:[{task_id:7,private:'secret edit result'}]};
    }},
  };
  const app=createControlPlaneApp({repository,storageRoot:'test-storage',logger:{info(){},error(){}}});
  const server=await new Promise(done=>{const listening=app.listen(0,'127.0.0.1',()=>done(listening));});
  const root=`http://127.0.0.1:${server.address().port}`;
  try{
    for(const [method,path,status] of [
      ['GET','copy-review-drafts',200],['POST','copy-review-drafts',201],
      ['POST','regenerate-image-plan',202],['POST','approve-copy',200],
      ['GET','regenerate-image-plan/job',200],['GET','image-edits',200],
    ]){
      const response=await fetch(`${root}/v1/tasks/7/${path}`,{method,headers,...(method==='POST'?{body:'{}'}:{})});
      assert.equal(response.status,status,path);
    }
    for(const path of ['regenerate-image-plan/job','image-edits']){
      assignedId=2;changeOwner=true;
      const response=await fetch(`${root}/v1/tasks/7/${path}`,{headers});
      assert.equal(response.status,403,path);assert.doesNotMatch(await response.text(),/secret/u);
    }
    changeOwner=false;assignedId=9;
    const before=reads;
    let response=await fetch(`${root}/v1/tasks/7/copy-review-drafts`,{headers});
    assert.equal(response.status,403);assert.equal(reads,before);
    user.role='REVIEWER';headers['X-Actor-Role']='REVIEWER';blind=true;assignedId=2;
    response=await fetch(`${root}/v1/tasks/7/regenerate-image-plan/job`,{headers});
    assert.equal(response.status,404);assert.equal(reads,before);
  }finally{await new Promise(done=>server.close(done));await app.context.disposeControlPlaneResources();}
});
