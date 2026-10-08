import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteKnowledgeStore } from '../src/admin/remote-knowledge-store.mjs';
import { listAllKnowledge } from '../src/admin/knowledge-runtime.mjs';

function library() {
  return Array.from({length:120},(_,index)=>({id:index+1,kind:index<100?'VISUAL':'COPY',status:'ACTIVE',name:`案例 ${index}`,
    versions:[{id:index+1000,version:1,status:'PUBLISHED',content:{title:`案例 ${index}`,labels:['科普']}}]}));
}

test('remote knowledge fallback shares one request per store, isolates stores and invalidates after mutation',async()=>{
  const items=library();let reads=0;
  const client={listKnowledge:async()=>{reads++;return structuredClone(items);},
    createKnowledgeVersion:async()=>{items.push({id:121,kind:'COPY',status:'ACTIVE',versions:[{id:1200,version:1,status:'PUBLISHED',content:{title:'新案例',labels:['新标签']}}]});return {itemId:121,status:'PUBLISHED'};},
    retireKnowledge:async id=>{items.find(item=>item.id===id).status='ARCHIVED';}};
  const store=createRemoteKnowledgeStore(client);
  const [visual,copy,labels]=await Promise.all([listAllKnowledge(store,'listVisualKnowledge'),store.listCopyKnowledge({pageSize:10}),store.listCopyKnowledgeLabels()]);
  assert.equal(reads,1);assert.equal(visual.length,100);assert.equal(copy.data.length,10);assert.equal(copy.pagination.totalItems,20);
  assert.deepEqual(labels,[{name:'科普',itemCount:20}]);
  const other=createRemoteKnowledgeStore(client);await other.listCopyKnowledge();assert.equal(reads,2);
  await store.createCopyKnowledge({title:'新案例',sourceCopy:'原文',analysisPrompt:'分析',summary:'摘要',analysis:'完整分析',labels:['新标签']});
  assert.equal((await store.listCopyKnowledge()).pagination.totalItems,21);assert.equal(reads,3);
  await store.deleteCopyKnowledge(121);assert.equal((await store.listCopyKnowledge()).pagination.totalItems,20);assert.equal(reads,4);
});

test('remote overview uses one bounded central read and never falls back on an authorization error',async()=>{
  let reads=0;
  const client={listKnowledge:()=>assert.fail('native page must not download full knowledge'),
    listCopyKnowledgeOverview:async options=>{reads++;assert.deepEqual(options,{page:2,pageSize:10,label:'科普'});return {data:[{id:42}],pagination:{page:2,pageSize:10,totalItems:100,totalPages:10},labels:[{name:'科普',itemCount:100}]};}};
  const result=await createRemoteKnowledgeStore(client).listCopyKnowledgeOverview({page:2,pageSize:10,label:'科普'});
  assert.equal(reads,1);assert.equal(result.data.length,1);assert.equal(result.labels[0].itemCount,100);
  for(const status of [401,403,503]){
    const store=createRemoteKnowledgeStore({...client,listCopyKnowledgeOverview:async()=>{throw Object.assign(new Error('denied'),{status});}});
    await assert.rejects(store.listCopyKnowledgeOverview(),{status});
  }
});

test('old centers fall back on missing endpoints, clamp pages and retry failed snapshots',async()=>{
  let reads=0;
  const store=createRemoteKnowledgeStore({listCopyKnowledgeOverview:async()=>{throw Object.assign(new Error('missing'),{status:404});},
    listKnowledge:async()=>{if(++reads===1)throw new Error('temporary read');return library();}});
  await assert.rejects(store.listCopyKnowledgeOverview(),/temporary read/);
  const result=await store.listCopyKnowledgeOverview({page:999,pageSize:10});
  assert.equal(reads,2);assert.equal(result.pagination.page,2);assert.equal(result.data.length,10);
});
