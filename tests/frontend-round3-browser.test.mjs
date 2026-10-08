import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('bounded lists, memoized task rows and retryable delivery history work against isolated fake services', {
  skip: process.env.RUN_FRONTEND_ROUND3_BROWSER !== '1', timeout: 180_000,
}, async () => {
  const {build}=await import('esbuild');const {chromium}=await import('playwright-core');
  const output=resolve('.codex_artifacts/frontend-round3');await mkdir(output,{recursive:true});
  const directory=await mkdtemp(join(output,'browser-'));
  await build({stdin:{contents:`
    import './app/globals.css';import React,{useState}from'react';import{createRoot}from'react-dom/client';
    import{CreationWorkbench}from'./app/workbench/creation-workbench';
    import{DEFAULT_WORKBENCH_LIST_STATE}from'./app/workbench/list-state';
    import{LazyOperatorDeliveryHistory}from'./app/workbench/lazy-operator-delivery-history';
    import{CopyQaWorkbench}from'./app/copy-qa/copy-qa-workbench';
    import{KnowledgeTabs}from'./app/knowledge/knowledge-tabs';
    import{ConfirmDialogProvider}from'./components/ui/confirm-dialog';
    import{TextInputDialogProvider}from'./components/ui/text-input-dialog';
    import{Dialog,DialogContent,DialogTitle,DialogTrigger}from'./components/ui/dialog';
    function HistoryFixture(){const[open,setOpen]=useState(false);return <><input aria-label="保留的交付备注"/>
      <Dialog open={open}onOpenChange={setOpen}><DialogTrigger asChild><button>打开交付记录</button></DialogTrigger><DialogContent>
      <DialogTitle>交付记录测试</DialogTitle>{open&&<LazyOperatorDeliveryHistory refreshKey={0}/>}</DialogContent></Dialog></>}
    window.__fixtureLoadHistory=async load=>{window.__historyAttempts++;if(!window.__historyFailed){window.__historyFailed=true;throw Error('isolated chunk failure')}return load()};
    const query=new URLSearchParams(location.search),role=query.get('role')||'ADMIN';
    const content=location.pathname==='/history'?<HistoryFixture/>:location.pathname==='/copy-qa'?<CopyQaWorkbench/>
      :location.pathname==='/knowledge'?<KnowledgeTabs visualItems={[]}copyItems={[]}copyPagination={{page:1,pageSize:10,totalItems:0,totalPages:1}}copyLabels={[]}copyAnalysisPrompts={[]}copySelectedLabel="ALL"copySearchQuery=""knowledgeEnabled remote/>
      :<CreationWorkbench role={role}nodeId="fixture"creatorUserId="admin"creatorAccountId={1}viewKey={role==='USER'?'PERSONAL':'ALL_JOBS'}initialListState={{...DEFAULT_WORKBENCH_LIST_STATE,pageSize:100}}/>;
    createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><TextInputDialogProvider>{content}</TextInputDialogProvider></ConfirmDialogProvider>);
  `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,splitting:true,format:'esm',outdir:directory,entryNames:'bundle',
  jsx:'automatic',platform:'browser',conditions:['style'],alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"test"'},
  plugins:[{name:'actual-components-fixture',setup(plugin){
    plugin.onLoad({filter:/creation-workbench\.tsx$/},async args=>({loader:'tsx',resolveDir:resolve('app/workbench'),
      contents:(await readFile(args.path,'utf8')).replace('  const { showTaskSelection, role, canOperatorDeliverTask, activeView, creatorUserId, creatorAccountId,',
        '  window.__rowRenders++;\n  const { showTaskSelection, role, canOperatorDeliverTask, activeView, creatorUserId, creatorAccountId,')
        .replace('function timeLabel(value: string | null, state?: TaskState) {','function timeLabel(value: string | null, state?: TaskState) { window.__timeLabels++;')}));
    plugin.onLoad({filter:/lazy-operator-delivery-history\.tsx$/},async args=>({loader:'tsx',resolveDir:resolve('app/workbench'),
      contents:(await readFile(args.path,'utf8')).replace("void import('./operator-delivery-history')","void window.__fixtureLoadHistory(() => import('./operator-delivery-history'))")}));
    plugin.onResolve({filter:/^next\/(navigation|link|dynamic)$/},args=>({path:args.path,namespace:'next-fixture'}));
    plugin.onLoad({filter:/.*/,namespace:'next-fixture'},args=>({loader:'jsx',resolveDir:process.cwd(),contents:args.path.endsWith('navigation')
      ?`export const usePathname=()=>location.pathname;const router={replace:()=>{throw Error('unexpected navigation')},push:path=>location.assign(path),refresh:()=>{}};export const useRouter=()=>router;`
      :args.path.endsWith('dynamic')?`import React,{lazy,Suspense}from'react';export default function dynamic(loader,options={}){const Component=lazy(()=>loader().then(value=>({default:value.default??value})));return props=><Suspense fallback={options.loading?<options.loading/>:null}><Component {...props}/></Suspense>}`
      :`import React from'react';export default function Link({children,...props}){return <a {...props}>{children}</a>}`}));
  }}]});
  const {default:postcss}=await import('postcss');const {default:tailwind}=await import('@tailwindcss/postcss');
  const {css}=await postcss([tailwind()]).process(await readFile(join(directory,'bundle.css'),'utf8'),{from:resolve('app/globals.css')});
  const tasks=Array.from({length:100},(_,index)=>({id:index+1,query:`性能验证作业 ${index+1}`,state:'COPY_QUEUED',currentStage:'COPY_QUEUED',
    createdAt:'2026-10-01T08:00:00Z',updatedAt:'2026-10-02T08:00:00Z',input:{},progressPercent:0,
    createdByUserId:'admin',createdByAccountId:1,createdByRole:'ADMIN',assignedToUserId:'admin',assignedToAccountId:1}));
  const batchId='81818181-8181-4818-8818-818181818181';
  const batch={id:batchId,displayName:'分页质检批次',mode:'PERSONAL_MANUAL',status:'INSPECTING',memberCount:120,sampleCount:120,
    pendingCount:119,passedCount:0,returnedCount:0,discardedCount:1,affectedCount:0,fullInspection:true,returnTriggerCount:60,createdAt:'2026-10-02T00:00:00Z'};
  const items=Array.from({length:120},(_,index)=>({id:`item-${index+1}`,taskId:null,query:null,approverUsername:null,
    content:{copy:{title:`分页文案 ${index+1}`,body:'假数据正文'.repeat(100),tags:[]},imagePlan:[]},status:index===119?'DISCARDED':'PENDING',
    revisionToken:'a'.repeat(64),discardReasonCode:index===119?'OFF_TOPIC':null,dispositionNote:index===119?'假数据废弃说明':null}));
  const reads=[],errors=[],unexpected=[],jsRequests=[];const evidence={};let browser,page;
  const server=createServer(async(request,response)=>{
    const url=new URL(request.url,'http://localhost');const reply=data=>{response.setHeader('content-type','application/json');response.end(JSON.stringify({data}));};
    if(url.pathname.endsWith('.js')){jsRequests.push(url.pathname);response.setHeader('content-type','application/javascript');response.end(await readFile(join(directory,url.pathname.slice(1))));return;}
    if(url.pathname==='/bundle.css'){response.setHeader('content-type','text/css');response.end(css);return;}
    if(!url.pathname.startsWith('/api/')){response.setHeader('content-type','text/html; charset=utf-8');response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><body style="padding:24px"><main id="root"></main><script>window.__rowRenders=0;window.__timeLabels=0;window.__historyAttempts=0;</script><script type="module" src="/bundle.js"></script></body></html>');return;}
    reads.push(`${request.method} ${url.pathname}${url.search}`);
    if(url.pathname==='/api/control-plane/health'){reply({capabilities:{adminTaskFilters:true,adminTaskActivityDateFilters:1}});return;}
    if(url.pathname.endsWith('/task-views')||url.pathname.endsWith('/nodes')){reply([]);return;}
    if(url.pathname==='/api/control-plane/v1/tasks'){reply({items:tasks,total:100,limit:100,offset:0});return;}
    if(url.pathname==='/api/control-plane/v1/delivery-items'){reply({items:[],total:0,summary:{total:0,unpacked:0,packed:0,delivered:0,updated:0},updatedAt:'2026-10-02T00:00:00Z'});return;}
    if(url.pathname==='/api/control-plane/v2/copy-qa/batches'){
      const offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||20);
      const target=url.searchParams.get('view');if(target==='FINISHED')await new Promise(resolve=>setTimeout(resolve,150));
      const rows=Array.from({length:25},(_,index)=>({...batch,displayName:target==='FINISHED'?`已完成批次 ${index+1}`:index===0?batch.displayName:`待质检批次 ${index+1}`}));
      reply({items:rows.slice(offset,offset+limit),total:rows.length,limit,offset});return;
    }
    if(url.pathname===`/api/control-plane/v2/copy-qa/batches/${batchId}`){
      const offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||50);
      reply({batch,items:items.slice(offset,offset+limit),pagination:{total:items.length,limit,offset}});return;
    }
    if(request.method==='POST'&&url.pathname.match(/^\/api\/control-plane\/v2\/copy-qa\/items\/item-\d+\/decision$/u)){
      const chunks=[];for await(const chunk of request)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks));
      assert.equal(input.decision,'PASS');assert.equal(input.revisionToken,'a'.repeat(64));assert.ok(input.requestId);
      const item=items.find(item=>url.pathname.includes(`/items/${item.id}/`));item.status='PASSED';batch.pendingCount--;batch.passedCount++;
      reply({id:item.id,status:'PASSED'});return;
    }
    unexpected.push(`${request.method} ${url.pathname}`);response.statusCode=404;reply({});
  });
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`${origin}/workbench/all`);await page.waitForFunction(()=>document.querySelectorAll('button.workbench-query-preview').length===100);
    const firstActivity=await page.evaluate(()=>({actual:document.querySelector('tbody .workbench-col-time time')?.textContent,
      expected:`最近变更：${new Date('2026-10-02T08:00:00Z').toLocaleString('zh-CN',{hour12:false})}`}));
    assert.equal(firstActivity.actual,firstActivity.expected,'formatter reuse must preserve date, hour, minute and second');
    await page.waitForTimeout(80);const taskReads=reads.filter(read=>read.startsWith('GET /api/control-plane/v1/tasks?')).length;
    const measure=async action=>{await page.evaluate(()=>{window.__rowRenders=0;window.__timeLabels=0;});await action();await page.waitForTimeout(80);return page.evaluate(()=>({rows:window.__rowRenders,timeLabels:window.__timeLabels}));};
    evidence.input=await measure(()=>page.locator('#workbench-query-search').fill('a'));
    assert.equal(evidence.input.rows,0,'input must not render any task row');assert.ok(evidence.input.timeLabels<=1);
    evidence.selection=await measure(()=>page.getByRole('checkbox',{name:'选择任务 #1',exact:true}).check());
    assert.equal(evidence.selection.rows,1,'single selection only renders the changed row');assert.ok(evidence.selection.timeLabels<=4);
    assert.equal(reads.filter(read=>read.startsWith('GET /api/control-plane/v1/tasks?')).length,taskReads,'input and selection must not fetch tasks');
    await page.screenshot({path:join(directory,'memoized-task-rows.png'),fullPage:true});
    assert.equal(reads.some(read=>read.includes('/delivery-items?')),false,'closed history performs no business request');
    const lazyBefore=jsRequests.length;
    await page.goto(`${origin}/history`);await page.getByLabel('保留的交付备注').fill('未提交交付备注');
    assert.equal(await page.evaluate(()=>window.__historyAttempts),0);
    const historyTrigger=page.getByRole('button',{name:'打开交付记录',exact:true});await historyTrigger.focus();await page.keyboard.press('Enter');
    await page.getByRole('button',{name:'重新加载交付记录',exact:true}).waitFor();assert.equal(await page.getByLabel('保留的交付备注').inputValue(),'未提交交付备注');
    await page.getByRole('button',{name:'重新加载交付记录',exact:true}).click();await page.getByLabel('搜索交付内容').waitFor();
    assert.equal(await page.evaluate(()=>window.__historyAttempts),2);assert.ok(reads.some(read=>read.includes('/delivery-items?')));
    assert.ok(jsRequests.length>lazyBefore,'retry loads the deferred history chunk');
    await page.getByRole('button',{name:'关闭弹窗',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});
    await page.waitForFunction(()=>document.activeElement?.textContent==='打开交付记录');
    assert.equal(await historyTrigger.evaluate(element=>element===document.activeElement),true);
    assert.equal(await page.getByLabel('保留的交付备注').inputValue(),'未提交交付备注');
    await page.goto(`${origin}/knowledge`);await page.getByRole('heading',{name:'知识库使用',exact:true}).waitFor();
    assert.equal(await page.locator('#knowledge-panel-visual').count(),0,'hidden visual workbench is not mounted');
    await page.goto(`${origin}/copy-qa`);await page.getByRole('cell',{name:'分页质检批次',exact:true}).waitFor();
    assert.equal(await page.locator('tbody tr').count(),20);
    const listPagination=page.getByRole('navigation',{name:'质检批次分页'});await listPagination.getByRole('button',{name:'下一页',exact:true}).click();
    await page.getByRole('cell',{name:'待质检批次 21',exact:true}).waitFor();assert.equal(await page.locator('tbody tr').count(),5);
    await listPagination.getByRole('button',{name:'上一页',exact:true}).click();await page.getByRole('cell',{name:'分页质检批次',exact:true}).waitFor();
    await page.getByRole('button',{name:'进入批次',exact:true}).first().click();await page.getByRole('cell',{name:'分页文案 1',exact:true}).waitFor();
    assert.equal(await page.locator('tbody tr').count(),50);assert.match(await page.locator('body').innerText(),/已废弃\s+1/u);
    const detailPagination=page.getByRole('navigation',{name:'质检明细分页'});await detailPagination.getByRole('button',{name:'下一页',exact:true}).click();
    await page.getByRole('cell',{name:'分页文案 51',exact:true}).waitFor();
    assert.equal(await page.getByRole('cell',{name:'盲评项 51',exact:true}).count(),1);
    const mutationStart=reads.length;await page.getByRole('button',{name:'查看并质检',exact:true}).first().click();
    await page.getByRole('dialog').getByRole('button',{name:'通过质检',exact:true}).click();
    await page.getByRole('alertdialog').getByRole('button',{name:'确认通过',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'detached'});await page.waitForTimeout(80);
    const mutationReads=reads.slice(mutationStart);evidence.qaDecision=mutationReads;
    assert.equal(mutationReads.filter(read=>read.startsWith('GET /api/control-plane/v2/copy-qa/batches?')).length,0,'decision must not refresh the invisible full batch list');
    assert.equal(mutationReads.filter(read=>read.startsWith(`GET /api/control-plane/v2/copy-qa/batches/${batchId}?`)).length,1);
    assert.ok(mutationReads.some(read=>read.includes('limit=50&offset=50')));assert.match(await page.locator('body').innerText(),/待质检\s+118/u);
    await page.getByRole('button',{name:'← 返回批次列表',exact:true}).click();await page.getByRole('cell',{name:'分页质检批次',exact:true}).waitFor();
    assert.equal(reads.slice(mutationStart).filter(read=>read.startsWith('GET /api/control-plane/v2/copy-qa/batches?')).length,1);
    await page.getByRole('tab',{name:'已完成批次',exact:true}).click();await page.getByRole('tab',{name:'待质检批次',exact:true}).click();
    await page.waitForTimeout(250);assert.equal(await page.getByRole('cell',{name:'已完成批次 1',exact:true}).count(),0,'stale status response must not replace the current view');
    assert.equal(await page.getByRole('cell',{name:'分页质检批次',exact:true}).count(),1);
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
    await page.screenshot({path:join(directory,'bounded-copy-qa.png'),fullPage:true});
    await writeFile(join(directory,'evidence.json'),JSON.stringify({...evidence,requests:reads,jsRequests},null,2));
    console.log(`Round 3 fake browser evidence: ${directory}`);
  }catch(error){if(page){await page.screenshot({path:join(directory,'failure.png'),fullPage:true});throw new Error(`${error.message}\nErrors: ${errors.join('; ')}\nUnexpected: ${unexpected.join('; ')}\n${await page.locator('body').innerText()}`,{cause:error});}throw error;}
  finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
