import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp,readFile,rm,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizePersonalFilters,selectPersonalTasks,summarizePersonalToday,summarizePersonalWorkspace } from '../src/personal-workspace.mjs';
import { DEFAULT_HUMAN_QUALITY_SETTINGS } from '../src/human-quality-settings.mjs';
import { qaMetricRows } from '../src/quality-review-statistics.mjs';
import { chinaDay } from '../src/web-statistics/summary.mjs';

test('personal workspace browser: today overview, date components, first copy review, real QA, stable refresh, drilldowns and mobile',{
  skip:process.env.RUN_PERSONAL_WORKSPACE_BROWSER !== '1',timeout:90_000,
},async()=>{
  const {build}=await import('esbuild'); const {chromium}=await import('playwright-core');
  const root=await mkdtemp(join(tmpdir(),'personal-workspace-browser-'));
  const now=Date.now();
  const todayRange=normalizePersonalFilters({},now).range;
  const historicalAt=daysAgo=>new Date(todayRange.startMs-daysAgo*86_400_000+12*3_600_000).toISOString();
  const historicalDay=daysAgo=>chinaDay(Date.parse(historicalAt(daysAgo)));
  const inRange=(row,range)=>Date.parse(row.at)>=range.startMs&&Date.parse(row.at)<range.endMs;
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
    {id:'copy-yesterday-first',taskId:14,kind:'COMPLETE',stage:'COPY',at:historicalAt(1),firstSubmission:true,rework:false},
    {id:'image-first',taskId:3,kind:'COMPLETE',stage:'IMAGE',at:new Date(now).toISOString(),firstSubmission:true,rework:false},
    {id:'image-repeat',taskId:3,kind:'COMPLETE',stage:'IMAGE',at:new Date(now).toISOString(),firstSubmission:false,rework:false},
    {id:'copy-week-first',taskId:5,kind:'COMPLETE',stage:'COPY',at:historicalAt(3),firstSubmission:true,rework:false},
    {id:'copy-week-repeat',taskId:5,kind:'COMPLETE',stage:'COPY',at:historicalAt(3),firstSubmission:false,rework:false},
    {id:'copy-month-first',taskId:6,kind:'COMPLETE',stage:'COPY',at:historicalAt(10),firstSubmission:true,rework:false},
    {id:'image-month-first',taskId:6,kind:'COMPLETE',stage:'IMAGE',at:historicalAt(10),firstSubmission:true,rework:false},
    {id:'copy-outside-month',taskId:7,kind:'COMPLETE',stage:'COPY',at:historicalAt(40),firstSubmission:true,rework:false},
  ];
  const discardFacts=[
    {id:'copy-discard',kind:'ANNOTATION_DISCARD',taskId:8,accountId:22,stage:'COPY',at:new Date(now).toISOString(),outcome:'DISCARD'},
    {id:'copy-rework-discard',kind:'ANNOTATION_DISCARD',taskId:9,accountId:22,stage:'COPY',at:new Date(now).toISOString(),outcome:'DISCARD',rework:true},
    {id:'copy-yesterday-discard',kind:'ANNOTATION_DISCARD',taskId:15,accountId:22,stage:'COPY',at:historicalAt(1),outcome:'DISCARD'},
    {id:'copy-week-discard',kind:'ANNOTATION_DISCARD',taskId:10,accountId:22,stage:'COPY',at:historicalAt(3),outcome:'DISCARD'},
    {id:'copy-month-discard-1',kind:'ANNOTATION_DISCARD',taskId:11,accountId:22,stage:'COPY',at:historicalAt(10),outcome:'DISCARD'},
    {id:'copy-month-discard-2',kind:'ANNOTATION_DISCARD',taskId:12,accountId:22,stage:'COPY',at:historicalAt(10),outcome:'DISCARD'},
    {id:'copy-outside-month-discard',kind:'ANNOTATION_DISCARD',taskId:13,accountId:22,stage:'COPY',at:historicalAt(40),outcome:'DISCARD'},
  ];
  const qualityFacts=[
    {id:'quality-copy-first',kind:'ANNOTATION_QUALITY',taskId:2,accountId:22,stage:'COPY',at:new Date(now).toISOString(),outcome:'PASS',firstPassed:true},
    {id:'quality-copy-rework',kind:'ANNOTATION_QUALITY',taskId:2,accountId:22,stage:'COPY',at:new Date(now).toISOString(),outcome:'PASS',firstPassed:false},
    {id:'quality-copy-return',kind:'ANNOTATION_QUALITY',taskId:3,accountId:22,stage:'COPY',at:new Date(now).toISOString(),outcome:'RETURN',firstPassed:false},
    {id:'quality-image-first',kind:'ANNOTATION_QUALITY',taskId:3,accountId:22,stage:'IMAGE',at:new Date(now).toISOString(),outcome:'PASS',firstPassed:true},
    {id:'quality-image-return',kind:'ANNOTATION_QUALITY',taskId:1,accountId:22,stage:'IMAGE',at:new Date(now).toISOString(),outcome:'RETURN',firstPassed:false},
    {id:'quality-copy-week',kind:'ANNOTATION_QUALITY',taskId:5,accountId:22,stage:'COPY',at:historicalAt(3),outcome:'RETURN',firstPassed:false},
    {id:'quality-copy-month',kind:'ANNOTATION_QUALITY',taskId:6,accountId:22,stage:'COPY',at:historicalAt(10),outcome:'PASS',firstPassed:true},
  ];
  const qaEvents=Array.from({length:8},(_,i)=>({id:`qa:${i}`,samplingItemId:i+1,taskId:i+1,accountId:22,
    stage:i<5?'COPY':'IMAGE',kind:'QA_REVIEW',sampleKind:i===3||i===4||i===7?'MANDATORY_RECHECK':'RANDOM',
    outcome:i===2||i===6?'RETURN':'PASS',at:new Date(now).toISOString()}));
  qaEvents.push({id:'qa:escalated',samplingItemId:9,taskId:9,accountId:22,stage:'COPY',kind:'QA_ESCALATE',
    sampleKind:'RANDOM',outcome:'ESCALATE',at:new Date(now).toISOString()},
  {id:'qa:discarded',samplingItemId:10,taskId:10,accountId:22,stage:'IMAGE',kind:'QA_DISCARD',
    sampleKind:'RANDOM',outcome:'DISCARD',at:new Date(now).toISOString()},
  {id:'qa:week',samplingItemId:11,taskId:11,accountId:22,stage:'COPY',kind:'QA_REVIEW',
    sampleKind:'RANDOM',outcome:'RETURN',at:historicalAt(3)});
  const actualQaRows=(stage,range)=>qaEvents.filter(row=>row.stage===stage&&['QA_REVIEW','QA_DISCARD','QA_ESCALATE'].includes(row.kind)
    &&(!range||inRange(row,range)));
  const coverageRows={
    COPY:[...actualQaRows('COPY').map(row=>({...row,coverageSources:['DIRECT']})),
      {id:'coverage-copy-release',taskId:101,stage:'COPY',kind:'QA_COVERAGE',outcome:'RELEASE',at:new Date(now).toISOString(),coverageSources:['BATCH_RELEASE']}],
    IMAGE:[...actualQaRows('IMAGE').map(row=>({...row,coverageSources:row.id==='qa:5'?['DIRECT','BATCH_RELEASE']
      :row.id==='qa:6'?['DIRECT','BATCH_RETURN']:['DIRECT']})),
      ...Array.from({length:14},(_,i)=>({id:`coverage-image-${i}`,taskId:101+i,stage:'IMAGE',kind:'QA_COVERAGE',
        outcome:i===0?'RETURN':'RELEASE',at:new Date(now).toISOString(),coverageSources:[i===0?'BATCH_RETURN':'BATCH_RELEASE']}))],
  };
  const coverageIncomplete={COPY:false,IMAGE:false};
  const qaExtra=(stage,range)=>({actualOperations:actualQaRows(stage,range).length,
    processingCoverage:coverageRows[stage].filter(row=>inRange(row,range)).length,
    batchReturned:coverageRows[stage].filter(row=>inRange(row,range)&&row.coverageSources.includes('BATCH_RETURN')).length,
    batchReleased:coverageRows[stage].filter(row=>inRange(row,range)&&row.coverageSources.includes('BATCH_RELEASE')).length,
    discarded:actualQaRows(stage,range).filter(row=>row.kind==='QA_DISCARD').length,
    escalated:actualQaRows(stage,range).filter(row=>row.kind==='QA_ESCALATE').length,coverageIncomplete:coverageIncomplete[stage]});
  const deliveryPool=[
    {id:301,assigneeId:22,state:'COPY_READY',downloaded:false,enteredAt:historicalAt(40)},
    {id:302,assigneeId:22,state:'IMAGE_READY',downloaded:true,enteredAt:historicalAt(10)},
    {id:303,assigneeId:22,state:'DELIVERED',downloaded:true,enteredAt:new Date(now).toISOString()},
    {id:304,assigneeId:33,state:'IMAGE_READY',downloaded:false,enteredAt:new Date(now).toISOString()},
  ];
  let browser,server,failStatistics=false,delayStatistics=false,abortedStatistics=0;
  let failOverview=false,delayOverview=false;
  let statisticsNow=now,recomputeStatisticsAtSend=false;
  const personalSummary=searchParams=>{
    const {range}=normalizePersonalFilters(Object.fromEntries(searchParams),statisticsNow);
    const data=summarizePersonalToday(submissions.filter(row=>inRange(row,range)),qualityFacts.filter(row=>inRange(row,range)),
      qaEvents.filter(row=>inRange(row,range)),range,statisticsNow,[],discardFacts.filter(row=>inRange(row,range)));
    for(const stage of ['COPY','IMAGE'])Object.assign(data.qa[stage],qaExtra(stage,range));
    return data;
  };
  const overviewSummary=()=>{
    const {range}=normalizePersonalFilters({},statisticsNow);
    return {section:'overview',updatedAt:new Date(statisticsNow).toISOString(),timezone:'Asia/Shanghai',
      range:{from:range.from,to:range.to},
      delivery:{ready:deliveryPool.filter(row=>row.assigneeId===22&&row.state!=='DELIVERED').length,href:'/delivery-pool?dl_view=CURRENT&dl_state=PENDING&dl_assigneeId=22'},
      passed:Object.fromEntries(['COPY','IMAGE'].map(stage=>[stage,
        qualityFacts.filter(row=>row.accountId===22&&row.stage===stage&&row.outcome==='PASS'&&inRange(row,range)).length]))};
  };
  const errors=[],requests=[];
  const delayedStatisticsListeners=[];
  const nextDelayedStatistics=()=>new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('expected a delayed statistics request')),5_000);
    delayedStatisticsListeners.push(send=>{clearTimeout(timeout);resolve(send);});
  });
  const delayedOverviewListeners=[];
  const nextDelayedOverview=()=>new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('expected a delayed today overview request')),5_000);
    delayedOverviewListeners.push(send=>{clearTimeout(timeout);resolve(send);});
  });
  const allStatisticsRequests=()=>requests.filter(url=>url.includes('/personal-workspace/statistics?'));
  const statisticsRequests=()=>allStatisticsRequests().filter(url=>!url.includes('section=overview'));
  const overviewRequests=()=>allStatisticsRequests().filter(url=>url.includes('section=overview'));
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
          const isOverview=url.searchParams.get('section')==='overview';
          if(isOverview?failOverview:failStatistics){res.statusCode=503;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:{code:'TEST_UNAVAILABLE',message:'统计服务暂不可用'}}));return;}
          const filters=normalizePersonalFilters(Object.fromEntries(url.searchParams),statisticsNow);
          data=isOverview ? overviewSummary() : url.searchParams.get('section')==='personal'
            ? personalSummary(url.searchParams)
            : {section:'jobs',...summarizePersonalWorkspace(facts,events,[],filters)};
        } else if(url.pathname.endsWith('/personal-workspace/qa-activities')) {
          const metric=url.searchParams.get('metric'),stage=url.searchParams.get('stage');
          const {range}=normalizePersonalFilters(Object.fromEntries(url.searchParams),statisticsNow);
          let rows=metric==='submitAll' ? submissions
            : metric==='submitFirst' ? submissions.filter(row=>row.firstSubmission&&!row.rework)
            : metric==='copyFirstReview' ? [...submissions.filter(row=>row.firstSubmission&&!row.rework),...discardFacts]
            : metric==='annotationDiscarded' ? discardFacts
            : metric==='submitRework' ? submissions.filter(row=>row.rework)
            : metric==='annotationOverall' ? qualityFacts
            : metric==='qaActual' ? actualQaRows(stage)
            : metric==='qaCoverage' ? coverageRows[stage]
            : metric==='qaBatchReturned' ? coverageRows[stage].filter(row=>row.coverageSources.includes('BATCH_RETURN'))
            : metric==='qaBatchReleased' ? coverageRows[stage].filter(row=>row.coverageSources.includes('BATCH_RELEASE'))
            : metric==='qaDiscarded' ? actualQaRows(stage).filter(row=>row.kind==='QA_DISCARD')
            : metric==='qaEscalated' ? actualQaRows(stage).filter(row=>row.kind==='QA_ESCALATE')
            : metric==='qaFirst'||metric==='qaRecheck' ? actualQaRows(stage)
            : qaMetricRows(qaEvents,'qa',stage);
          rows=rows.filter(row=>row.stage===stage&&inRange(row,range));
          if(metric==='annotationOverall'&&url.searchParams.get('sampleSet')==='passed')rows=rows.filter(row=>row.outcome==='PASS');
          if(metric==='qaFirst')rows=rows.filter(row=>row.sampleKind!=='MANDATORY_RECHECK');
          if(metric==='qaRecheck')rows=rows.filter(row=>row.sampleKind==='MANDATORY_RECHECK');
          if(metric==='qaPassed')rows=rows.filter(row=>row.outcome==='PASS');
          if(metric==='qaReturned')rows=rows.filter(row=>row.outcome==='RETURN');
          const pageSize=15,page=Math.min(Number(url.searchParams.get('page')??1),Math.max(1,Math.ceil(rows.length/pageSize)));
          data={items:rows.slice((page-1)*pageSize,page*pageSize).map(row=>({id:row.id,code:`ACT-${row.id}`,kind:row.kind,stage:row.stage,
            outcome:row.outcome,coverageSources:row.coverageSources,manualKinds:row.manualKinds,
            submissionType:row.kind==='ANNOTATION_DISCARD'?undefined:row.rework?'REWORK':row.firstSubmission?'FIRST':'REPEAT',sampleKind:row.sampleKind,at:row.at})),
            total:rows.length,page,pageSize,coverageIncomplete:['qaCoverage','qaBatchReturned','qaBatchReleased'].includes(metric)&&coverageIncomplete[stage]};
        } else if(url.pathname.endsWith('/personal-workspace/tasks')) {
          data=selectPersonalTasks(facts,events,normalizePersonalFilters(Object.fromEntries(url.searchParams)));
          data.items=data.items.map(item=>({...item,personalHistory:item.history}));data.updatedAt=new Date().toISOString();
        } else if(url.pathname.endsWith('/delivery-items')) data={items:[],total:0,summary:{total:0,unpacked:0,packed:0,delivered:0,updated:0},updatedAt:new Date().toISOString()};
        else if(url.pathname==='/api/human-quality-settings') data=DEFAULT_HUMAN_QUALITY_SETTINGS;
        else {res.statusCode=404;data=null;}
        const send=()=>{
          if(recomputeStatisticsAtSend&&url.pathname.endsWith('/personal-workspace/statistics')&&url.searchParams.get('section')==='personal'){
            data=personalSummary(url.searchParams);
          }
          if(recomputeStatisticsAtSend&&url.pathname.endsWith('/personal-workspace/statistics')&&url.searchParams.get('section')==='overview')data=overviewSummary();
          res.setHeader('content-type','application/json');res.end(JSON.stringify({data}));
        };
        if(url.pathname.endsWith('/personal-workspace/statistics')&&url.searchParams.get('section')==='overview'&&delayOverview){
          for(const resolve of delayedOverviewListeners.splice(0))resolve(send);
          return;
        }
        if(delayStatistics&&url.pathname.endsWith('/personal-workspace/statistics')&&url.searchParams.get('section')!=='overview'){
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
    const page=await browser.newPage({viewport:{width:1440,height:1000},timezoneId:'Asia/Shanghai'});page.on('pageerror',error=>errors.push(error.message));
    await page.clock.setFixedTime(now);
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
    failOverview=true;
    await page.goto(`${base}/workbench/personal-statistics`);
    await page.getByRole('heading',{name:'今日标注与图片初审',exact:true}).waitFor();
    const overview=page.getByRole('region',{name:'今日概览',exact:true});
    await overview.getByRole('alert').waitFor();
    assert.equal(await overview.locator('strong').filter({hasText:/^0(?:条|次)?$/u}).count(),0,
      'an unavailable overview never claims that today has zero deliverable or passed content');
    assert.equal(await overview.getByRole('button',{name:/今日文案质检通过/u}).isDisabled(),true);
    failOverview=false;
    await page.getByRole('button',{name:'刷新',exact:true}).click();
    const readyToday=overview.getByRole('link',{name:/今日可交付/u});
    const copyPassedToday=overview.getByRole('button',{name:/今日文案质检通过/u});
    const imagePassedToday=overview.getByRole('button',{name:/今日图片质检通过/u});
    const overviewCount=(card,value)=>card.locator('strong').filter({hasText:new RegExp(`^${value}(?:条|次)$`,'u')});
    await overviewCount(readyToday,2).waitFor();
    await overviewCount(copyPassedToday,2).waitFor();
    await overviewCount(imagePassedToday,1).waitFor();
    assert.equal(await readyToday.getAttribute('href'),'/delivery-pool?dl_view=CURRENT&dl_state=PENDING&dl_assigneeId=22',
      'deliverables navigate to the current actor pending delivery pool');
    assert.match(await readyToday.textContent(),/截至当前|交付池/u);
    assert.match(await overview.textContent(),/今日|今天/u);
    assert.ok(await overview.evaluate(element=>element.compareDocumentPosition(document.querySelector('[role="tablist"]'))&Node.DOCUMENT_POSITION_FOLLOWING),
      'today overview is above the tabs and date controls');
    const copyArticle=page.getByRole('article').filter({has:page.getByRole('heading',{name:'文案标注',exact:true})});
    const imageArticle=page.getByRole('article').filter({has:page.getByRole('heading',{name:'图片标注／初审',exact:true})});
    const copyAll=copyArticle.getByRole('button').filter({has:page.getByText('文案全部提交',{exact:true})});
    const imageAll=imageArticle.getByRole('button').filter({hasText:'图片今日全部提交'});
    await copyArticle.getByRole('button').filter({hasText:'文案返修提交'}).getByText('2',{exact:true}).waitFor();
    assert.match(await copyAll.textContent(),/文案全部提交\s*4/u);
    assert.match(await imageAll.textContent(),/图片今日全部提交\s*2/u);
    const firstCopyReview=copyArticle.getByRole('button').filter({has:page.getByText('首次文案审核',{exact:true})});
    const discardedCopy=copyArticle.getByRole('button').filter({has:page.getByText('文案废弃数',{exact:true})});
    const firstCopySubmission=copyArticle.getByRole('button').filter({has:page.getByText('首次提交',{exact:true})});
    assert.match(await firstCopyReview.textContent(),/首次文案审核\s*3/u);
    assert.match(await discardedCopy.textContent(),/文案废弃数\s*2/u);
    assert.match(await copyArticle.textContent(),/首次文案审核\s*=\s*首次提交\s*\+\s*废弃数/u);
    assert.match(await firstCopyReview.locator('small').textContent(),/首次文案审核\s*=\s*首次提交\s*\+\s*废弃数/u);
    assert.match(await firstCopySubmission.textContent(),/首次提交\s*1/u);
    const copyMetricBounds=await Promise.all([copyAll,firstCopyReview,firstCopySubmission,
      copyArticle.getByRole('button').filter({hasText:'文案返修提交'}),discardedCopy].map(element=>element.boundingBox()));
    assert.equal(copyMetricBounds[0].y,copyMetricBounds[1].y,'all submissions and first copy review share the primary row');
    assert.ok(copyMetricBounds[2].y>copyMetricBounds[0].y,'first submissions have their own card on the second row');
    assert.equal(copyMetricBounds[2].y,copyMetricBounds[3].y);
    assert.equal(copyMetricBounds[3].y,copyMetricBounds[4].y,'first submissions, rework and discards share the secondary row');
    assert.match(await copyArticle.textContent(),/一次通过率\s*33\.3%\s*1 \/ 3 判定项次/u);
    assert.match(await copyArticle.textContent(),/整体通过率\s*66\.7%\s*2 \/ 3 判定项次/u);
    assert.match(await imageArticle.textContent(),/首次图片审核\s*1/u);
    assert.match(await imageArticle.textContent(),/图片返修提交\s*0/u);
    assert.match(await imageArticle.textContent(),/一次通过率\s*50\.0%\s*1 \/ 2 判定项次/u);
    assert.ok(requests.some(url=>url.includes('section=personal')),'default tab reads today activity');
    assert.equal(requests.some(url=>url.includes('section=jobs')),false,'job counts load only when selected');
    assert.equal(requests.some(url=>url.includes('/delivery-items')),false,'delivery history is lazy');
    assert.ok(await page.evaluate(()=>[...window.__testIntervals.values()].some(timer=>timer.delay===60_000)),
      'today activity polls every 60 seconds');
    assert.equal(await page.evaluate(()=>[...window.__testIntervals.values()].filter(timer=>timer.delay===30_000).length),1,
      'only the fixed today overview uses the faster polling interval on the personal tab');
    if(process.env.PERSONAL_WORKSPACE_SCREENSHOTS){
      await mkdir(process.env.PERSONAL_WORKSPACE_SCREENSHOTS,{recursive:true});
      await page.screenshot({path:join(process.env.PERSONAL_WORKSPACE_SCREENSHOTS,'personal-statistics-desktop.png'),fullPage:true});
    }
    await copyAll.click();
    const allActivity=page.getByRole('dialog',{name:'文案全部提交'});
    await allActivity.getByText('共 4 次记录',{exact:true}).waitFor();
    assert.equal(await allActivity.getByRole('article').count(),4,'all submissions include an ordinary repeat as well as first and rework');
    await allActivity.getByRole('article').filter({hasText:'ACT-copy-repeat'}).getByText('再次提交',{exact:true}).waitFor();
    assert.ok(requests.some(url=>url.includes('metric=submitAll')&&url.includes('stage=COPY')));
    await page.keyboard.press('Escape');
    await firstCopySubmission.click();
    const firstSubmissionActivity=page.getByRole('dialog',{name:'首次提交'});
    await firstSubmissionActivity.getByText('共 1 次记录',{exact:true}).waitFor();
    assert.equal(await firstSubmissionActivity.getByRole('article').filter({hasText:'ACT-copy-first'}).count(),1);
    assert.equal(await firstSubmissionActivity.getByRole('article').filter({hasText:'废弃'}).count(),0);
    assert.ok(requests.some(url=>url.includes('metric=submitFirst')&&url.includes('stage=COPY')));
    await page.keyboard.press('Escape');
    await firstCopyReview.click();
    const firstReviewActivity=page.getByRole('dialog',{name:'首次文案审核'});
    await firstReviewActivity.getByText('共 3 次记录',{exact:true}).waitFor();
    assert.equal(await firstReviewActivity.getByRole('article').count(),3,'first copy review includes first submissions and every actor copy discard');
    await firstReviewActivity.getByRole('article').filter({hasText:'ACT-copy-first'}).getByText('首次提交',{exact:true}).waitFor();
    for(const code of ['ACT-copy-discard','ACT-copy-rework-discard']){
      await firstReviewActivity.getByRole('article').filter({hasText:code}).getByText('废弃',{exact:true}).waitFor();
    }
    assert.ok(requests.some(url=>url.includes('metric=copyFirstReview')&&url.includes('stage=COPY')));
    await page.keyboard.press('Escape');
    await discardedCopy.click();
    const discardActivity=page.getByRole('dialog',{name:'文案废弃数'});
    await discardActivity.getByText('共 2 次记录',{exact:true}).waitFor();
    assert.equal(await discardActivity.getByRole('article').count(),2);
    assert.equal(await discardActivity.getByRole('article').filter({hasText:'ACT-copy-first'}).count(),0,'discard detail excludes first submissions');
    assert.ok(requests.some(url=>url.includes('metric=annotationDiscarded')&&url.includes('stage=COPY')));
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
    const period=page.getByRole('group',{name:'统计时间范围',exact:true});
    const choosePeriod=async name=>{await period.getByRole('button',{name,exact:true}).click();};
    const fromDate=page.getByLabel('开始日期',{exact:true}),toDate=page.getByLabel('结束日期',{exact:true});
    assert.deepEqual(await period.getByRole('button').allTextContents(),['今天','昨天','近 7 天','自定义日期']);
    assert.equal(await period.getByRole('button',{name:'今天',exact:true}).getAttribute('aria-pressed'),'true',
      'the default date option is visibly and accessibly today');
    assert.equal(await page.getByLabel('开始日期',{exact:true}).count(),0,'custom date inputs stay collapsed for presets');
    const rangeCopyAll=copyAll;
    const assertActivityRange=(metric,range)=>{
      const request=requests.filter(url=>url.includes('/personal-workspace/qa-activities?')&&url.includes(`metric=${metric}`)).at(-1);
      assert.ok(request,`${metric} has a detail request`);
      const search=new URL(request,base).searchParams;
      assert.equal(search.get('period'),'custom','details use the exact dates shown on the cards');
      assert.equal(search.get('from'),range.from);
      assert.equal(search.get('to'),range.to);
    };
    for(const [card,label,stage,total] of [[copyPassedToday,'今日文案质检通过','COPY',2],[imagePassedToday,'今日图片质检通过','IMAGE',1]]){
      await card.click();
      const passedActivity=page.getByRole('dialog',{name:label});
      await passedActivity.getByText(`共 ${total} 次记录`,{exact:true}).waitFor();
      assert.equal(await passedActivity.getByRole('article').count(),total,'producer quality passes include rework passes');
      assert.equal(await passedActivity.getByRole('article').filter({hasText:'退回'}).count(),0);
      const passedRequest=new URL(requests.filter(url=>url.includes('/qa-activities?')).at(-1),base).searchParams;
      assert.equal(passedRequest.get('metric'),'annotationOverall','today passed cards show producer quality rather than the actor QA operations');
      assert.equal(passedRequest.get('sampleSet'),'passed');
      assert.equal(passedRequest.get('stage'),stage);
      assertActivityRange('annotationOverall',todayRange);
      await page.keyboard.press('Escape');
    }
    const overviewBeforeFilters=overviewRequests().length;
    await choosePeriod('昨天');
    await rangeCopyAll.getByText('1',{exact:true}).waitFor();
    await firstCopyReview.getByText('2',{exact:true}).waitFor();
    await discardedCopy.getByText('1',{exact:true}).waitFor();
    assert.equal(await period.getByRole('button',{name:'昨天',exact:true}).getAttribute('aria-pressed'),'true');
    const yesterdayRequest=new URL(statisticsRequests().at(-1),base).searchParams;
    assert.equal(yesterdayRequest.get('period'),'custom');
    assert.equal(yesterdayRequest.get('from'),historicalDay(1));
    assert.equal(yesterdayRequest.get('to'),historicalDay(1));
    await rangeCopyAll.click();
    await page.getByRole('dialog',{name:'文案全部提交'}).getByText('共 1 次记录',{exact:true}).waitFor();
    assertActivityRange('submitAll',{from:historicalDay(1),to:historicalDay(1)});
    await page.keyboard.press('Escape');
    assert.match(await copyPassedToday.textContent(),/今日文案质检通过\s*2/u);
    assert.match(await readyToday.textContent(),/今日可交付\s*2/u,'previous pool arrivals remain deliverable when viewing yesterday');
    await choosePeriod('自定义日期');
    assert.equal(await fromDate.inputValue(),historicalDay(1));
    assert.equal(await toDate.inputValue(),historicalDay(1));
    assert.ok(await page.getByText(`统计范围：${historicalDay(1)} · 北京时间`,{exact:true}).isVisible(),
      'opening custom dates keeps yesterday as the effective report range');
    assert.match(await rangeCopyAll.textContent(),/文案全部提交\s*1/u,
      'yesterday counts remain visible before a custom range is applied');
    assert.match(await firstCopyReview.textContent(),/首次文案审核\s*2/u);
    assert.match(await discardedCopy.textContent(),/文案废弃数\s*1/u);
    const beforeCustomDraft=statisticsRequests().length;
    await fromDate.fill(todayRange.from);await toDate.fill(todayRange.to);
    assert.ok(await page.getByText(`统计范围：${historicalDay(1)} · 北京时间`,{exact:true}).isVisible(),
      'editing draft date fields does not change the applied yesterday range');
    assert.match(await rangeCopyAll.textContent(),/文案全部提交\s*1/u);
    assert.equal(statisticsRequests().length,beforeCustomDraft,'draft custom dates never request statistics before applying');
    await page.getByRole('button',{name:'应用筛选',exact:true}).click();
    await rangeCopyAll.getByText('4',{exact:true}).waitFor();
    await firstCopyReview.getByText('3',{exact:true}).waitFor();
    assert.ok(await page.getByText(`统计范围：${todayRange.from} · 北京时间`,{exact:true}).isVisible());
    await choosePeriod('今天');await choosePeriod('自定义日期');
    assert.equal(await fromDate.inputValue(),todayRange.from);
    assert.equal(await toDate.inputValue(),todayRange.to);
    assert.ok(await page.getByText(`统计范围：${todayRange.from} · 北京时间`,{exact:true}).isVisible(),
      'returning to today then opening custom dates starts from the currently shown today range');
    assert.match(await rangeCopyAll.textContent(),/文案全部提交\s*4/u);
    assert.match(await firstCopyReview.textContent(),/首次文案审核\s*3/u);
    await choosePeriod('近 7 天');
    await page.getByRole('heading',{name:'标注与图片初审',exact:true}).waitFor();
    await rangeCopyAll.getByText('7',{exact:true}).waitFor();
    await firstCopyReview.getByText('7',{exact:true}).waitFor();
    await discardedCopy.getByText('4',{exact:true}).waitFor();
    assert.match(await copyArticle.textContent(),/一次通过率\s*25\.0%\s*1 \/ 4 判定项次/u,
      'selected dates filter quality verdicts together with annotation activity');
    await copyQaArticle.getByRole('button').filter({hasText:'实际逐条操作量'}).getByText('7',{exact:true}).waitFor();
    assert.equal(new URL(statisticsRequests().at(-1),base).searchParams.get('period'),'7d');
    await rangeCopyAll.click();
    await page.getByRole('dialog',{name:'文案全部提交'}).getByText('共 7 次记录',{exact:true}).waitFor();
    assertActivityRange('submitAll',normalizePersonalFilters({period:'7d'},now).range);
    await page.keyboard.press('Escape');
    await choosePeriod('自定义日期');
    assert.notEqual(await fromDate.getAttribute('type'),'date','custom dates use the shared component instead of a native date control');
    await page.getByRole('button',{name:'选择开始日期',exact:true}).click();
    await page.getByRole('dialog',{name:'开始日期',exact:true}).getByRole('button',{name:'今天',exact:true}).click();
    assert.equal(await fromDate.inputValue(),todayRange.from,'calendar selection updates the controlled start date');
    await fromDate.fill(historicalDay(10));
    await page.getByRole('button',{name:'选择开始日期',exact:true}).click();
    if(process.env.PERSONAL_WORKSPACE_SCREENSHOTS)await page.screenshot({
      path:join(process.env.PERSONAL_WORKSPACE_SCREENSHOTS,'personal-statistics-calendar-desktop.png'),fullPage:true,
    });
    await page.getByRole('dialog',{name:'开始日期',exact:true}).getByRole('button',{name:historicalDay(10),exact:true}).focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(day=>document.activeElement?.getAttribute('aria-label')===day,historicalDay(9));
    await page.keyboard.press('Enter');
    assert.equal(await fromDate.inputValue(),historicalDay(9),'calendar dates support arrow keys and Enter');
    await fromDate.fill(historicalDay(10));await toDate.fill(historicalDay(10));
    await page.getByRole('button',{name:'选择结束日期',exact:true}).click();
    await page.getByRole('dialog',{name:'结束日期',exact:true}).getByRole('button',{name:historicalDay(10),exact:true}).click();
    await page.getByRole('button',{name:'应用筛选',exact:true}).click();
    await rangeCopyAll.getByText('1',{exact:true}).waitFor();
    await firstCopyReview.getByText('3',{exact:true}).waitFor();
    await discardedCopy.getByText('2',{exact:true}).waitFor();
    await imageArticle.getByRole('button').filter({hasText:'图片全部提交'}).getByText('1',{exact:true}).waitFor();
    await copyQaArticle.getByRole('button').filter({hasText:'实际逐条操作量'}).getByText('0',{exact:true}).waitFor();
    assert.match(await copyArticle.textContent(),/一次通过率\s*100\.0%\s*1 \/ 1 判定项次/u);
    const customRequest=new URL(statisticsRequests().at(-1),base).searchParams;
    assert.equal(customRequest.get('period'),'custom');
    assert.equal(customRequest.get('from'),historicalDay(10));assert.equal(customRequest.get('to'),historicalDay(10));
    assert.equal(overviewRequests().length,overviewBeforeFilters,'changing detail dates does not refetch the fixed today overview');
    assert.match(await copyPassedToday.textContent(),/今日文案质检通过\s*2/u,'historical detail filters leave today passes unchanged');
    assert.match(await imagePassedToday.textContent(),/今日图片质检通过\s*1/u);
    await copyPassedToday.click();
    await page.getByRole('dialog',{name:'今日文案质检通过'}).getByText('共 2 次记录',{exact:true}).waitFor();
    assertActivityRange('annotationOverall',todayRange);
    await page.keyboard.press('Escape');
    if(process.env.PERSONAL_WORKSPACE_SCREENSHOTS)await page.screenshot({
      path:join(process.env.PERSONAL_WORKSPACE_SCREENSHOTS,'personal-statistics-custom-desktop.png'),fullPage:true,
    });
    await firstCopyReview.click();
    const historicalReview=page.getByRole('dialog',{name:'首次文案审核'});
    await historicalReview.getByText('共 3 次记录',{exact:true}).waitFor();
    assert.equal(await historicalReview.getByRole('article').filter({hasText:'ACT-copy-month-first'}).count(),1);
    assert.equal(await historicalReview.getByRole('article').filter({hasText:'ACT-copy-first'}).count(),0,
      'custom detail excludes today\'s submissions');
    assertActivityRange('copyFirstReview',{from:historicalDay(10),to:historicalDay(10)});
    await page.keyboard.press('Escape');
    const beforeInvalidRange=statisticsRequests().length;
    await fromDate.fill(historicalDay(3));await toDate.fill(historicalDay(10));
    await page.getByRole('button',{name:'应用筛选',exact:true}).click();
    await page.getByRole('alert').filter({hasText:/开始日期.*结束日期/u}).waitFor();
    assert.equal(statisticsRequests().length,beforeInvalidRange,'reversed dates never send a statistics request');
    await rangeCopyAll.getByText('1',{exact:true}).waitFor();
    await choosePeriod('近 7 天');await rangeCopyAll.getByText('7',{exact:true}).waitFor();
    delayStatistics=true;
    const staleRangeRefresh=nextDelayedStatistics();
    await refresh.click();const finishStaleRange=await staleRangeRefresh;
    delayStatistics=false;
    await choosePeriod('昨天');await rangeCopyAll.getByText('1',{exact:true}).waitFor();
    await firstCopyReview.getByText('2',{exact:true}).waitFor();
    finishStaleRange();await page.waitForTimeout(100);
    assert.match(await rangeCopyAll.textContent(),/文案全部提交\s*1/u,
      'a late previous-range response cannot replace the selected range report');
    assert.match(await firstCopyReview.textContent(),/首次文案审核\s*2/u);
    failStatistics=true;
    await choosePeriod('自定义日期');await fromDate.fill(historicalDay(40));await toDate.fill(historicalDay(40));
    await page.getByRole('button',{name:'应用筛选',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'暂未取得统计数据'}).waitFor();
    assert.ok(await firstCopyReview.isDisabled(),'a failed new range does not allow stale-range detail actions');
    assert.match(await firstCopyReview.textContent(),/首次文案审核\s*—/u,
      'a failed new range does not show counts from a previously selected range');
    failStatistics=false;
    await choosePeriod('今天');await copyAll.getByText('4',{exact:true}).waitFor();
    await firstCopyReview.getByText('3',{exact:true}).waitFor();
    await page.getByRole('heading',{name:'今日标注与图片初审',exact:true}).waitFor();
    assert.equal(await page.getByRole('alert').count(),0,'errors belong to the range that failed');
    const overviewBounds=await overview.boundingBox(),beforeOverviewRefresh=overviewRequests().length;
    delayOverview=true;
    const pendingOverview=nextDelayedOverview();
    await refresh.click();const finishOverview=await pendingOverview;
    assert.match(await copyPassedToday.textContent(),/今日文案质检通过\s*2/u,'same-day overview values stay visible during refresh');
    assert.deepEqual(await overview.boundingBox(),overviewBounds,'overview refresh does not move the controls below it');
    for(let index=0;index<3;index++){
      await page.evaluate(()=>window.dispatchEvent(new Event('xhs:workspace-updated')));
      await page.waitForTimeout(350);
    }
    assert.equal(overviewRequests().length,beforeOverviewRefresh+1,'overview change signals do not replace a pending request');
    const coalescedOverview=nextDelayedOverview();finishOverview();
    const finishCoalescedOverview=await coalescedOverview;
    assert.equal(overviewRequests().length,beforeOverviewRefresh+2,'overview pending signals coalesce into one follow-up');
    delayOverview=false;finishCoalescedOverview();
    await overviewCount(copyPassedToday,2).waitFor();
    await page.waitForTimeout(400);
    assert.equal(overviewRequests().length,beforeOverviewRefresh+2,'overview invalidations stop after the coalesced refresh');
    assert.deepEqual(await overview.boundingBox(),overviewBounds);
    failOverview=true;
    await refresh.click();await overview.getByRole('alert').waitFor();
    assert.match(await copyPassedToday.textContent(),/今日文案质检通过\s*2/u,'a failed same-day refresh preserves known values');
    assert.match(await overview.getByRole('alert').textContent(),/保留|过时/u);
    assert.ok(await firstCopyReview.isEnabled(),'an overview failure leaves detail actions available');
    failOverview=false;
    await refresh.click();await page.waitForFunction(()=>!document.querySelector('[aria-label="今日概览"] [role="alert"]'));
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
    const requestsBeforeRefresh=statisticsRequests().length,abortsBeforeRefresh=abortedStatistics;
    delayStatistics=true;
    const firstPending=nextDelayedStatistics();
    await page.evaluate(()=>window.dispatchEvent(new Event('xhs:workspace-updated')));
    const finishFirst=await firstPending;
    await page.evaluate(()=>new Promise(requestAnimationFrame));
    await assertStableLayout('cards retain their position and size while a refresh is pending');
    assert.match(await copyAll.textContent(),/文案全部提交\s*4/u,'previous successful values stay visible');
    for(let index=0;index<3;index++){
      await page.evaluate(()=>window.dispatchEvent(new Event('xhs:workspace-updated')));
      await page.waitForTimeout(350);
    }
    assert.equal(statisticsRequests().length,requestsBeforeRefresh+1,'signals during a request do not start parallel replacement requests');
    assert.equal(abortedStatistics,abortsBeforeRefresh,'in-flight statistics requests are not aborted by invalidation signals');
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
    const beforeHiddenPoll=statisticsRequests().length,beforeHiddenOverview=overviewRequests().length;
    await page.evaluate(()=>{
      Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});
      for(const timer of window.__testIntervals.values())if(timer.delay===60_000||timer.delay===30_000)timer.tick();
      window.dispatchEvent(new Event('xhs:workspace-updated'));
    });
    await page.waitForTimeout(350);
    assert.equal(statisticsRequests().length,beforeHiddenPoll,'a hidden statistics page neither polls nor fetches on change signals');
    assert.equal(overviewRequests().length,beforeHiddenOverview,'a hidden overview neither polls nor fetches on change signals');
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
    assert.equal(await page.evaluate(()=>window.__heldWorkspaceTimeouts.size),2,
      'the pending 300 ms notifications for details and overview survive both tab switches');
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
    assert.match(await copyAll.textContent(),/文案全部提交\s*6/u,'the stale value remains until the delayed response returns');
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
    assert.equal(await page.evaluate(()=>[...window.__testIntervals.values()].filter(timer=>timer.delay===30_000).length),2,
      'current job counts and the fixed today overview keep their independent polling timers');
    await overviewCount(readyToday,2).waitFor();
    await overviewCount(copyPassedToday,2).waitFor();
    const overviewBeforeScope=overviewRequests().length;
    await page.getByRole('combobox',{name:'作业关系',exact:true}).click();
    await page.getByRole('option',{name:'我创建的',exact:true}).click();await rework.waitFor();
    assert.equal(new URL(statisticsRequests().at(-1),base).searchParams.get('personalScope'),'CREATED');
    assert.equal(overviewRequests().length,overviewBeforeScope,'changing job ownership does not alter today overview');
    assert.match(await copyPassedToday.textContent(),/今日文案质检通过\s*2/u);
    await copyPassedToday.click();
    await page.getByRole('dialog',{name:'今日文案质检通过'}).getByText('共 2 次记录',{exact:true}).waitFor();
    assertActivityRange('annotationOverall',todayRange);
    await page.keyboard.press('Escape');
    await page.getByRole('combobox',{name:'作业关系',exact:true}).click();
    await page.getByRole('option',{name:'我负责的',exact:true}).click();await rework.waitFor();
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
    await overviewCount(readyToday,2).waitFor();
    const overviewMobileBounds=await Promise.all([readyToday,copyPassedToday,imagePassedToday].map(element=>element.boundingBox()));
    assert.ok(overviewMobileBounds[0].y<overviewMobileBounds[1].y&&overviewMobileBounds[1].y<overviewMobileBounds[2].y,
      'the today overview stacks vertically on mobile');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'mobile statistics should not overflow');
    if(process.env.PERSONAL_WORKSPACE_SCREENSHOTS)await page.screenshot({path:join(process.env.PERSONAL_WORKSPACE_SCREENSHOTS,'statistics-mobile.png'),fullPage:true});
    await choosePeriod('自定义日期');
    await page.getByRole('button',{name:'选择开始日期',exact:true}).click();
    const mobileCalendar=page.getByRole('dialog',{name:'开始日期',exact:true});
    const mobileCalendarBounds=await mobileCalendar.boundingBox();
    assert.ok(mobileCalendarBounds&&mobileCalendarBounds.x>=0&&mobileCalendarBounds.x+mobileCalendarBounds.width<=390,
      'the shared statistics calendar stays within the mobile viewport');
    if(process.env.PERSONAL_WORKSPACE_SCREENSHOTS)await page.screenshot({
      path:join(process.env.PERSONAL_WORKSPACE_SCREENSHOTS,'personal-statistics-calendar-mobile.png'),fullPage:true,
    });
    await page.keyboard.press('Escape');await choosePeriod('今天');
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
    facts=[];events.length=0;submissions.length=0;qualityFacts.length=0;discardFacts.length=0;
    await page.goto(`${base}/workbench/personal-statistics`);
    const emptyCopy=page.getByRole('article').filter({has:page.getByRole('heading',{name:'文案标注',exact:true})});
    await emptyCopy.getByRole('button').filter({has:page.getByText('首次文案审核',{exact:true})}).getByText('0',{exact:true}).waitFor();
    assert.match(await emptyCopy.textContent(),/一次通过率\s*—\s*0 \/ 0 判定项次/u);
    await emptyCopy.getByRole('button').filter({has:page.getByText('首次文案审核',{exact:true})}).click();
    const emptyActivity=page.getByRole('dialog',{name:'首次文案审核'});
    await emptyActivity.getByText(/暂无首次文案审核记录/u).waitFor();
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
    const beforeMidnight=todayRange.endMs-1_000,afterMidnight=todayRange.endMs+1_000;
    statisticsNow=beforeMidnight;
    submissions.push(
      {id:'copy-before-midnight',taskId:201,kind:'COMPLETE',stage:'COPY',at:new Date(beforeMidnight).toISOString(),firstSubmission:true,rework:false},
      {id:'copy-after-midnight-first',taskId:202,kind:'COMPLETE',stage:'COPY',at:new Date(afterMidnight).toISOString(),firstSubmission:true,rework:false},
      {id:'copy-after-midnight-repeat',taskId:202,kind:'COMPLETE',stage:'COPY',at:new Date(afterMidnight).toISOString(),firstSubmission:false,rework:false},
    );
    discardFacts.push(
      {id:'discard-before-midnight',kind:'ANNOTATION_DISCARD',taskId:203,accountId:22,stage:'COPY',at:new Date(beforeMidnight).toISOString(),outcome:'DISCARD'},
      ...[204,205].map(taskId=>({id:`discard-after-midnight-${taskId}`,kind:'ANNOTATION_DISCARD',taskId,accountId:22,stage:'COPY',at:new Date(afterMidnight).toISOString(),outcome:'DISCARD'})),
    );
    qualityFacts.push(
      {id:'quality-before-midnight',kind:'ANNOTATION_QUALITY',taskId:201,accountId:22,stage:'COPY',at:new Date(beforeMidnight).toISOString(),outcome:'PASS',firstPassed:true},
      ...[202,203].map(taskId=>({id:`quality-after-midnight-${taskId}`,kind:'ANNOTATION_QUALITY',taskId,accountId:22,stage:'COPY',at:new Date(afterMidnight).toISOString(),outcome:'PASS',firstPassed:false})),
      {id:'quality-image-after-midnight',kind:'ANNOTATION_QUALITY',taskId:204,accountId:22,stage:'IMAGE',at:new Date(afterMidnight).toISOString(),outcome:'PASS',firstPassed:true},
    );
    await page.clock.setFixedTime(beforeMidnight);
    await page.goto(`${base}/workbench/personal-statistics`);
    await firstCopyReview.getByText('2',{exact:true}).waitFor();
    await copyAll.getByText('1',{exact:true}).waitFor();
    await overviewCount(copyPassedToday,1).waitFor();
    await overviewCount(imagePassedToday,0).waitFor();
    const beforeMidnightRequests=statisticsRequests().length;
    delayStatistics=true;recomputeStatisticsAtSend=true;
    const crossingMidnight=nextDelayedStatistics();
    await refresh.click();const finishCrossingMidnight=await crossingMidnight;
    assert.equal(statisticsRequests().length,beforeMidnightRequests+1,'one preset request is pending before midnight');
    statisticsNow=afterMidnight;
    await page.clock.setFixedTime(afterMidnight);
    delayStatistics=false;
    delayOverview=true;
    const newDayOverview=nextDelayedOverview();
    const newDayRequest=page.waitForRequest(request=>request.url().includes('/personal-workspace/statistics?')
      &&new URL(request.url()).searchParams.get('section')==='personal');
    finishCrossingMidnight();
    await newDayRequest;
    const finishNewDayOverview=await newDayOverview;
    assert.match(await copyPassedToday.textContent(),/今日文案质检通过\s*—/u,
      'old-day passed counts disappear while the next Beijing day is being loaded');
    assert.ok(await copyPassedToday.isDisabled(),'old-day passes cannot open a detail for the new day');
    assert.equal(await overview.locator('strong').filter({hasText:/^0(?:条|次)?$/u}).count(),0,'new-day loading never claims a zero count');
    delayOverview=false;finishNewDayOverview();
    await overviewCount(copyPassedToday,2).waitFor();
    await overviewCount(imagePassedToday,1).waitFor();
    await firstCopyReview.getByText('3',{exact:true}).waitFor();
    await copyAll.getByText('2',{exact:true}).waitFor();
    assert.equal(statisticsRequests().length,beforeMidnightRequests+2,
      'finishing a preset request across Beijing midnight immediately rereads the new date');
    assert.ok(await page.getByText(`统计范围：${chinaDay(afterMidnight)} · 北京时间`,{exact:true}).isVisible());
    assert.equal(new URL(statisticsRequests().at(-1),base).searchParams.get('period'),'today');
    assert.equal(await page.getByRole('alert').count(),0,'a crossed-midnight response never raises a range mismatch alert');
    await copyPassedToday.click();
    await page.getByRole('dialog',{name:'今日文案质检通过'}).getByText('共 2 次记录',{exact:true}).waitFor();
    assertActivityRange('annotationOverall',{from:chinaDay(afterMidnight),to:chinaDay(afterMidnight)});
    await page.keyboard.press('Escape');
    recomputeStatisticsAtSend=false;
    assert.deepEqual(errors,[]);
  } finally {
    await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
    assert.ok(root.startsWith(join(tmpdir(),'personal-workspace-browser-')));await rm(root,{recursive:true,force:true,maxRetries:4,retryDelay:100});
  }
});
