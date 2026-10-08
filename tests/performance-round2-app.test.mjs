import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createImageEditStateReader, imageEditStateSignature, imageEditPollDelay } from '../src/image-edit-state-cache.mjs';
import { mutationWorkspaceUpdate, workspaceUpdateMatches } from '../src/workspace-invalidation.mjs';
import { thumbnailUrl } from '../src/control-plane/asset-proxy.mjs';
import { createBackgroundTaskStore } from '../app/components/background-task-store.ts';
import { notifyWorkspaceUpdated, subscribeWorkspaceUpdates } from '../app/components/workspace-updates.ts';

test('editor and background readers share one request with all pending IDs, and fresh mutation reads invalidate it', async () => {
  const first = randomUUID(), second = randomUUID();
  let calls = 0, clock = 10000;
  const reader = createImageEditStateReader({ scope: () => 'same-account-credential', now: () => clock,
    read: async ({ ids }) => { calls++; return { status:'RUNNING',items:ids.map(id=>({id,status:'RUNNING'})),signature:String(calls) }; } });
  const [editor, notification] = await Promise.all([
    reader({taskId:10}), reader({taskId:10,ids:[first,second]}),
  ]);
  assert.equal(calls,1);assert.equal(editor,notification);assert.equal(editor.items.length,2);
  await reader({taskId:10,ids:[first]});assert.equal(calls,1);
  await reader({taskId:10,fresh:true});assert.equal(calls,2);
  clock+=1001;await reader({taskId:10});assert.equal(calls,3);
});

test('account credential scopes and standalone/business identities never share state responses',async()=>{
  let scope=1,calls=0;
  const reader=createImageEditStateReader({scope:()=>scope,read:async query=>({status:'READY',items:[],signature:`${scope}:${query.standalone}:${++calls}`})});
  const first=await reader({taskId:10});scope=2;
  const second=await reader({taskId:10});const standalone=await reader({taskId:10,standalone:true});
  assert.notEqual(first,second);assert.notEqual(second,standalone);assert.equal(calls,3);
});

test('missing explicitly requested edits finish once rather than causing a recursive polling loop',async()=>{
  let calls=0;
  const reader=createImageEditStateReader({scope:()=>1,read:async()=>{calls++;return{status:'READY',items:[],signature:'empty'};}});
  await reader({taskId:1,ids:[randomUUID()]});assert.equal(calls,1);
});

test('editor-only polls retain older tracked IDs so shared snapshots keep a stable shape',async()=>{
  const id=randomUUID(),queries=[];let clock=100;
  const reader=createImageEditStateReader({scope:()=>1,now:()=>clock,read:async({ids})=>{queries.push(ids);return{status:'RUNNING',items:ids.map(id=>({id,status:'RUNNING'})),signature:JSON.stringify(ids)};}});
  const initial=await reader({taskId:1,ids:[id]});clock+=1001;
  const editor=await reader({taskId:1});
  assert.equal(editor.signature,initial.signature);assert.deepEqual(queries,[[id],[id]]);
});

test('failed state reads release their flight and can recover without caching an authorization failure',async()=>{
  let calls=0;
  const reader=createImageEditStateReader({scope:()=>1,read:async()=>{if(++calls===1)throw Object.assign(new Error('forbidden'),{status:403});return{status:'READY',items:[],signature:'ok'};}});
  await assert.rejects(reader({taskId:1}),{status:403});assert.equal((await reader({taskId:1})).signature,'ok');assert.equal(calls,2);
});

test('fresh editor opening cannot be unlocked by a queued receipt already in flight before a running claim',async()=>{
  const started=Promise.withResolvers(),pending=Promise.withResolvers();let calls=0;
  const reader=createImageEditStateReader({scope:()=>1,read:async()=>{calls++;if(calls===1){started.resolve();return pending.promise;}return{status:'RUNNING',items:[],signature:'running'};}});
  const background=reader({taskId:1});await started.promise;
  const reopened=reader({taskId:1,fresh:true});
  pending.resolve({status:'QUEUED',items:[],signature:'old queued'});
  assert.equal((await background).status,'QUEUED');assert.equal((await reopened).status,'RUNNING');assert.equal(calls,2);
});

