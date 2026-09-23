import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp,readFile,rm,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { buildPerformanceSnapshot,normalizePerformanceFilters,performanceMetricRows,performancePeoplePage,performanceCsv } from '../src/operator-performance.mjs';

test('operator dashboard browser: weighted pass rate, account outcomes, explanations, filters and mobile',{
  skip:process.env.RUN_OPERATOR_PERFORMANCE_BROWSER!=='1',timeout:120_000,
},async()=>{
  const {build}=await import('esbuild');const {chromium}=await import('playwright-core');
  const root=await mkdtemp(join(tmpdir(),'operator-performance-browser-'));
  const now=Date.now(),at=new Date(now).toISOString(),token='11111111-1111-4111-8111-111111111111';
  const todayDate=new Date(now+8*3600000).toISOString().slice(0,10);
  const yesterdayDate=new Date(Date.parse(`${todayDate}T00:00:00Z`)-86400000).toISOString().slice(0,10);
  const yesterdayAt=`${yesterdayDate}T04:00:00.000Z`;
  const todayEarlierAt=new Date(Date.parse(`${todayDate}T00:00:00Z`)-8*3600000).toISOString();
  const common={accountId:11,username:'worker-a',displayName:'标注甲',stage:'COPY',at,query:'示例任务',exclusion:null};
  const rows=[...Array.from({length:10},(_,i)=>({...common,id:`s${i}`,taskId:i+1,kind:'SUBMIT',firstSubmission:true})),
    ...Array.from({length:4},(_,i)=>({...common,id:`q${i}`,taskId:i+1,kind:'QUALITY',first:true,sampleKind:'RANDOM',outcome:i===3?'RETURN':'PASS'})),
    ...Array.from({length:2},(_,i)=>({...common,id:`image-q${i}`,taskId:i+9,stage:'IMAGE',kind:'QUALITY',first:true,sampleKind:'RANDOM',outcome:i===0?'PASS':'RETURN'})),
    ...['FIRST_PASS','FIRST_PASS','RETURNED','DISCARDED','FIRST_PASS','RETURNED'].map((bucket,i)=>({...common,id:`account-quality:${i}`,taskId:i+1,stage:i<4?'COPY':'IMAGE',kind:'ACCOUNT_QUALITY',bucket})),
    ...Array.from({length:6},(_,i)=>({...common,id:`annotation-quality:${i}`,taskId:i+1,stage:i<4?'COPY':'IMAGE',kind:'ANNOTATION_QUALITY',
      firstPassed:[0,1,4].includes(i),reworkPassed:[2,5].includes(i),finalPassed:i!==3,outcome:i===3?'RETURN':'PASS'}))];
  const sampleAccount={...common,accountId:33,username:'weishihan',displayName:'位士涵'};
  rows.push(...Array.from({length:12},(_,i)=>({...sampleAccount,id:`sample-account-quality:${i}`,taskId:i===9?100:100+i,stage:i<9?'COPY':'IMAGE',kind:'ACCOUNT_QUALITY',bucket:i<9?'RETURNED':'FIRST_PASS'})));
  rows.push(...Array.from({length:12},(_,i)=>({...sampleAccount,id:`sample-annotation-quality:${i}`,taskId:i===9?100:100+i,stage:i<9?'COPY':'IMAGE',kind:'ANNOTATION_QUALITY',
    firstPassed:i>=9,reworkPassed:i<5,finalPassed:i<5||i>=9,outcome:i<5||i>=9?'PASS':'RETURN'})));
  rows.push({...sampleAccount,id:'sample-annotation-quality:yesterday',taskId:100,stage:'COPY',kind:'ANNOTATION_QUALITY',at:yesterdayAt,
    day:yesterdayDate,firstPassed:false,reworkPassed:false,finalPassed:false,outcome:'RETURN',fromBatch:true});
  rows.push({...sampleAccount,id:'sample-annotation-quality:today-return',taskId:100,stage:'COPY',kind:'ANNOTATION_QUALITY',at:todayEarlierAt,
    day:todayDate,firstPassed:false,reworkPassed:false,finalPassed:false,outcome:'RETURN'});
  rows.push(...Array.from({length:8},(_,i)=>({...common,id:`review:${i}`,taskId:i+1,samplingItemId:i+1,accountId:22,username:'qa-only',displayName:'质检同学',stage:i<5?'COPY':'IMAGE',kind:'QA_REVIEW',sampleKind:'RANDOM',outcome:[1,6].includes(i)?'RETURN':'PASS'})));
  rows.push(...[2,7].map((taskId,i)=>({...common,id:`review:recheck:${i}`,taskId,samplingItemId:i+9,accountId:22,username:'qa-only',displayName:'质检同学',stage:i===0?'COPY':'IMAGE',kind:'QA_REVIEW',sampleKind:'MANDATORY_RECHECK',outcome:'PASS'})));
  rows.push(...[
    {id:'batch:copy',stage:'COPY',samplingItemId:2,affectedTaskIds:[50,51]},
    {id:'batch:image',stage:'IMAGE',samplingItemId:null,affectedCount:3,affectedTaskIds:[52,53,54]},
  ].map(batch=>({...common,...batch,taskId:null,accountId:22,username:'qa-only',displayName:'质检同学',kind:'QA_BATCH_RETURN',batchId:101})));
  rows.push({...common,id:'annotation:unknown-batch',taskId:null,accountId:null,username:'',displayName:'',kind:'ANNOTATION_UNKNOWN_BATCH',unknownCount:2});
  rows.push({...common,id:'annotation:unknown-scope',taskId:null,accountId:null,username:'',displayName:'',kind:'ANNOTATION_UNKNOWN_BATCH',unknownCount:null,unknownScope:true});
  let fail=false,snapshot,server,browser;const requests=[],errors=[];
  try{
    await build({stdin:{contents:`import './app/globals.css';import React from 'react';import{createRoot}from'react-dom/client';
      import{OperatorPerformance}from'./app/workbench-statistics/operator-performance';
      createRoot(document.getElementById('root')).render(<OperatorPerformance initialFilters={Object.fromEntries(new URLSearchParams(location.search))}/>);`,
      resolveDir:process.cwd(),loader:'tsx'},bundle:true,outfile:join(root,'bundle.js'),jsx:'automatic',platform:'browser',conditions:['style'],
      alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"test"'},plugins:[{name:'next-test',setup(plugin){
        plugin.onResolve({filter:/^next\/(link|dynamic)$/},args=>({path:args.path,namespace:'next-test'}));
        plugin.onLoad({filter:/.*/,namespace:'next-test'},args=>({loader:'jsx',resolveDir:process.cwd(),contents:args.path.endsWith('link')
          ?`import React from 'react';export default function Link({children,...props}){return <a {...props}>{children}</a>}`
          :`import React,{lazy,Suspense}from'react';export default function dynamic(loader){const C=lazy(loader);return props=><Suspense fallback={<span>加载中</span>}><C {...props}/></Suspense>}` }));
      }}]});
    const js=await readFile(join(root,'bundle.js')),rawCss=await readFile(join(root,'bundle.css'),'utf8');
    const {default:postcss}=await import('postcss'),{default:tailwind}=await import('@tailwindcss/postcss');
    const {css}=await postcss([tailwind()]).process(rawCss,{from:join(process.cwd(),'app/globals.css')});
    server=createServer((req,res)=>{
      if(req.url==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(js);return;}
      if(req.url==='/bundle.css'){res.setHeader('Content-Type','text/css');res.end(css);return;}
      if(req.url.startsWith('/api/')){
        requests.push(req.url);const url=new URL(req.url,'http://localhost'),input=Object.fromEntries(url.searchParams);
        if(url.pathname.endsWith('/users')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[
          {id:11,username:'worker-a',displayName:'标注甲',status:'ACTIVE'},
          {id:22,username:'qa-only',displayName:'质检同学',status:'ACTIVE'},
          {id:33,username:'weishihan',displayName:'位士涵',status:'ACTIVE'},
        ]}));return;}
        if(fail&&!url.pathname.endsWith('/export')){res.statusCode=503;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:{code:'TEST_DOWN',message:'统计服务暂不可用'}}));return;}
        if(url.pathname.endsWith('/export')){res.setHeader('Content-Type','text/csv');res.end(performanceCsv(snapshot));return;}
        const filters=normalizePerformanceFilters(input,now);let data;
        if(/\/tasks$/u.test(url.pathname)){
          const accountId=Number(url.pathname.split('/').at(-2));
          const items=performanceMetricRows(snapshot.rows.filter(row=>!accountId||row.accountId===accountId),filters.metric,filters.stage,filters.sampleSet);
          data={person:accountId?snapshot.people.find(p=>p.accountId===accountId):{...snapshot.summary,displayName:'团队'},asOf:at,range:snapshot.range,items:items.slice(0,15),total:items.length,page:1,pageSize:15,trend:snapshot.trend,current:[],timeline:[]};
        }else{
          snapshot=buildPerformanceSnapshot(structuredClone(rows),[],[],filters,new Date(now).toISOString());
          const {rows:unused,people,...report}=snapshot;
          data={...report,people:performancePeoplePage(snapshot,filters),snapshotToken:token,expiresAt:new Date(now+300000).toISOString()};
        }
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data}));return;
      }
      res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="zh"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><body style="margin:0;padding:20px"><div id="root"></div><script src="/bundle.js"></script></body></html>');
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.on('pageerror',error=>errors.push(error.message));
    const chooseSelect=async(scope,label,option)=>{
      await scope.getByRole('combobox',{name:label,exact:true}).click();
      await page.getByRole('option',{name:option,exact:true}).click();
    };
    const assertFilterLabelsSingleLine=async(scope)=>{
      for(const name of ['明细范围','明细阶段']){
        const label=scope.locator(`label:has([aria-label="${name}"])`);
        const lines=await label.evaluate(element=>{
          const text=[...element.childNodes].find(node=>node.nodeType===Node.TEXT_NODE);
          const range=document.createRange();range.selectNodeContents(text);
          return range.getClientRects().length;
        });
        assert.equal(lines,1,`${name} stays on one line`);
      }
    };
    const screenshots=resolve('.codex_artifacts/operator-performance');await mkdir(screenshots,{recursive:true});
    await page.goto(`${base}/workbench-statistics?period=7d`);
    const overall=page.getByRole('region',{name:'质检操作通过率'});
    await overall.getByText('53.33%',{exact:true}).waitFor();
    assert.match(await overall.textContent(),/通过 8 \/ 判定 15 项次/u,'team pass rate includes initial, recheck and batch-affected decisions by QA operators');
    assert.match(await overall.textContent(),/文案62\.50%5 \/ 8 项次/u);
    assert.match(await overall.textContent(),/图片42\.86%3 \/ 7 项次/u);
    assert.equal(await page.getByRole('note').count(),0,'explanations start collapsed');
    await overall.getByRole('button',{name:'通过率口径',exact:true}).click();
    await page.getByRole('note').getByText(/返修/u).waitFor();
    assert.match(await page.getByRole('note').textContent(),/(?:整批|批量)打回/u,'overall rate methodology explains batch returns');
    await page.getByRole('button',{name:'关闭指标说明'}).click();
    assert.equal(await page.getByRole('note').count(),0);
    await page.getByText('工作量与趋势',{exact:true}).click();
    await page.getByRole('button',{name:/文案标注：10 条/u}).waitFor();
    assert.equal(await page.locator('[aria-label="总数据"] > article').count(),5);
    await page.getByRole('img',{name:'每日标注与质检条数',exact:true}).waitFor();
    await chooseSelect(page,'人员','标注甲（worker-a）');
    await Promise.all([page.waitForResponse(response=>response.url().includes('accountId=11')),
      page.getByRole('button',{name:'应用筛选',exact:true}).click()]);
    await page.getByText('人员：标注甲（worker-a）',{exact:true}).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('view'),'overview');
    assert.equal(new URL(page.url()).searchParams.get('accountId'),'11');
    await page.getByText('所选人员质检',{exact:true}).waitFor();
    assert.match(await page.getByRole('region',{name:'质检操作通过率'}).textContent(),/0\.00%通过 0 \/ 判定 0 项次/u,'producer with no QA decisions displays a numeric zero QA rate');
    await page.screenshot({path:join(screenshots,'overview-desktop.png'),fullPage:true});
    await page.getByRole('button',{name:'账号数据',exact:true}).click();
    await page.waitForFunction(()=>new URLSearchParams(location.search).get('stage')==='COPY');
    assert.match(await page.getByRole('combobox',{name:'内容类型'}).textContent(),/文案/u);
    assert.match(await page.getByRole('combobox',{name:'人员'}).textContent(),/标注甲（worker-a）/u,'person scope survives the view switch');
    await page.goto(`${base}/workbench-statistics?view=accounts&period=7d&accountId=11`);
    await page.getByRole('button',{name:'标注甲',exact:true}).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('stage'),'COPY','old account links without a stage restore the copy scope');
    await chooseSelect(page,'人员','全部人员');
    await Promise.all([page.waitForResponse(response=>!response.url().includes('accountId=11')&&response.url().includes('activity=ALL')),
      page.getByRole('button',{name:'应用筛选',exact:true}).click()]);
    await page.getByRole('button',{name:'标注甲',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'近 7 天',exact:true}).getAttribute('aria-pressed'),'true');
    assert.equal(await page.getByRole('button',{name:'全部',exact:true}).getAttribute('aria-pressed'),'true');
    assert.equal(await page.getByRole('columnheader').count(),6,'default account table shows content outcomes and overall pass rate');
    assert.deepEqual((await page.getByRole('region',{name:'账号统计表'}).locator('thead th').allTextContents()).map(value=>value.trim()),[
      '账号','文案判定项次','文案一次通过率','文案整体通过率','文案打回率','文案首检废弃率',
    ]);
    const unattributedBatchNote=page.getByRole('note').filter({hasText:'缺少成员归属'});
    await unattributedBatchNote.waitFor();
    assert.match(await unattributedBatchNote.textContent(),/另有 2 项整批波及缺少成员归属，未分摊到账号。/u);
    assert.match(await unattributedBatchNote.textContent(),/另有 1 次整批打回的总波及数量无法确认；已识别成员仍计入账号。/u);
    const person=page.getByRole('row').filter({hasText:'标注甲'});
    assert.match(await person.textContent(),/4文案判定项次/u);
    assert.match(await person.textContent(),/文案一次通过率50\.00%2 \/ 4 项次/u);
    assert.match(await person.textContent(),/文案整体通过率75\.00%3 \/ 4 判定项次一次通过 2 项次 · 返修通过 1 项次/u,'annotation overall pass includes first and rework passes for the producer');
    assert.match(await person.textContent(),/文案打回率25\.00%1 \/ 4 项次/u);
    assert.match(await person.textContent(),/文案首检废弃率25\.00%1 \/ 4 条/u);
    const samplePerson=page.getByRole('row').filter({hasText:'位士涵'});
    assert.match(await samplePerson.textContent(),/11文案判定项次/u,'seven-day range counts every verdict, including two on one content today, while excluding image verdicts');
    assert.match(await samplePerson.textContent(),/文案一次通过率0\.00%0 \/ 11 项次/u);
    assert.match(await samplePerson.textContent(),/文案整体通过率45\.45%5 \/ 11 判定项次一次通过 0 项次 · 返修通过 5 项次/u);
    assert.match(await samplePerson.textContent(),/文案打回率54\.55%6 \/ 11 项次/u);
    await Promise.all([page.waitForResponse(response=>{
      const url=new URL(response.url());return url.pathname.endsWith('/admin/operator-performance')&&url.searchParams.get('period')==='today'&&url.searchParams.get('stage')==='COPY';
    }),page.getByRole('button',{name:'今日',exact:true}).click()]);
    assert.match(await samplePerson.textContent(),/10文案判定项次/u,'today counts both RETURN and PASS on the same content');
    assert.match(await samplePerson.textContent(),/文案整体通过率50\.00%5 \/ 10 判定项次/u,'today counts the rework pass and same-day return separately');
    assert.match(await samplePerson.textContent(),/文案打回率50\.00%5 \/ 10 项次/u);
    await samplePerson.getByRole('button',{name:/位士涵文案整体通过率 50\.00%/u}).click();
    const todayDetail=page.getByRole('dialog');
    await todayDetail.getByText('共 10 条事件。',{exact:false}).waitFor();
    assert.equal(await todayDetail.getByText('#100',{exact:true}).count(),2,'same content has separate RETURN and PASS detail rows on one day');
    await page.keyboard.press('Escape');
    await samplePerson.getByRole('button',{name:/位士涵文案打回率 50\.00%/u}).click();
    const todayReturns=page.getByRole('dialog');
    await todayReturns.getByText('共 5 条事件。',{exact:false}).waitFor();
    assert.equal(await todayReturns.getByText('#100',{exact:true}).count(),1,'return-rate detail contains only the return verdict on that content');
    assert.ok(requests.some(url=>url.includes('/33/tasks?')&&url.includes('metric=annotationOverall')&&url.includes('sampleSet=failed')));
    await page.keyboard.press('Escape');
    await Promise.all([page.waitForResponse(response=>{
      const url=new URL(response.url());return url.pathname.endsWith('/admin/operator-performance')&&url.searchParams.get('from')===yesterdayDate&&url.searchParams.get('to')===yesterdayDate&&url.searchParams.get('stage')==='COPY';
    }),page.getByRole('button',{name:'昨日',exact:true}).click()]);
    assert.match(await samplePerson.textContent(),/1文案判定项次/u);
    assert.match(await samplePerson.textContent(),/文案整体通过率0\.00%0 \/ 1 判定项次/u);
    assert.match(await samplePerson.textContent(),/文案打回率100\.00%1 \/ 1 项次/u);
    await samplePerson.getByRole('button',{name:/位士涵文案打回率 100\.00%/u}).click();
    const previousDayDetail=page.getByRole('dialog');
    await previousDayDetail.getByText('共 1 条事件。',{exact:false}).waitFor();
    assert.match(await previousDayDetail.textContent(),/#100/u);
    assert.match(await previousDayDetail.textContent(),/本次结论：退回 · 本次计入一项次 · 整批打回波及项/u);
    await page.keyboard.press('Escape');
    await Promise.all([page.waitForResponse(response=>{
      const url=new URL(response.url());return url.pathname.endsWith('/admin/operator-performance')&&url.searchParams.get('period')==='7d'&&url.searchParams.get('stage')==='COPY';
    }),page.getByRole('button',{name:'近 7 天',exact:true}).click()]);
    const allReviewerRow=page.getByRole('row').filter({hasText:'质检同学'});
    assert.match(await allReviewerRow.textContent(),/文案整体通过率0\.00%0 \/ 0 判定项次/u,'QA-only account has no annotation outcomes in the default account list');
    assert.equal(await page.getByRole('note').filter({hasText:'文案整体通过率按实际标注账号'}).count(),0,'account methodology stays hidden until requested');
    await page.getByRole('region',{name:'账号数据'}).getByRole('button',{name:'指标说明'}).click();
    const accountHelp=page.getByRole('note').filter({hasText:'文案整体通过率按实际标注账号'});
    await accountHelp.waitFor();
    assert.match(await accountHelp.textContent(),/(?:整批|批量)打回/u,'account help explains batch-affected returns');
    await accountHelp.getByText(/整批打回的每条可识别受影响文案/u).waitFor();
    assert.match(await accountHelp.textContent(),/北京时间每次有效质检结论的时间/u);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('note').filter({hasText:'文案整体通过率按实际标注账号'}).count(),0);
    await person.getByRole('button',{name:/标注甲文案整体通过率 75\.00%/u}).click();
    await page.getByRole('dialog').getByText('共 4 条事件。',{exact:false}).waitFor();
    assert.match(await page.getByRole('dialog').getByRole('combobox',{name:'明细范围'}).textContent(),/整体通过率判定项次/u);
    assert.match(await page.getByRole('dialog').getByRole('combobox',{name:'明细阶段'}).textContent(),/文案/u);
    await page.getByRole('dialog').getByRole('combobox',{name:'明细阶段'}).click();
    assert.equal(await page.getByRole('option',{name:'图片',exact:true}).count(),0,'copy-scoped details do not offer image');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await person.getByRole('button',{name:/标注甲文案一次通过率 50\.00%/u}).click();
    const dialog=page.getByRole('dialog');await dialog.getByText('共 2 条事件。',{exact:false}).waitFor();
    assert.ok(requests.some(url=>url.includes('/11/tasks?')&&url.includes('metric=annotationOverall')&&url.includes('sampleSet=first')),'daily first-pass detail uses the daily verdict rows');
    await assertFilterLabelsSingleLine(dialog);
    await dialog.getByRole('combobox',{name:'明细范围'}).click();
    const longOption=page.getByRole('option',{name:'首次返修复检',exact:true});
    assert.ok((await longOption.boundingBox()).height<45,'long dropdown values stay on one line');
    await page.keyboard.press('Escape');
    assert.equal(await dialog.getByRole('tab',{name:'操作明细',exact:true}).getAttribute('aria-selected'),'true');
    assert.match(await dialog.getByRole('combobox',{name:'质检结论'}).textContent(),/一次通过/u);
    await chooseSelect(dialog,'明细范围','首轮质检');
    await dialog.getByText('共 4 条事件。',{exact:false}).waitFor();
    await chooseSelect(dialog,'质检结论','退回样本');
    await dialog.getByText('共 1 条事件。',{exact:false}).waitFor();
    assert.ok(requests.some(url=>url.includes('/11/tasks?')&&url.includes('metric=firstPass')&&url.includes('stage=COPY')&&url.includes('sampleSet=failed')));
    await dialog.getByRole('tab',{name:'质量与时效',exact:true}).click();
    await dialog.getByRole('heading',{name:'标注质量与时效',exact:true}).waitFor();
    assert.match(await dialog.getByRole('tabpanel').textContent(),/75\.0{1,2}%/);
    await dialog.screenshot({path:join(screenshots,'detail-quality-desktop.png'),animations:'disabled'});
    await page.keyboard.press('ArrowRight');
    await dialog.getByRole('heading',{name:'当前标注待办',exact:true}).waitFor();
    await dialog.locator('canvas').nth(1).waitFor();
    await page.keyboard.press('Home');
    await dialog.screenshot({path:join(screenshots,'detail-events-desktop.png'),animations:'disabled'});
    await page.keyboard.press('Escape');
    await chooseSelect(page,'内容类型','图片');
    await page.getByRole('button',{name:'应用筛选',exact:true}).click();
    await page.waitForFunction(()=>new URLSearchParams(location.search).get('stage')==='IMAGE');
    await page.getByRole('row').filter({hasText:'标注甲'}).getByRole('button',{name:/图片一次通过率 50\.00%/u}).waitFor();
    assert.match(await page.getByRole('row').filter({hasText:'标注甲'}).textContent(),/图片整体通过率100\.00%2 \/ 2 判定项次/u,'explicit image filter uses only image annotation outcomes');
    assert.match(await page.getByRole('row').filter({hasText:'位士涵'}).textContent(),/图片整体通过率100\.00%3 \/ 3 判定项次/u);
    assert.match(await page.getByRole('row').filter({hasText:'质检同学'}).textContent(),/图片整体通过率0\.00%0 \/ 0 判定项次/u);
    assert.deepEqual((await page.getByRole('region',{name:'账号统计表'}).locator('thead th').allTextContents()).map(value=>value.trim()),[
      '账号','图片判定项次','图片一次通过率','图片整体通过率','图片打回率','图片首检废弃率',
    ]);
    await page.goto(`${base}/workbench-statistics?view=accounts&period=7d&stage=IMAGE`);
    await page.getByRole('row').filter({hasText:'位士涵'}).getByRole('button',{name:/图片整体通过率 100\.00%/u}).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('stage'),'IMAGE','explicit image links retain their stage');
    assert.equal(await page.getByRole('region',{name:'质检操作通过率'}).count(),0,'the account view keeps rates in account rows');
    await chooseSelect(page,'内容类型','文案');
    await page.getByRole('button',{name:'应用筛选',exact:true}).click();
    await page.waitForFunction(()=>new URLSearchParams(location.search).get('stage')==='COPY');
    await Promise.all([page.waitForResponse(response=>response.url().includes('/export?')),
      page.getByRole('button',{name:'导出报表',exact:true}).click()]);
    assert.ok(requests.some(url=>url.includes(`/export?snapshotToken=${token}`)));
    fail=true;await page.getByRole('button',{name:'刷新',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'保留上次成功'}).waitFor();
    assert.ok(await page.getByRole('button',{name:'标注甲',exact:true}).isVisible());
    fail=false;await page.getByRole('button',{name:'刷新',exact:true}).click();
    await page.getByRole('button',{name:'刷新',exact:true}).waitFor();
    await page.getByRole('textbox',{name:'账号',exact:true}).fill('标注甲');await page.getByRole('button',{name:'应用筛选',exact:true}).click();
    await page.waitForFunction(()=>new URLSearchParams(location.search).get('query')==='标注甲');
    await page.reload();await page.getByRole('button',{name:'标注甲',exact:true}).waitFor();
    assert.equal(await page.getByRole('textbox',{name:'账号',exact:true}).inputValue(),'标注甲');
    await page.screenshot({path:join(screenshots,'desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:join(screenshots,'mobile.png'),fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'mobile page stays inside viewport');
    assert.equal(await page.getByRole('region',{name:'账号统计表'}).evaluate(element=>element.scrollWidth<=element.clientWidth+1),true,'mobile quality cards need no horizontal scrolling');
    const mobilePerson=page.getByRole('row').filter({hasText:'标注甲'});
    for(const [label,rate] of [['文案一次通过率','50.00%'],['文案打回率','25.00%'],['文案首检废弃率','25.00%']]){
      const metric=mobilePerson.getByRole('button',{name:new RegExp(`标注甲${label} ${rate.replace('.','\\.')}`,'u')});
      const bounds=await metric.boundingBox();
      assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=391,`${label} is fully inside the mobile viewport`);
    }
    const mobileOverall=mobilePerson.getByRole('cell').filter({hasText:'文案整体通过率'});
    assert.equal(await mobileOverall.count(),1,'default mobile card includes overall pass rate');
    assert.match(await mobileOverall.textContent(),/75\.00%3 \/ 4 判定项次/u);
    const mobileOverallBounds=await mobileOverall.boundingBox();
    assert.ok(mobileOverallBounds&&mobileOverallBounds.x>=0&&mobileOverallBounds.x+mobileOverallBounds.width<=391,'overall pass rate fits the mobile card');
    assert.match(await page.getByRole('combobox',{name:'账号排序'}).textContent(),/参与处理最多/u);
    await Promise.all([page.waitForResponse(response=>{
      const url=new URL(response.url());return url.pathname.endsWith('/admin/operator-performance')&&url.searchParams.get('sort')==='firstPassRate'&&url.searchParams.get('order')==='desc';
    }),chooseSelect(page,'账号排序','文案一次通过率最高')]);
    assert.equal(new URL(page.url()).searchParams.get('sort'),'firstPassRate');
    assert.match(await page.getByRole('combobox',{name:'账号排序'}).textContent(),/文案一次通过率最高/u);
    await page.getByRole('button',{name:'标注甲',exact:true}).click();await page.getByRole('dialog').getByText('共 4 条事件。',{exact:false}).waitFor();
    await assertFilterLabelsSingleLine(dialog);
    assert.ok(await page.getByRole('button',{name:'关闭弹窗',exact:true}).isVisible());
    await dialog.screenshot({path:join(screenshots,'detail-mobile.png'),animations:'disabled'});
    await page.keyboard.press('Escape');
    await page.getByRole('textbox',{name:'账号',exact:true}).fill('');await page.getByRole('button',{name:'应用筛选',exact:true}).click();
    const allMobileReviewer=page.getByRole('row').filter({hasText:'质检同学'});
    await allMobileReviewer.waitFor();
    const allMobileOverall=allMobileReviewer.getByRole('cell').filter({hasText:'文案整体通过率'});
    assert.match(await allMobileOverall.textContent(),/0\.00%0 \/ 0 判定项次/u);
    assert.match(await allMobileReviewer.textContent(),/文案首检废弃率0\.00%0 \/ 0 条/u,'zero-denominator discard stays numeric while retaining its separate content denominator');
    const allMobileBounds=await allMobileOverall.boundingBox();
    assert.ok(allMobileBounds&&allMobileBounds.x>=0&&allMobileBounds.x+allMobileBounds.width<=391,'QA-only pass rate fits the default mobile card');
    const allMobileCountBounds=await allMobileOverall.locator('small').first().boundingBox();
    assert.ok(allMobileCountBounds&&allMobileCountBounds.x>=allMobileBounds.x&&allMobileCountBounds.x+allMobileCountBounds.width<=allMobileBounds.x+allMobileBounds.width+1,
      'QA-only pass count stays inside the default mobile card');
    await page.screenshot({path:join(screenshots,'all-mobile.png'),fullPage:true});
    await Promise.all([page.waitForResponse(response=>{
      const url=new URL(response.url());return url.pathname.endsWith('/admin/operator-performance')&&url.searchParams.get('activity')==='ALL'&&url.searchParams.get('sort')==='overallPassRate'&&url.searchParams.get('order')==='desc';
    }),chooseSelect(page,'账号排序','文案整体通过率最高')]);
    assert.match(await page.getByRole('row').first().textContent(),/标注甲/u,'default account list sorts by annotation overall pass rate');
    await page.getByRole('button',{name:'标注',exact:true}).click();
    await page.waitForFunction(()=>new URLSearchParams(location.search).get('activity')==='PRODUCTION');
    assert.equal(new URL(page.url()).searchParams.get('stage'),'COPY');
    assert.equal(await page.getByRole('region',{name:'账号统计表'}).locator('thead th').count(),6,'production view also shows annotation overall pass rate');
    assert.equal(await page.getByRole('row').filter({hasText:'质检同学'}).count(),0,'production view excludes QA-only accounts');
    assert.match(await page.getByRole('row').filter({hasText:'标注甲'}).textContent(),/文案整体通过率75\.00%3 \/ 4 判定项次/u);
    await page.getByRole('button',{name:'质检',exact:true}).click();
    await page.waitForFunction(()=>new URLSearchParams(location.search).get('activity')==='QA');
    assert.equal(new URL(page.url()).searchParams.has('stage'),false,'QA view still includes both stages by default');
    await page.getByRole('combobox',{name:'内容类型'}).click();
    assert.equal(await page.getByRole('option',{name:'文案和图片',exact:true}).count(),1,'QA retains the combined stage filter');
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'标注甲',exact:true}).waitFor({state:'detached'});
    assert.match(await page.getByRole('region',{name:'质检操作通过率'}).textContent(),/53\.33%通过 8 \/ 判定 15 项次/u);
    assert.equal(await page.getByRole('region',{name:'账号统计表'}).locator('thead th').count(),8,'QA account table adds overall pass rate alongside activity counts');
    assert.equal(await page.getByRole('region',{name:'账号统计表'}).evaluate(element=>element.scrollWidth<=element.clientWidth+1),true,'mobile QA cards need no horizontal scrolling');
    const reviewerRow=page.getByRole('row').filter({hasText:'质检同学'});
    assert.equal((await reviewerRow.getByRole('cell').nth(1).textContent()).trim(),'5');
    assert.equal((await reviewerRow.getByRole('cell').nth(2).textContent()).trim(),'3');
    assert.match(await reviewerRow.textContent(),/质检操作通过率53\.33%8 \/ 15 判定项次/u);
    const qaOverallMetric=reviewerRow.getByRole('cell').filter({hasText:'质检操作通过率'});
    const qaOverallBounds=await qaOverallMetric.boundingBox();
    assert.ok(qaOverallBounds&&qaOverallBounds.x>=0&&qaOverallBounds.x+qaOverallBounds.width<=391,'QA overall pass rate fits the mobile card');
    await Promise.all([page.waitForResponse(response=>{
      const url=new URL(response.url());return url.pathname.endsWith('/admin/operator-performance')&&url.searchParams.get('sort')==='overallPassRate'&&url.searchParams.get('order')==='desc';
    }),chooseSelect(page,'账号排序','质检操作通过率最高')]);
    assert.equal(new URL(page.url()).searchParams.get('sort'),'overallPassRate');
    await reviewerRow.getByRole('button',{name:'5',exact:true}).click();
    await page.getByRole('dialog').getByText('共 6 条事件。',{exact:false}).waitFor();
    await dialog.screenshot({path:join(screenshots,'detail-qa-mobile.png'),animations:'disabled'});
    assert.equal(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth+1),true,'the detail dialog fits the mobile viewport');
    const headingBefore=await dialog.getByRole('heading',{name:/质量与效率明细/}).boundingBox();
    await dialog.getByRole('tabpanel').evaluate(element=>{element.scrollTop=element.scrollHeight;});
    const headingAfter=await dialog.getByRole('heading',{name:/质量与效率明细/}).boundingBox();
    assert.ok(Math.abs(headingAfter.y-headingBefore.y)<1,'the dialog header stays in place while records scroll');
    assert.ok(await page.getByRole('button',{name:'关闭弹窗',exact:true}).isVisible());
    await page.setViewportSize({width:1440,height:1000});
    await dialog.getByRole('tabpanel').evaluate(element=>{element.scrollTop=0;});
    await dialog.screenshot({path:join(screenshots,'detail-qa-desktop.png'),animations:'disabled'});
    await chooseSelect(dialog,'明细范围','批量退回操作');
    await dialog.getByText(/波及退回 2 项次/u).waitFor();
    await page.keyboard.press('Escape');
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:join(screenshots,'qa-mobile.png'),fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
    assert.ok(root.startsWith(join(tmpdir(),'operator-performance-browser-')));await rm(root,{recursive:true,force:true,maxRetries:4,retryDelay:100});}
});
