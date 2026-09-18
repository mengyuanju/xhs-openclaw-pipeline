import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControlPlaneApp } from '../src/http-server.mjs';

test('operator performance HTTP endpoints require live administrator identity, including CSV and snapshots',async()=>{
  let role='ADMIN',version=1,calls=0;
  const storageRoot=await mkdtemp(join(tmpdir(),'operator-report-http-'));
  const app=createControlPlaneApp({storageRoot,enforceUserAuth:true,repository:{
    getUserByUsername:async()=>({id:10,username:'test',role,status:'ACTIVE',credentialVersion:version}),
    operatorPerformance:async(actor,input,options)=>{calls++;assert.equal(actor.role,'ADMIN');
      return options?.kind==='export'?{csv:'\uFEFF"姓名"\r\n"测试"'}:{actor:actor.userId,input,options};},
  }});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const root=`http://127.0.0.1:${server.address().port}`;
  const headers=()=>({'X-Actor-User-Id':'10','X-Actor-Username':'test','X-Actor-Role':role,'X-Actor-Credential-Version':'1'});
  try{
    for(const path of ['', '/tasks','/12','/12/tasks','/export']){
      const response=await fetch(`${root}/v1/admin/operator-performance${path}`,{headers:headers()});
      assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/u);
      if(path==='/export'){assert.match(response.headers.get('content-type'),/text\/csv/u);assert.match(await response.text(),/姓名/u);}
    }
    assert.equal(calls,5);
    for(const deniedRole of ['USER','REVIEWER']){
      role=deniedRole;
      for(const path of ['', '/tasks','/12/tasks','/export']) assert.equal((await fetch(`${root}/v1/admin/operator-performance${path}`,{headers:headers()})).status,403);
    }
    role='ADMIN';version=2;
    assert.equal((await fetch(`${root}/v1/admin/operator-performance`,{headers:headers()})).status,401);
    assert.equal(calls,5);
  }finally{await app.context.disposeControlPlaneResources?.();await new Promise(resolve=>server.close(resolve));
    assert.ok(storageRoot.startsWith(join(tmpdir(),'operator-report-http-')));await rm(storageRoot,{recursive:true,force:true});}
});