test('heartbeat timestamp changes do not reload history; changed versions and status do',()=>{
  const item={id:randomUUID(),version:1,status:'RUNNING',error:null,updated_at:'yesterday',result:{large:'not part of signature'}};
  assert.equal(imageEditStateSignature([item]),imageEditStateSignature([{...item,updated_at:'today',result:{large:'changed'}}]));
  assert.notEqual(imageEditStateSignature([item]),imageEditStateSignature([{...item,version:2,status:'PREVIEW_READY'}]));
  assert.equal(imageEditPollDelay({items:[item]},true),4000);
  assert.equal(imageEditPollDelay({items:[]},true),15000);
  assert.equal(imageEditPollDelay({items:[item]},false),30000);
  assert.equal(imageEditPollDelay({items:[item],legacy:true},true),15000);
});

test('query operations and staged binary uploads do not refresh workspaces',()=>{
  for(const path of ['/v1/admin/task-data-report/query','/v1/delivery-pool/previews','/v1/query-packages/import-preview',`/v1/image-editor/uploads/${randomUUID()}/1`]) {
    assert.equal(mutationWorkspaceUpdate(`/api/control-plane${path}`,'POST','{}',{}),null,path);
  }
  assert.equal(mutationWorkspaceUpdate('/api/control-plane/v1/tasks/4','GET',null,{}),null);
});

test('business-scoped mutations preserve IDs, compatibility and credential invalidation',()=>{
  const standalone=mutationWorkspaceUpdate('/api/control-plane/v1/image-editor/workspaces/11/image-edits','POST','{}',{});
  assert.deepEqual(standalone.taskIds,[11]);assert.equal(workspaceUpdateMatches(standalone,{scopes:['statistics']}),false);
  assert.equal(workspaceUpdateMatches(standalone,{scopes:['image-editor'],taskIds:[11]}),true);
  assert.equal(workspaceUpdateMatches(standalone,{scopes:['image-editor'],taskIds:[12]}),false);
  const accept=mutationWorkspaceUpdate(`/api/control-plane/v1/image-edits/${randomUUID()}/accept`,'POST','{}',{task_id:12});
  assert.equal(workspaceUpdateMatches(accept,{scopes:['tasks'],taskIds:[12]}),true);
  assert.equal(workspaceUpdateMatches(mutationWorkspaceUpdate('/api/control-plane/v1/users/8','PATCH','{}',{}),{scopes:['image-editor'],taskIds:[11]}),true);
  assert.equal(workspaceUpdateMatches(undefined,{scopes:['delivery']}),true,'old broad events remain supported');
  const reassign=mutationWorkspaceUpdate('/api/control-plane/v1/admin/reassignment-cases/batch','POST','{}',{results:[{item:{taskId:12}},{item:{taskId:13}}]});
  assert.deepEqual(reassign.taskIds,[12,13]);assert.equal(workspaceUpdateMatches(reassign,{scopes:['statistics']}),true);
  assert.equal(workspaceUpdateMatches(reassign,{scopes:['image-editor']}),false);
  assert.equal(workspaceUpdateMatches(mutationWorkspaceUpdate('/api/control-plane/v1/future-action','POST',null,{}),{scopes:['delivery']}),true);
});

test('scoped events coalesce locally and across tabs without losing old broad event compatibility',async()=>{
  const original=globalThis.window;
  const fake=new EventTarget();fake.localStorage={setItem(){}};globalThis.window=fake;
  let taskReads=0,editorReads=0;
  const offTask=subscribeWorkspaceUpdates(()=>taskReads++,{scopes:['tasks']});
  const offEditor=subscribeWorkspaceUpdates(()=>editorReads++,{scopes:['image-editor'],taskIds:[11]});
  try {
    notifyWorkspaceUpdated({scopes:['image-editor'],taskIds:[11]});
    notifyWorkspaceUpdated({scopes:['image-editor'],taskIds:[11]});
    await new Promise(done=>setTimeout(done,350));assert.equal(taskReads,0);assert.equal(editorReads,1);
    const storage=new Event('storage');Object.assign(storage,{key:'xhs:workspace-updated:v1',newValue:'legacy-timestamp-nonce'});fake.dispatchEvent(storage);
    await new Promise(done=>setTimeout(done,350));assert.equal(taskReads,1);assert.equal(editorReads,2);
  } finally {offTask();offEditor();globalThis.window=original;}
});

