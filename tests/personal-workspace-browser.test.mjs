import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp,readFile,rm,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizePersonalFilters,selectPersonalTasks,summarizePersonalToday,summarizePersonalWorkspace } from '../src/personal-workspace.mjs';
import { DEFAULT_HUMAN_QUALITY_SETTINGS } from '../src/human-quality-settings.mjs';
import { qaMetricRows } from '../src/quality-review-statistics.mjs';

test('personal workspace browser: all submissions, real QA and batch coverage, stable refresh, drilldowns and mobile',{
  skip:process.env.RUN_PERSONAL_WORKSPACE_BROWSER !== '1',timeout:90_000,
},async()=>{
  const {build}=await import('esbuild'); const {chromium}=await import('playwright-core');
  const root=await mkdtemp(join(tmpdir(),'personal-workspace-browser-'));
  const now=Date.now();
  const make=(id,extra={})=>({id,query:`桌面整理 ${id}`,state:'COPY_REVIEW_PENDING',isAssigned:true,isCreated:true,canOpen:true,
    createdAt:new Date(now-172800000).toISOString(),queueEnteredAt:new Date(now-90000000).toISOString(),prioritySortAt:new Date(now-90000000).toISOString(),
    assignedToUserId:'worker',assignedToAccountId:22,createdByUserId:'worker',createdByAccountId:22,
    currentCopyRevisionId:1,currentImageRunId:null,progressPercent:100,progressMessage:'等待审核',...extra});
  let facts=[make(1),make(2,{copyReworkOrigin:'QA_RETURN',reworkCount:2,returnNote:'修正文案事实错误',returnedAt:new Date(now-90000000).toISOString()}),
    make(3,{state:'IMAGE_REWORK_PENDING',reworkTarget:'BOTH',reworkCount:1}),make(4,{isAssigned:false,isCreated:false,canOpen:false})];
  const events=[{id:'done',taskId:4,kind:'COMPLETE',stage:'COPY',at:new Date(now).toISOString(),rework:false}];
  const submissions=[
    {id:'copy-first',taskId:2,kind:'COMPLETE',stage:'COPY',at:new Date(now).toISOString(),firstSubmission:true,rework:false},
    {id:'copy-rework-1',taskId:2,kind:'COMPLETE',stage:'COPY',at:new Date(now).toISOString(),firstSubmission:false,rework:true},
    {id:'copy-rework-2',taskId:2,kind:'COMPLETE',stage:'COPY',at:new Date(now).toISOString(),firstSubmission:false,rework:true},
    {id:'copy-repeat',taskId:2,kind:'COMPLETE',stage:'COPY',at:new Date(now).toISOString(),firstSubmission:false,rework:false},
    {id:'image-first',taskId:3,kind:'COMPLETE',stage:'IMAGE',at:new Date(now).toISOString(),firstSubmission:true,rework:false},
    {id:'image-repeat',taskId:3,kind:'COMPLETE',stage:'IMAGE',at:new Date(now).toISOString(),firstSubmission:false,rework:false},
  ];
  const qualityFacts=[
    {id:'quality-copy-first',kind:'ANNOTATION_QUALITY',taskId:2,accountId:22,stage:'COPY',at:new Date(now).toISOString(),outcome:'PASS',firstPassed:true},
    {id:'quality-copy-rework',kind:'ANNOTATION_QUALITY',taskId:2,accountId:22,stage:'COPY',at:new Date(now).toISOString(),outcome:'PASS',firstPassed:false},
    {id:'quality-copy-return',kind:'ANNOTATION_QUALITY',taskId:3,accountId:22,stage:'COPY',at:new Date(now).toISOString(),outcome:'RETURN',firstPassed:false},
    {id:'quality-image-first',kind:'ANNOTATION_QUALITY',taskId:3,accountId:22,stage:'IMAGE',at:new Date(now).toISOString(),outcome:'PASS',firstPassed:true},
    {id:'quality-image-return',kind:'ANNOTATION_QUALITY',taskId:1,accountId:22,stage:'IMAGE',at:new Date(now).toISOString(),outcome:'RETURN',firstPassed:false},
  ];
  const qaEvents=Array.from({length:8},(_,i)=>({id:`qa:${i}`,samplingItemId:i+1,taskId:i+1,accountId:22,
    stage:i<5?'COPY':'IMAGE',kind:'QA_REVIEW',sampleKind:i===3||i===4||i===7?'MANDATORY_RECHECK':'RANDOM',
    outcome:i===2||i===6?'RETURN':'PASS',at:new Date(now).toISOString()}));
  qaEvents.push({id:'qa:escalated',samplingItemId:9,taskId:9,accountId:22,stage:'COPY',kind:'QA_ESCALATE',
    sampleKind:'RANDOM',outcome:'ESCALATE',at:new Date(now).toISOString()},
  {id:'qa:discarded',samplingItemId:10,taskId:10,accountId:22,stage:'IMAGE',kind:'QA_DISCARD',
    sampleKind:'RANDOM',outcome:'DISCARD',at:new Date(now).toISOString()});
  const actualQaRows=stage=>qaEvents.filter(row=>row.stage===stage&&['QA_REVIEW','QA_DISCARD','QA_ESCALATE'].includes(row.kind));
  const coverageRows={
    COPY:[...actualQaRows('COPY').map(row=>({...row,coverageSources:['DIRECT']})),
      {id:'coverage-copy-release',taskId:101,stage:'COPY',kind:'QA_COVERAGE',outcome:'RELEASE',at:new Date(now).toISOString(),coverageSources:['BATCH_RELEASE']}],
    IMAGE:[...actualQaRows('IMAGE').map(row=>({...row,coverageSources:row.id==='qa:5'?['DIRECT','BATCH_RELEASE']
      :row.id==='qa:6'?['DIRECT','BATCH_RETURN']:['DIRECT']})),
      ...Array.from({length:14},(_,i)=>({id:`coverage-image-${i}`,taskId:101+i,stage:'IMAGE',kind:'QA_COVERAGE',
        outcome:i===0?'RETURN':'RELEASE',at:new Date(now).toISOString(),coverageSources:[i===0?'BATCH_RETURN':'BATCH_RELEASE']}))],
  };
  const coverageIncomplete={COPY:false,IMAGE:false};
  const qaExtra=stage=>({actualOperations:actualQaRows(stage).length,processingCoverage:coverageRows[stage].length,
    batchReturned:coverageRows[stage].filter(row=>row.coverageSources.includes('BATCH_RETURN')).length,
    batchReleased:coverageRows[stage].filter(row=>row.coverageSources.includes('BATCH_RELEASE')).length,
    discarded:actualQaRows(stage).filter(row=>row.kind==='QA_DISCARD').length,
    escalated:actualQaRows(stage).filter(row=>row.kind==='QA_ESCALATE').length,coverageIncomplete:coverageIncomplete[stage]});
  let browser,server,failStatistics=false,delayStatistics=false,abortedStatistics=0;
  const errors=[],requests=[];
  const delayedStatisticsListeners=[];
  const nextDelayedStatistics=()=>new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('expected a delayed statistics request')),5_000);
    delayedStatisticsListeners.push(send=>{clearTimeout(timeout);resolve(send);});
  });
  const statisticsRequests=()=>requests.filter(url=>url.includes('/personal-workspace/statistics?'));
  try {
    await build({stdin:{contents:`
      import './app/globals.css';
      import React from 'react';import{createRoot}from'react-dom/client';
      import{ConfirmDialogProvider}from'./components/ui/confirm-dialog';
      import{TextInputDialogProvider}from'./components/ui/text-input-dialog';
      import{PersonalStatisticsDashboard}from'./app/workbench/personal-statistics/personal-statistics-dashboard';
      import{CreationWorkbench}from'./app/workbench/creation-workbench';
      import{parseWorkbenchListState}from'./app/workbench/list-state';
      import{parsePersonalOptions}from'./app/workbench/personal-filters';
      import{normalizePersonalFilters}from'./src/personal-workspace.mjs';
      const input=Object.fromEntries(new URLSearchParams(location.search));
      const options=parsePersonalOptions(input),filters=normalizePersonalFilters({...input,...options});
      const initial={...parseWorkbenchListState(input),state:filters.category,personalScope:filters.personalScope,sort:filters.sort};
      createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><TextInputDialogProvider>
        {location.pathname.endsWith('personal-statistics') ? <PersonalStatisticsDashboard canDeliver/> : <CreationWorkbench role="USER" nodeId="test" creatorUserId="worker" creatorAccountId={22} viewKey="PERSONAL" initialListState={initial} initialPersonalOptions={options}/>}
      </TextInputDialogProvider></ConfirmDialogProvider>);
    `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,outfile:join(root,'bundle.js'),jsx:'automatic',platform:'browser',conditions:['style'],
      alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"test"'},plugins:[{name:'next-test',setup(plugin){
        plugin.onResolve({filter:/^next\/(navigation|link|dynamic)$/},args=>({path:args.path,namespace:'next-test'}));
        plugin.onLoad({filter:/.*/,namespace:'next-test'},args=>({loader:'jsx',resolveDir:process.cwd(),contents:args.path.endsWith('navigation')
          ? `export const usePathname=()=>location.pathname;const router={replace:path=>history.replaceState(null,'',path),push:path=>location.assign(path),refresh:()=>{}};export const useRouter=()=>router;`
          : args.path.endsWith('link') ? `import React from 'react';export default function Link({children,...props}){return <a {...props}>{children}</a>}`
          : `import React,{lazy,Suspense}from'react';export default function dynamic(loader){const C=lazy(loader);return props=><Suspense fallback={<span>图表加载中</span>}><C {...props}/></Suspense>}` }));
      }}]});
    const [js,rawCss]=await Promise.all([readFile(join(root,'bundle.js')),readFile(join(root,'bundle.css'),'utf8')]);
    const {default:postcss}=await import('postcss'), {default:tailwind}=await import('@tailwindcss/postcss');
    const {css}=await postcss([tailwind()]).process(rawCss,{from:join(process.cwd(),'app/globals.css')});
    server=createServer((req,res)=>{
      if(req.url==='/bundle.js'){res.setHeader('content-type','application/javascript');res.end(js);return;}
      if(req.url==='/bundle.css'){res.setHeader('content-type','text/css');res.end(css);return;}
      if(req.url.startsWith('/api/')){
        requests.push(req.url); const url=new URL(req.url,'http://localhost'); let data;
        if(url.pathname.endsWith('/personal-workspace/statistics')){
          if(failStatistics){res.statusCode=503;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:{code:'TEST_UNAVAILABLE',message:'统计服务暂不可用'}}));return;}
          const filters=normalizePersonalFilters(Object.fromEntries(url.searchParams));
          data=url.searchParams.get('section')==='personal'
            ? summarizePersonalToday(submissions,qualityFacts,qaEvents,filters.range)
            : {section:'jobs',...summarizePersonalWorkspace(facts,events,[],filters)};
          if(data.section==='personal')for(const stage of ['COPY','IMAGE'])Object.assign(data.qa[stage],qaExtra(stage));
        } else if(url.pathname.endsWith('/personal-workspace/qa-activities')) {
          const metric=url.searchParams.get('metric'),stage=url.searchParams.get('stage');
          let rows=metric==='submitAll' ? submissions
            : metric==='submitFirst' ? submissions.filter(row=>row.firstSubmission&&!row.rework)
            : metric==='submitRework' ? submissions.filter(row=>row.rework)
            : metric==='qaActual' ? actualQaRows(stage)
            : metric==='qaCoverage' ? coverageRows[stage]
            : metric==='qaBatchReturned' ? coverageRows[stage].filter(row=>row.coverageSources.includes('BATCH_RETURN'))
            : metric==='qaBatchReleased' ? coverageRows[stage].filter(row=>row.coverageSources.includes('BATCH_RELEASE'))
            : metric==='qaDiscarded' ? actualQaRows(stage).filter(row=>row.kind==='QA_DISCARD')
            : metric==='qaEscalated' ? actualQaRows(stage).filter(row=>row.kind==='QA_ESCALATE')
            : metric==='qaFirst'||metric==='qaRecheck' ? actualQaRows(stage)
            : qaMetricRows(qaEvents,'qa',stage);
          rows=rows.filter(row=>row.stage===stage);
          if(metric==='qaFirst')rows=rows.filter(row=>row.sampleKind!=='MANDATORY_RECHECK');
          if(metric==='qaRecheck')rows=rows.filter(row=>row.sampleKind==='MANDATORY_RECHECK');
          if(metric==='qaPassed')rows=rows.filter(row=>row.outcome==='PASS');
          if(metric==='qaReturned')rows=rows.filter(row=>row.outcome==='RETURN');
          const pageSize=15,page=Math.min(Number(url.searchParams.get('page')??1),Math.max(1,Math.ceil(rows.length/pageSize)));
          data={items:rows.slice((page-1)*pageSize,page*pageSize).map(row=>({id:row.id,code:`ACT-${row.id}`,kind:row.kind,stage:row.stage,
            outcome:row.outcome,coverageSources:row.coverageSources,manualKinds:row.manualKinds,
            submissionType:row.rework?'REWORK':row.firstSubmission?'FIRST':'REPEAT',sampleKind:row.sampleKind,at:row.at})),
            total:rows.length,page,pageSize,coverageIncomplete:['qaCoverage','qaBatchReturned','qaBatchReleased'].includes(metric)&&coverageIncomplete[stage]};
        } else if(url.pathname.endsWith('/personal-workspace/tasks')) {
          data=selectPersonalTasks(facts,events,normalizePersonalFilters(Object.fromEntries(url.searchParams)));
          data.items=data.items.map(item=>({...item,personalHistory:item.history}));data.updatedAt=new Date().toISOString();
        } else if(url.pathname.endsWith('/delivery-items')) data={items:[],total:0,summary:{total:0,unpacked:0,packed:0,delivered:0,updated:0},updatedAt:new Date().toISOString()};
        else if(url.pathname==='/api/human-quality-settings') data=DEFAULT_HUMAN_QUALITY_SETTINGS;
        else {res.statusCode=404;data=null;}
        const send=()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data}));};
        if(delayStatistics&&url.pathname.endsWith('/personal-workspace/statistics')){
          res.on('close',()=>{if(!res.writableEnded)abortedStatistics++;});
          for(const resolve of delayedStatisticsListeners.splice(0))resolve(send);
          return;
        }
        send();return;
      }
      res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><body style="padding:24px"><main id="root"></main><script src="/bundle.js"></script></body></html>');
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{
      const schedule=window.setInterval.bind(window),cancel=window.clearInterval.bind(window);
      const scheduleTimeout=window.setTimeout.bind(window),cancelTimeout=window.clearTimeout.bind(window);
      window.__testIntervals=new Map();
      window.__holdWorkspaceDebounce=false;
      window.__heldWorkspaceTimeouts=new Map();
      window.setTimeout=(callback,delay,...args)=>{
        if(window.__holdWorkspaceDebounce&&delay===300){
          const id=scheduleTimeout(()=>{},1);cancelTimeout(id);
          window.__heldWorkspaceTimeouts.set(id,()=>callback(...args));
          return id;
        }
        return scheduleTimeout(callback,delay,...args);
      };
      window.clearTimeout=id=>{window.__heldWorkspaceTimeouts.delete(id);cancelTimeout(id);};
      window.setInterval=(callback,delay,...args)=>{
        const id=schedule(callback,delay,...args);
        window.__testIntervals.set(id,{delay,tick:()=>callback(...args)});
        return id;
      };
      window.clearInterval=id=>{window.__testIntervals.delete(id);cancel(id);};
    });
    await page.goto(`${base}/workbench/personal-statistics`);
    await page.getByRole('heading',{name:'今日标注与图片初审',exact:true}).waitFor();
    const copyArticle=page.getByRole('article').filter({has:page.getByRole('heading',{name:'文案标注',exact:true})});
    const imageArticle=page.getByRole('article').filter({has:page.getByRole('heading',{name:'图片标注／初审',exact:true})});
    const copyAll=copyArticle.getByRole('button').filter({hasText:'文案今日全部提交'});
    const imageAll=imageArticle.getByRole('button').filter({hasText:'图片今日全部提交'});
    await copyArticle.getByRole('button').filter({hasText:'文案返修提交'}).getByText('2',{exact:true}).waitFor();
    assert.match(await copyAll.textContent(),/文案今日全部提交\s*4/u);
    assert.match(await imageAll.textContent(),/图片今日全部提交\s*2/u);
    assert.match(await copyArticle.textContent(),/文案首次提交\s*1/u);
    assert.match(await copyArticle.textContent(),/一次通过率\s*33\.3%\s*1 \/ 3 判定项次/u);
    assert.match(await copyArticle.textContent(),/整体通过率\s*66\.7%\s*2 \/ 3 判定项次/u);
    assert.match(await imageArticle.textContent(),/图片首次初审提交\s*1/u);
    assert.match(await imageArticle.textContent(),/图片返修初审提交\s*0/u);
    assert.match(await imageArticle.textContent(),/一次通过率\s*50\.0%\s*1 \/ 2 判定项次/u);
    assert.ok(requests.some(url=>url.includes('section=personal')),'default tab reads today activity');
    assert.equal(requests.some(url=>url.includes('section=jobs')),false,'job counts load only when selected');
    assert.equal(requests.some(url=>url.includes('/delivery-items')),false,'delivery history is lazy');
    assert.ok(await page.evaluate(()=>[...window.__testIntervals.values()].some(timer=>timer.delay===60_000)),
      'today activity polls every 60 seconds');
    assert.equal(await page.evaluate(()=>[...window.__testIntervals.values()].some(timer=>timer.delay===30_000)),false,
      'today activity does not use the faster job polling interval');
    await copyAll.click();
    const allActivity=page.getByRole('dialog',{name:'文案今日全部提交'});
    await allActivity.getByText('共 4 次记录',{exact:true}).waitFor();
    assert.equal(await allActivity.getByRole('article').count(),4,'all submissions include an ordinary repeat as well as first and rework');
    await allActivity.getByRole('article').filter({hasText:'ACT-copy-repeat'}).getByText('再次提交',{exact:true}).waitFor();
    assert.ok(requests.some(url=>url.includes('metric=submitAll')&&url.includes('stage=COPY')));
    await page.keyboard.press('Escape');
    await imageAll.click();
    const allImageActivity=page.getByRole('dialog',{name:'图片今日全部提交'});
    await allImageActivity.getByText('共 2 次记录',{exact:true}).waitFor();
    await allImageActivity.getByRole('article').filter({hasText:'ACT-image-repeat'}).getByText('再次提交',{exact:true}).waitFor();
    assert.ok(requests.some(url=>url.includes('metric=submitAll')&&url.includes('stage=IMAGE')));
    await page.keyboard.press('Escape');
    await copyArticle.getByRole('button').filter({hasText:'文案返修提交'}).click();
    const activity=page.getByRole('dialog',{name:'文案返修提交'});
    await activity.getByText('共 2 次记录',{exact:true}).waitFor();
    assert.equal(await activity.getByRole('article').count(),2,'two reworks on one task yield two receipts');
    assert.match(await activity.textContent(),/ACT-copy-rework-1/u);
    assert.match(await activity.textContent(),/ACT-copy-rework-2/u);
    assert.ok(!(await activity.textContent()).includes('桌面整理'),'receipts do not expose task queries');
    const activityLayout=await activity.evaluate(element=>{
      const bounds=element.getBoundingClientRect();
      const title=element.querySelector('h2')?.getBoundingClientRect();
      const receipt=element.querySelector('article')?.getBoundingClientRect();
      const surface=document.createElement('div');surface.style.backgroundColor='var(--surface)';element.appendChild(surface);
      const expectedBackground=getComputedStyle(surface).backgroundColor;surface.remove();
      return {background:getComputedStyle(element).backgroundColor,expectedBackground,
        dialog:{left:bounds.left,right:bounds.right,width:bounds.width},
        title:title&&{left:title.left,right:title.right},receipt:receipt&&{left:receipt.left,right:receipt.right}};
    });
    assert.equal(activityLayout.background,activityLayout.expectedBackground,'activity dialog has an opaque surface background');
    assert.ok(activityLayout.dialog.width<=681,'activity dialog stays compact on desktop');
    for(const content of [activityLayout.title,activityLayout.receipt]){
      assert.ok(content&&content.left>=activityLayout.dialog.left+12&&content.right<=activityLayout.dialog.right-12,
        'activity text and receipts stay inside the dialog padding');
    }
    assert.ok(requests.some(url=>url.includes('metric=submitRework')&&url.includes('stage=COPY')));
    await page.keyboard.press('Escape');
    const imageQa=page.getByRole('article').filter({has:page.getByRole('heading',{name:'图片质检',exact:true})});
    assert.match(await imageQa.textContent(),/首轮质检\s*3/u);
    assert.match(await imageQa.textContent(),/复检\s*1/u);
    assert.match(await imageQa.textContent(),/今日实际逐条操作量\s*4/u);
    assert.match(await imageQa.textContent(),/今日处理覆盖量（含批量）\s*18/u);
    assert.match(await imageQa.textContent(),/批量退回影响\s*2/u);
    assert.match(await imageQa.textContent(),/自动放行覆盖\s*14/u);
    assert.ok(await page.getByText(/个人覆盖量不可直接相加作为系统总量/u).isVisible());
    await imageQa.getByRole('button').filter({hasText:'今日实际逐条操作量'}).click();
    const actualQa=page.getByRole('dialog',{name:'今日实际逐条操作量'});
    await actualQa.getByText('共 4 次记录',{exact:true}).waitFor();
    await actualQa.getByText('废弃',{exact:true}).waitFor();
    assert.equal(await actualQa.getByRole('article').count(),4);
    assert.ok(requests.some(url=>url.includes('metric=qaActual')&&url.includes('stage=IMAGE')));
    await page.keyboard.press('Escape');
    await imageQa.getByRole('button').filter({hasText:'今日处理覆盖量（含批量）'}).click();
    const qaCoverage=page.getByRole('dialog',{name:'今日处理覆盖量（含批量）'});
    await qaCoverage.getByText('共 18 次记录',{exact:true}).waitFor();
    assert.equal(await qaCoverage.getByRole('article').count(),15,'coverage pagination lists each known subject once');
    await qaCoverage.getByText('逐条＋自动放行',{exact:true}).waitFor();
    await qaCoverage.getByText('逐条＋批量退回',{exact:true}).waitFor();
    assert.equal(await qaCoverage.getByRole('article').filter({hasText:'ACT-qa:5'}).count(),1,'manual and automatic coverage share one receipt');
    assert.ok(await qaCoverage.getByText('放行',{exact:true}).first().isVisible());
    assert.ok(!(await qaCoverage.textContent()).includes('桌面整理'),'coverage receipts preserve anonymous content');
    await qaCoverage.getByRole('button',{name:'下一页',exact:true}).click();
    await qaCoverage.getByText('第 2 / 2 页',{exact:true}).waitFor();
    assert.equal(await qaCoverage.getByRole('article').count(),3);
    assert.ok(requests.some(url=>url.includes('metric=qaCoverage')&&url.includes('page=2')));
    await page.keyboard.press('Escape');
    for(const [label,metric,total] of [['批量退回影响','qaBatchReturned',2],['自动放行覆盖','qaBatchReleased',14],['逐条废弃','qaDiscarded',1]]){
      await imageQa.getByRole('button').filter({has:page.getByText(label,{exact:true})}).click();
      await page.getByRole('dialog',{name:label}).getByText(`共 ${total} 次记录`,{exact:true}).waitFor();
      assert.ok(requests.some(url=>url.includes(`metric=${metric}`)&&url.includes('stage=IMAGE')));
      await page.keyboard.press('Escape');
    }
    const copyQaArticle=page.getByRole('article').filter({has:page.getByRole('heading',{name:'文案质检',exact:true})});
    await copyQaArticle.getByRole('button').filter({has:page.getByText('升级处理',{exact:true})}).click();
    await page.getByRole('dialog',{name:'升级处理'}).getByText('共 1 次记录',{exact:true}).waitFor();
    assert.ok(requests.some(url=>url.includes('metric=qaEscalated')&&url.includes('stage=COPY')));
    await page.keyboard.press('Escape');
    await imageQa.getByRole('button').filter({has:page.getByText('退回',{exact:true})}).click();
    await page.getByRole('dialog',{name:'退回'}).getByText('共 1 次记录',{exact:true}).waitFor();
    assert.ok(requests.some(url=>url.includes('metric=qaReturned')&&url.includes('stage=IMAGE')));
    await page.keyboard.press('Escape');
    const refresh=page.getByRole('button',{name:'刷新',exact:true});
    const stableElements=[copyArticle,imageArticle,copyAll,imageAll,refresh];
    const beforeRefresh=await Promise.all(stableElements.map(element=>element.boundingBox()));
    const assertStableLayout=async message=>{
      const boxes=await Promise.all(stableElements.map(element=>element.boundingBox()));
      for(let index=0;index<boxes.length;index++){
        assert.ok(boxes[index]&&beforeRefresh[index],message);
        for(const dimension of ['x','y','width','height']){
          assert.ok(Math.abs(boxes[index][dimension]-beforeRefresh[index][dimension])<=1,
            `${message}: element ${index} ${dimension} stays fixed`);
        }
      }
      assert.equal(await page.getByText(/正在更新(?:个人数据|作业数据)/u).count(),0,
        'a background refresh does not insert a status row above the cards');
      assert.equal(await refresh.textContent(),'刷新','refresh button keeps a fixed label');
    };
    const requestsBeforeRefresh=statisticsRequests().length;
    delayStatistics=true;
    const firstPending=nextDelayedStatistics();
    await page.evaluate(()=>window.dispatchEvent(new Event('xhs:workspace-updated')));
    const finishFirst=await firstPending;
    await page.evaluate(()=>new Promise(requestAnimationFrame));
    await assertStableLayout('cards retain their position and size while a refresh is pending');
    assert.match(await copyAll.textContent(),/文案今日全部提交\s*4/u,'previous successful values stay visible');
    for(let index=0;index<3;index++){
      await page.evaluate(()=>window.dispatchEvent(new Event('xhs:workspace-updated')));
      await page.waitForTimeout(350);
    }
    assert.equal(statisticsRequests().length,requestsBeforeRefresh+1,'signals during a request do not start parallel replacement requests');
    assert.equal(abortedStatistics,0,'in-flight statistics requests are not aborted by invalidation signals');
    submissions.push({id:'copy-repeat-after-refresh',taskId:2,kind:'COMPLETE',stage:'COPY',at:new Date(now).toISOString(),firstSubmission:false,rework:false});
    const nextPending=nextDelayedStatistics();
    finishFirst();
    const finishNext=await nextPending;
    assert.equal(statisticsRequests().length,requestsBeforeRefresh+2,'multiple pending signals coalesce into one follow-up request');
    await assertStableLayout('cards retain their position when the coalesced refresh starts');
    delayStatistics=false;
    finishNext();
    await copyAll.getByText('5',{exact:true}).waitFor();
    await assertStableLayout('cards retain their position and size after updated values arrive');
    await page.waitForTimeout(400);
    assert.equal(statisticsRequests().length,requestsBeforeRefresh+2,'coalesced invalidations do not keep restarting refresh');
    const beforeHiddenPoll=statisticsRequests().length;
    await page.evaluate(()=>{
      Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});
      for(const timer of window.__testIntervals.values())if(timer.delay===60_000)timer.tick();
      window.dispatchEvent(new Event('xhs:workspace-updated'));
    });
    await page.waitForTimeout(350);
    assert.equal(statisticsRequests().length,beforeHiddenPoll,'a hidden statistics page neither polls nor fetches on change signals');
    const visibleRefresh=page.waitForResponse(response=>response.url().includes('/personal-workspace/statistics?'));
    await page.evaluate(()=>{
      delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await visibleRefresh;
    const personalTab=page.getByRole('tab',{name:'个人数据',exact:true});
    const jobsTab=page.getByRole('tab',{name:'作业数据',exact:true});
    const rework=page.getByRole('link',{name:/返修作业 2/u});
    await jobsTab.click();await rework.waitFor();
    await personalTab.click();await copyAll.getByText('5',{exact:true}).waitFor();
    const personalRequests=()=>statisticsRequests().filter(url=>url.includes('section=personal')).length;
    const beforeQuickSwitch=personalRequests();
    submissions.push({id:'copy-repeat-before-quick-switch',taskId:2,kind:'COMPLETE',stage:'COPY',at:new Date(now).toISOString(),firstSubmission:false,rework:false});
    await page.evaluate(()=>{window.__holdWorkspaceDebounce=true;window.dispatchEvent(new Event('xhs:workspace-updated'));});
    await jobsTab.click();await rework.waitFor();
    await personalTab.click();await copyAll.getByText('5',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.__heldWorkspaceTimeouts.size),1,
      'the pending 300 ms workspace notification survives both tab switches');
    await page.evaluate(()=>{
      window.__holdWorkspaceDebounce=false;
      const notifications=[...window.__heldWorkspaceTimeouts.values()];window.__heldWorkspaceTimeouts.clear();
      for(const notify of notifications)notify();
    });
    await copyAll.getByText('6',{exact:true}).waitFor({timeout:5_000});
    assert.equal(personalRequests(),beforeQuickSwitch+1,'a notification survives tab changes within its debounce window');
    const beforeCanceledRefresh=personalRequests(),abortsBeforeSwitch=abortedStatistics;
    submissions.push({id:'copy-repeat-before-canceled-refresh',taskId:2,kind:'COMPLETE',stage:'COPY',at:new Date(now).toISOString(),firstSubmission:false,rework:false});
    delayStatistics=true;
    const canceledRefresh=nextDelayedStatistics();
    await page.evaluate(()=>window.dispatchEvent(new Event('xhs:workspace-updated')));
    const finishCanceledRefresh=await canceledRefresh;
    assert.match(await copyAll.textContent(),/文案今日全部提交\s*6/u,'the stale value remains until the delayed response returns');
    delayStatistics=false;
    await jobsTab.click();await rework.waitFor();
    await personalTab.click();
    await copyAll.getByText('7',{exact:true}).waitFor({timeout:5_000});
    assert.equal(personalRequests(),beforeCanceledRefresh+2,'returning to a canceled dirty tab rechecks even with a fresh cached report');
    assert.equal(abortedStatistics,abortsBeforeSwitch+1,'switching tabs cancels the obsolete request');
    finishCanceledRefresh();
    await jobsTab.click();await rework.waitFor();
    assert.ok(await page.evaluate(()=>[...window.__testIntervals.values()].some(timer=>timer.delay===30_000)),
      'current job counts poll every 30 seconds');
    assert.equal(await page.evaluate(()=>[...window.__testIntervals.values()].some(timer=>timer.delay===60_000)),false,
      'inactive today activity has no polling timer');
    assert.ok(requests.some(url=>url.includes('section=jobs')&&url.includes('personalScope=ASSIGNED')));
    assert.match(await page.getByRole('link',{name:/待我处理/u}).textContent(),/待我处理\s*3/u);
    assert.ok(await page.getByRole('link',{name:/待文案初审 1/u}).isVisible());
    assert.ok(await page.getByRole('link',{name:/我的内容等待质检 0/u}).isVisible());
    if(process.env.PERSONAL_WORKSPACE_SCREENSHOTS){await mkdir(process.env.PERSONAL_WORKSPACE_SCREENSHOTS,{recursive:true});await page.screenshot({path:join(process.env.PERSONAL_WORKSPACE_SCREENSHOTS,'statistics-desktop.png'),fullPage:true});}
    await rework.click();await page.getByRole('button',{name:'查看作业 #2：桌面整理 2',exact:true}).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('state'),'rework');
    assert.equal(await page.getByRole('button',{name:'查看作业 #1：桌面整理 1',exact:true}).count(),0);
    const reworkType = page.getByRole('combobox', { name:'返修类型', exact:true });
    await reworkType.click();
    await page.getByRole('option', { name:'文案和图片', exact:true }).click();
    await page.getByRole('button',{name:'查看作业 #3：桌面整理 3',exact:true}).waitFor();
    await page.waitForFunction(()=>new URLSearchParams(location.search).get('reworkType')==='BOTH');
    await page.reload();await page.getByRole('button',{name:'查看作业 #3：桌面整理 3',exact:true}).waitFor();
    assert.equal(await reworkType.textContent(),'文案和图片');
    if(process.env.PERSONAL_WORKSPACE_SCREENSHOTS)await page.screenshot({path:join(process.env.PERSONAL_WORKSPACE_SCREENSHOTS,'tasks-desktop.png'),fullPage:true});
    // The menu stays on the system palette and supports keyboard navigation and clearing a filter.
    await reworkType.focus();await page.keyboard.press('ArrowDown');
    await page.getByRole('listbox').waitFor();
    const menuTheme = await page.getByRole('listbox').evaluate(element => ({
      background:getComputedStyle(element).backgroundColor,
      expected:getComputedStyle(document.documentElement).getPropertyValue('--popover').trim(),
    }));
    assert.equal(menuTheme.background,'rgb(255, 254, 251)');assert.equal(menuTheme.expected,'#fffefb');
    if(process.env.PERSONAL_WORKSPACE_SCREENSHOTS)await page.screenshot({path:join(process.env.PERSONAL_WORKSPACE_SCREENSHOTS,'filter-menu-desktop.png'),animations:'disabled'});
    await page.waitForFunction(()=>document.activeElement?.getAttribute('role')==='option');
    await page.keyboard.press('Home');
    await page.waitForFunction(()=>document.activeElement?.textContent?.includes('全部类型'));
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>!new URLSearchParams(location.search).has('reworkType'));
    assert.equal(await reworkType.textContent(),'全部类型');
    await page.getByRole('button',{name:'创建日期筛选',exact:true}).click();
    await page.getByRole('button',{name:'选择创建开始日期',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'今天',exact:true}).click();
    assert.match(await page.getByLabel('作业创建开始日期',{exact:true}).inputValue(),/^\d{4}-\d{2}-\d{2}$/u);
    await page.getByLabel('作业创建开始日期',{exact:true}).fill('2026-09-01');
    await page.getByLabel('作业创建结束日期',{exact:true}).fill('2026-09-18');
    await page.getByRole('button',{name:'筛选创建日期',exact:true}).click();
    await page.waitForFunction(()=>new URLSearchParams(location.search).get('createdFrom')==='2026-09-01');
    await page.getByRole('button',{name:'清除日期',exact:true}).click();
    await page.waitForFunction(()=>!new URLSearchParams(location.search).has('createdFrom'));
    assert.equal(await page.getByLabel('作业创建开始日期',{exact:true}).inputValue(),'');
    assert.equal(await page.getByLabel('作业创建结束日期',{exact:true}).inputValue(),'');
    await page.getByRole('button',{name:'完成历史',exact:true}).click();
    const history=page.getByRole('button',{name:'查看作业 #4：桌面整理 4',exact:true});await history.waitFor();assert.equal(await history.isDisabled(),true);
    await page.goto(`${base}/workbench/personal-statistics`);
    await page.getByRole('tab',{name:'作业数据',exact:true}).click();await rework.waitFor();
    assert.equal(requests.some(url=>url.includes('/delivery-items')),false,'job tab does not fetch delivery history');
    await Promise.all([page.waitForResponse(response=>response.url().includes('/delivery-items?')),
      page.getByRole('button',{name:'我的交付记录',exact:true}).click()]);await page.getByRole('dialog').waitFor();
    assert.ok(requests.some(url=>url.includes('/delivery-items')));
    await page.getByRole('combobox',{name:'交付状态',exact:true}).click();
    await page.getByRole('option',{name:'已打包，待交付',exact:true}).click();
    await Promise.all([
      page.waitForResponse(response=>response.url().includes('/delivery-items?')&&response.url().includes('state=PACKED')),
      page.getByRole('dialog').getByRole('button',{name:'查询',exact:true}).click(),
    ]);
    await page.getByRole('combobox',{name:'交付状态',exact:true}).click();
    await page.getByRole('option',{name:'全部状态',exact:true}).click();
    assert.equal(await page.getByRole('dialog').count(),1,'selecting inside the delivery dialog keeps it open');
    await page.keyboard.press('Escape');
    const currentRework=page.getByRole('link',{name:/返修作业 /u});
    const jobBoundsBefore=await currentRework.boundingBox();
    delayStatistics=true;
    const pendingJobRefresh=nextDelayedStatistics();
    facts=facts.map(item=>item.id===2?{...item,state:'COPY_QC_PENDING',mandatoryCopyQc:true}:item);
    await page.evaluate(()=>window.dispatchEvent(new Event('xhs:workspace-updated')));
    const finishJobRefresh=await pendingJobRefresh;
    await page.evaluate(()=>new Promise(requestAnimationFrame));
    const jobBoundsPending=await currentRework.boundingBox();
    assert.deepEqual(jobBoundsPending,jobBoundsBefore,'job cards remain stable during a background refresh');
    assert.equal(await page.getByText(/正在更新(?:个人数据|作业数据)/u).count(),0);
    assert.equal(await page.getByRole('button',{name:'刷新',exact:true}).textContent(),'刷新');
    delayStatistics=false;finishJobRefresh();
    const oneRework=page.getByRole('link',{name:/返修作业 1/u});await oneRework.waitFor();
    assert.deepEqual(await currentRework.boundingBox(),jobBoundsBefore,'job cards remain stable after counts update');
    failStatistics=true;await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByRole('alert').filter({hasText:'保留上次成功'}).waitFor();
    assert.ok(await oneRework.isVisible());failStatistics=false;
    await page.setViewportSize({width:390,height:844});await page.goto(`${base}/workbench/personal-statistics`);
    await page.getByRole('heading',{name:'今日标注与图片初审',exact:true}).waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'mobile statistics should not overflow');
    if(process.env.PERSONAL_WORKSPACE_SCREENSHOTS)await page.screenshot({path:join(process.env.PERSONAL_WORKSPACE_SCREENSHOTS,'statistics-mobile.png'),fullPage:true});
    await page.getByRole('tab',{name:'作业数据',exact:true}).click();await oneRework.waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'mobile job counts should not overflow');
    await page.getByRole('link',{name:'我的作业',exact:true}).click();await page.getByRole('button',{name:'查看作业 #1：桌面整理 1',exact:true}).waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'mobile task controls should not overflow');
    if(process.env.PERSONAL_WORKSPACE_SCREENSHOTS)await page.screenshot({path:join(process.env.PERSONAL_WORKSPACE_SCREENSHOTS,'tasks-mobile.png'),fullPage:true});
    await page.getByRole('combobox',{name:'作业关系',exact:true}).click();
    const mobileMenu = await page.getByRole('listbox').boundingBox();
    assert.ok(mobileMenu.x>=0&&mobileMenu.x+mobileMenu.width<=390,'mobile menu stays within viewport');
    await page.getByRole('option',{name:'我创建的',exact:true}).click();
    await page.waitForFunction(()=>new URLSearchParams(location.search).get('personalScope')==='CREATED');
    await page.getByRole('button',{name:'重置个人筛选',exact:true}).click();
    assert.equal(await page.getByRole('combobox',{name:'作业关系',exact:true}).textContent(),'我负责的');
    facts=[];events.length=0;submissions.length=0;qualityFacts.length=0;
    await page.goto(`${base}/workbench/personal-statistics`);
    const emptyCopy=page.getByRole('article').filter({has:page.getByRole('heading',{name:'文案标注',exact:true})});
    await emptyCopy.getByRole('button').filter({hasText:'文案首次提交'}).getByText('0',{exact:true}).waitFor();
    assert.match(await emptyCopy.textContent(),/一次通过率\s*—\s*0 \/ 0 判定项次/u);
    await emptyCopy.getByRole('button').filter({hasText:'文案首次提交'}).click();
    const emptyActivity=page.getByRole('dialog',{name:'文案首次提交'});
    await emptyActivity.getByText('今天暂无文案首次提交记录',{exact:true}).waitFor();
    const mobileActivityBounds=await emptyActivity.boundingBox();
    assert.ok(mobileActivityBounds&&mobileActivityBounds.x>=0&&mobileActivityBounds.x+mobileActivityBounds.width<=390,
      'activity dialog stays within the mobile viewport');
    assert.equal(await emptyActivity.getByRole('button',{name:'上一页'}).count(),0,'empty activity has no pointless pagination');
    assert.equal(await emptyActivity.getByRole('button',{name:'下一页'}).count(),0,'empty activity has no pointless pagination');
    await page.keyboard.press('Escape');
    const copyQa=page.getByRole('article').filter({has:page.getByRole('heading',{name:'文案质检',exact:true})});
    await copyQa.getByRole('button').filter({hasText:'复检'}).click();
    await page.getByRole('dialog').getByText('共 2 次记录',{exact:true}).waitFor();
    assert.ok(!(await page.getByRole('dialog').textContent()).includes('桌面整理'));
    await page.keyboard.press('Escape');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
    coverageRows.IMAGE=[];coverageIncomplete.IMAGE=true;
    await page.getByRole('button',{name:'刷新',exact:true}).click();
    const incompleteCoverage=imageQa.getByRole('button').filter({hasText:'今日处理覆盖量（含批量）'});
    await incompleteCoverage.getByText('已确认 0',{exact:true}).waitFor();
    await imageQa.getByText(/历史覆盖记录不完整；以上为已确认条次/u).waitFor();
    await incompleteCoverage.click();
    const incompleteDialog=page.getByRole('dialog',{name:'今日处理覆盖量（含批量）'});
    await incompleteDialog.getByText('暂无可确认的覆盖明细',{exact:true}).waitFor();
    assert.ok(await incompleteDialog.getByText(/当前空明细不代表没有处理/u).isVisible());
    assert.equal(await incompleteDialog.getByRole('button',{name:'下一页'}).count(),0);
    await page.keyboard.press('Escape');
    if(process.env.PERSONAL_WORKSPACE_SCREENSHOTS)await page.screenshot({path:join(process.env.PERSONAL_WORKSPACE_SCREENSHOTS,'qa-only-mobile.png'),fullPage:true});
    assert.deepEqual(errors,[]);
  } finally {
    await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
    assert.ok(root.startsWith(join(tmpdir(),'personal-workspace-browser-')));await rm(root,{recursive:true,force:true,maxRetries:4,retryDelay:100});
  }
});
