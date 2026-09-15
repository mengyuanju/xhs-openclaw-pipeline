import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createControlPlaneApp } from '../src/http-server.mjs';

test('all image-edit mutations and read endpoints reject reviewers before accessing storage',async()=>{
  const repository={getUserByUsername:async username=>({id:1,username,role:username.toUpperCase(),status:'ACTIVE',credentialVersion:1}),getTaskAccess:()=>assert.fail('must reject before reading task'),pool:{query:()=>assert.fail('must not query'),connect:()=>assert.fail('must not connect')}};
  const app=createControlPlaneApp({repository,storageRoot:process.cwd()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  try{
    for(const role of ['REVIEWER'])for(const [method,path]of [
      ['POST','/v1/tasks/1/image-edit-references'],['POST','/v1/tasks/1/image-edits'],['GET','/v1/tasks/1/image-edits'],['GET',`/v1/image-edits/${randomUUID()}`],
      ...['queue','retry','cancel','accept','reject'].map(a=>['POST',`/v1/image-edits/${randomUUID()}/${a}`]),['POST',`/v1/tasks/1/image-versions/${randomUUID()}/restore`],
    ]){
      const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'content-type':'application/json','x-actor-role':role,'x-actor-username':role.toLowerCase(),'x-actor-user-id':'1','x-actor-credential-version':'1'},...(method==='POST'?{body:'{}'}:{})});
      assert.equal(response.status,403,`${role} ${method} ${path}`);
    }
  }finally{await new Promise(r=>server.close(r));}
});
