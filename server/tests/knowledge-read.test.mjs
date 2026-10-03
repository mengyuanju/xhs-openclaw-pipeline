import assert from 'node:assert/strict';
import test from 'node:test';
import { listCopyKnowledgeOverview } from '../src/knowledge-read.mjs';
import { installConfigurationRoutes } from '../src/http-configuration-routes.mjs';

test('copy library reads only newest copy versions and one bounded page with independent label totals',async()=>{
  const statements=[];
  const pool={async query(sql,values){statements.push({sql,values});return {rows:[{page:2,total:15,total_pages:2,
    items:[{id:7,name:'旧名称',content:{title:'ＡＢＣ',labels:['科普'],analysis:'完整分析',createdAt:'saved-date'},createdAt:'version-date'}],
    labels:[{name:'B',itemCount:2},{name:'A',itemCount:3}]}]};}};
  const result=await listCopyKnowledgeOverview(pool,{page:999,pageSize:10,label:' 科普 ',query:' ＡＢＣ '});
  assert.equal(statements.length,1);assert.deepEqual(statements[0].values,[999,10,'科普','abc']);
  assert.match(statements[0].sql,/WHERE i\.kind = 'COPY' AND i\.status <> 'ARCHIVED'/u);
  assert.match(statements[0].sql,/WHERE item_id = i\.id ORDER BY version DESC LIMIT 1/u);
  assert.match(statements[0].sql,/LIMIT \$2 OFFSET/u);
  assert.match(statements[0].sql,/labels AS \([\s\S]*FROM copies/u);
  const copies=statements[0].sql.split('), filtered')[0];
  assert.doesNotMatch(copies,/SELECT[^\n]*v\.content(?:,|\s)/u,'full analysis content must be read only after pagination');
  assert.match(statements[0].sql,/JOIN knowledge_versions v ON v\.id = selected\.version_id/u);
  assert.match(statements[0].sql,/CASE WHEN jsonb_typeof\(content->'labels'\) = 'array'/u);
  assert.match(statements[0].sql,/WHERE jsonb_typeof\(label\.value\) = 'string'/u);
  assert.equal(result.data[0].analysis,'完整分析');assert.equal(result.data[0].createdAt,'saved-date');
  assert.deepEqual(result.pagination,{page:2,pageSize:10,totalItems:15,totalPages:2});
  assert.deepEqual(result.labels,[{name:'A',itemCount:3},{name:'B',itemCount:2}]);
  for(const options of [{page:0},{pageSize:101},{query:'x'.repeat(201)},{label:[]},{page:1.2}]){
    await assert.rejects(listCopyKnowledgeOverview(pool,options),TypeError);
  }
  assert.equal(statements.length,1);
});

test('copy overview is an administrator-only read route',async()=>{
  const routes=new Map();const router=new Proxy({}, {get:(_,method)=>(path,handler)=>routes.set(`${method} ${path}`,handler)});
  let reads=0;const repository={listCopyKnowledgeOverview:async options=>{reads++;assert.equal(options.pageSize,'10');return {data:[],pagination:{page:1,pageSize:10,totalItems:0,totalPages:1},labels:[]};}};
  installConfigurationRoutes({router,repository});
  const handler=routes.get('get /v1/copy-knowledge');assert.equal(typeof handler,'function');
  for(const role of ['USER','REVIEWER'])await assert.rejects(handler({state:{actor:{role}},query:{pageSize:'10'}}));
  assert.equal(reads,0);
  const ctx={state:{actor:{role:'ADMIN'}},query:{pageSize:'10'}};await handler(ctx);
  assert.equal(reads,1);assert.equal(ctx.status,200);assert.equal(ctx.body.data.pagination.pageSize,10);
});
