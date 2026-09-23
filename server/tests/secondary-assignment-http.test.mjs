import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { createControlPlaneApp } from '../src/http-server.mjs';

test('secondary disposition routes are admin-only and forward actor, version, request ID and storage root',async()=>{
  const users={admin:{id:1,username:'admin',role:'ADMIN',status:'ACTIVE',credentialVersion:2},
    qa:{id:2,username:'qa',role:'REVIEWER',status:'ACTIVE',credentialVersion:3}};
  const calls=[],repository={getUserByUsername:async username=>users[username]};
  for(const method of ['listReassignmentCases','getReassignmentCase','retryReassignmentReset',
    'regenerateReassignmentBaseline','restoreReassignmentCase','disposeReassignmentCase','escalateQualityToAdmin']) {
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
    const callCount=calls.length;
    const copyResponse=await fetch(`${base}/v1/copy-qa/items/opaque-id/escalate`,{method:'POST',headers:headers('qa'),body:JSON.stringify(body)});
    assert.equal(copyResponse.status,410);
    assert.equal(calls.length,callCount,'retired copy QA cannot enter secondary assignment');
    const imageResponse=await fetch(`${base}/v1/image-qa/items/opaque-id/escalate`,{method:'POST',headers:headers('qa'),body:JSON.stringify(body)});
    assert.equal(imageResponse.status,404);
    assert.equal(calls.length,callCount,'image rechecks cannot enter secondary assignment');
  } finally {await new Promise(done=>server.close(done));}
});
