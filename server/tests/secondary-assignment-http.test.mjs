import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';

test('secondary disposition routes are admin-only and forward actor, version, request ID and storage root',async()=>{
  const users={admin:{id:1,username:'admin',role:'ADMIN',status:'ACTIVE',credentialVersion:2},
    qa:{id:2,username:'qa',role:'REVIEWER',status:'ACTIVE',credentialVersion:3}};
  const calls=[],repository={getUserByUsername:async username=>users[username]};
  for(const method of ['listReassignmentCases','getReassignmentCase','retryReassignmentReset',
    'regenerateReassignmentBaseline','restoreReassignmentCase','disposeReassignmentCase','escalateQualityToAdmin','batchReassignmentCases']) {
    repository[method]=async(...args)=>{calls.push({method,args});return {status:'PENDING'};};
  }
  const storageRoot=resolve('test-storage');
  const app=createControlPlaneApp({repository,storageRoot,enforceUserAuth:true,logger:{info(){},error(){}}});
  const server=await new Promise(done=>{const value=app.listen(0,'127.0.0.1',()=>done(value));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers=username=>({'Content-Type':'application/json','X-Actor-User-Id':String(users[username].id),
    'X-Actor-Username':username,'X-Actor-Role':users[username].role,'X-Actor-Credential-Version':String(users[username].credentialVersion)});
  const body={requestId:'11111111-1111-4111-8111-111111111111',expectedVersion:4,note:'处理原因',targetAccountId:9};
  const routes=[['','GET','listReassignmentCases'],['/7','GET','getReassignmentCase'],
    ['/7/reset','POST','retryReassignmentReset'],['/7/regenerate','POST','regenerateReassignmentBaseline'],
    ['/7/restore','POST','restoreReassignmentCase'],['/7/reassign','POST','disposeReassignmentCase'],['/7/discard','POST','disposeReassignmentCase']];
  try {
    for(const [path,method,repositoryMethod] of routes) {
      const options=username=>({method,headers:headers(username),...(method==='POST'?{body:JSON.stringify(body)}:{})});
      const count=calls.length;
      assert.equal((await fetch(`${base}/v1/admin/reassignment-cases${path}`,options('qa'))).status,403);
      assert.equal(calls.length,count,'forbidden requests never reach the repository');
      assert.equal((await fetch(`${base}/v1/admin/reassignment-cases${path}`,options('admin'))).status,200);
      const call=calls.at(-1);assert.equal(call.method,repositoryMethod);
      assert.deepEqual(call.args.at(-1).actor,{userId:1,username:'admin',role:'ADMIN',credentialVersion:2});
      if(method==='POST')assert.deepEqual(call.args[1],body);
      if(path.endsWith('/reset'))assert.equal(call.args.at(-1).storageRoot,storageRoot);
      if(path.endsWith('/reassign'))assert.equal(call.args.at(-1).operation,'REASSIGN');
      if(path.endsWith('/discard'))assert.equal(call.args.at(-1).operation,'DISCARD');
    }
    const batchBody={operation:'REASSIGN',note:'批量重新制作',targetAccountId:9,
      items:[{id:7,expectedVersion:4,requestId:body.requestId}]};
    const batchUrl=`${base}/v1/admin/reassignment-cases/batch`;
    const batchOptions=username=>({method:'POST',headers:headers(username),body:JSON.stringify(batchBody)});
    const beforeBatch=calls.length;
    assert.equal((await fetch(batchUrl,batchOptions('qa'))).status,403);
    assert.equal(calls.length,beforeBatch);
    assert.equal((await fetch(batchUrl,batchOptions('admin'))).status,200);
    assert.equal(calls.at(-1).method,'batchReassignmentCases');
    assert.deepEqual(calls.at(-1).args,[batchBody,{actor:{userId:1,username:'admin',role:'ADMIN',credentialVersion:2},storageRoot}]);
    for(const invalidBody of [{...batchBody,items:[]},{...batchBody,items:[batchBody.items[0],batchBody.items[0]]},
      {...batchBody,items:[{...batchBody.items[0],expectedVersion:0}]},{...batchBody,note:''},
      {...batchBody,targetAccountId:'9'}]) {
      const beforeInvalid=calls.length;
      const response=await fetch(batchUrl,{...batchOptions('admin'),body:JSON.stringify(invalidBody)});
      assert.equal(response.status,400);
      assert.equal((await response.json()).error.code,'VALIDATION_ERROR');
      assert.equal(calls.length,beforeInvalid,'malformed batches never reach mutation code');
    }
    const partial={operation:'REASSIGN',total:2,succeeded:1,failed:1,results:[
      {id:7,success:true,item:{id:7,status:'REASSIGNED',version:5}},
      {id:8,success:false,error:{code:'RESET_INCOMPLETE',message:'初始还原或修改记录清理尚未完成'}},
    ]};
    repository.batchReassignmentCases=async()=>partial;
    const partialResponse=await fetch(batchUrl,batchOptions('admin'));
    assert.equal(partialResponse.status,200);
    assert.deepEqual((await partialResponse.json()).data,partial);
    repository.batchReassignmentCases=async()=>{throw new Error('database offline');};
    const unavailable=await fetch(batchUrl,batchOptions('admin'));
    assert.equal(unavailable.status,500);
    assert.equal((await unavailable.json()).error.code,'INTERNAL_ERROR');
    const callCount=calls.length;
    const copyResponse=await fetch(`${base}/v1/copy-qa/items/opaque-id/escalate`,{method:'POST',headers:headers('qa'),body:JSON.stringify(body)});
    assert.equal(copyResponse.status,410);
    assert.equal(calls.length,callCount,'retired copy QA cannot enter secondary assignment');
    const imageResponse=await fetch(`${base}/v1/image-qa/items/opaque-id/escalate`,{method:'POST',headers:headers('qa'),body:JSON.stringify(body)});
    assert.equal(imageResponse.status,404);
    assert.equal(calls.length,callCount,'image rechecks cannot enter secondary assignment');
  } finally {await new Promise(done=>server.close(done));}
});

test('health exposes the dedicated secondary-assignment batch protocol capability',async()=>{
  const repository=new PostgresControlPlaneRepository({pool:{
    async query(sql){assert.equal(sql,'SELECT now() AS now');return {rows:[{now:'2026-09-30T00:00:00Z'}]};},
  }});
  const app=createControlPlaneApp({repository,storageRoot:resolve('test-storage'),enforceUserAuth:true,logger:{info(){},error(){}}});
  const server=await new Promise(done=>{const value=app.listen(0,'127.0.0.1',()=>done(value));});
  try {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/health`);
    assert.equal(response.status,200);
    const health=(await response.json()).data;
    assert.equal(health.capabilities.secondaryAssignmentVersion,1);
    assert.equal(health.capabilities.secondaryAssignmentBatchVersion,1);
  } finally {await new Promise(done=>server.close(done));}
});