test('small-image paths use thumbnails without changing source/download or unknown asset paths',()=>{
  assert.equal(thumbnailUrl('/api/control-plane/v1/assets/12'),'/api/control-plane/v1/assets/12?variant=thumbnail');
  assert.equal(thumbnailUrl('/api/control-plane/v1/image-qa/items/private-uuid/assets/12'),'/api/control-plane/v1/image-qa/items/private-uuid/assets/12?variant=thumbnail');
  for(const path of ['/api/control-plane/v1/assets/12?download=true','/api/control-plane/v1/image-editor/assets/12','https://external/image.png'])assert.equal(thumbnailUrl(path),path);
});

test('one shared metadata request completes all tracked image notifications and preserves owner rejection',async()=>{
  const first=randomUUID(),second=randomUUID();let batches=0,full=0;
  const finished=[];
  const store=createBackgroundTaskStore({storageKey:'private',accountUsername:'owner',accountId:1,
    request:async()=>{full++;throw Error('full history must not be needed');},
    requestStates:async rows=>{batches++;return new Map(rows.map(task=>[task.id,{status:'PREVIEW_READY',created_by:task.id===second?'foreign':'owner',created_by_account_id:task.id===second?2:1,metadataOnly:true}]));},
    onComplete:task=>finished.push(task)});
  for(const id of [first,second])store.track({id,kind:'IMAGE_EDIT',taskId:10,status:'RUNNING',ownerUsername:'owner',ownerAccountId:1});
  await store.poll();assert.equal(batches,1);assert.equal(full,0);assert.equal(finished.length,1);assert.equal(finished[0].id,first);
  assert.equal(store.getSnapshot().find(task=>task.id===second).status,'DELETED');
});

test('a completed compact planning receipt fetches the real draft before publishing completion',async()=>{
  const id=randomUUID(),paths=[];const finished=[];
  const store=createBackgroundTaskStore({storageKey:'private',accountUsername:'owner',accountId:1,
    request:async path=>{paths.push(path);return{status:'SUCCEEDED',requestedByUsername:'owner',requestedByAccountId:1,
      ...(path.includes('?full=1')?{copy:{title:'actual draft'}}:{metadataOnly:true})};},onComplete:task=>finished.push(task)});
  store.track({id,kind:'IMAGE_PLAN',taskId:10,status:'RUNNING',ownerUsername:'owner',ownerAccountId:1});
  await store.poll();assert.equal(paths.length,2);assert.ok(paths[1].endsWith('?full=1'));
  assert.equal(finished[0].payload.copy.title,'actual draft');
});

test('unchanged compact progress does not rewrite browser storage or rerender notifications',async()=>{
  const id=randomUUID();let writes=0,updates=0;
  const store=createBackgroundTaskStore({storageKey:'private',accountUsername:'owner',accountId:1,
    storage:{getItem:()=>null,setItem:()=>writes++},request:async()=>{throw Error('unexpected full read');},
    requestStates:async()=>new Map([[id,{status:'RUNNING',created_by:'owner',created_by_account_id:1,metadataOnly:true}]]),onComplete:()=>{throw Error('not completed');}});
  store.subscribe(()=>updates++);
  store.track({id,kind:'IMAGE_EDIT',taskId:10,status:'RUNNING',ownerUsername:'owner',ownerAccountId:1});
  const initialWrites=writes,initialUpdates=updates;
  await store.poll();await store.poll();
  assert.equal(writes,initialWrites);assert.equal(updates,initialUpdates);
});
