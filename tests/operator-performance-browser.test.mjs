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
  const now=Date.now(),at=new Date(now-1000).toISOString(),token='11111111-1111-4111-8111-111111111111';
  const common={accountId:11,username:'worker-a',displayName:'标注甲',stage:'COPY',at,query:'示例任务',exclusion:null};
  const rows=[...Array.from({length:10},(_,i)=>({...common,id:`s${i}`,taskId:i+1,kind:'SUBMIT',firstSubmission:true})),
    ...Array.from({length:4},(_,i)=>({...common,id:`q${i}`,taskId:i+1,kind:'QUALITY',first:true,sampleKind:'RANDOM',outcome:i===3?'RETURN':'PASS'})),
    ...Array.from({length:2},(_,i)=>({...common,id:`image-q${i}`,taskId:i+9,stage:'IMAGE',kind:'QUALITY',first:true,sampleKind:'RANDOM',outcome:i===0?'PASS':'RETURN'})),
    ...['FIRST_PASS','FIRST_PASS','RETURNED','DISCARDED','FIRST_PASS','RETURNED'].map((bucket,i)=>({...common,id:`account-quality:${i}`,taskId:i+1,stage:i<4?'COPY':'IMAGE',kind:'ACCOUNT_QUALITY',bucket}))];
  rows.push(...Array.from({length:8},(_,i)=>({...common,id:`review:${i}`,taskId:i+1,samplingItemId:i+1,accountId:22,username:'qa-only',displayName:'质检同学',stage:i<5?'COPY':'IMAGE',kind:'QA_REVIEW',sampleKind:'RANDOM',outcome:[1,6].includes(i)?'RETURN':'PASS'})));
  rows.push(...[2,7].map((taskId,i)=>({...common,id:`review:recheck:${i}`,taskId,samplingItemId:i+9,accountId:22,username:'qa-only',displayName:'质检同学',stage:i===0?'COPY':'IMAGE',kind:'QA_REVIEW',sampleKind:'MANDATORY_RECHECK',outcome:'PASS'})));
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
    const overall=page.getByRole('region',{name:'整体通过率'});
    await overall.getByText('80.00%',{exact:true}).waitFor();
    assert.match(await overall.textContent(),/8 \/ 10 次质检结论通过/u,'team pass rate counts initial and recheck decisions by QA operators');
    assert.match(await overall.textContent(),/文案83\.33%5 \/ 6 次/u);
    assert.match(await overall.textContent(),/图片75\.00%3 \/ 4 次/u);
    assert.equal(await page.getByRole('note').count(),0,'explanations start collapsed');
    await overall.getByRole('button',{name:'通过率口径',exact:true}).click();
    await page.getByRole('note').getByText(/返修/u).waitFor();
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
    assert.match(await page.getByRole('region',{name:'整体通过率'}).textContent(),/当前范围暂无逐项通过或退回结论/u,'producer quality outcomes are not credited to a QA account');
    await page.screenshot({path:join(screenshots,'overview-desktop.png'),fullPage:true});
    await page.getByRole('button',{name:'账号数据',exact:true}).click();
    assert.match(await page.getByRole('combobox',{name:'人员'}).textContent(),/标注甲（worker-a）/u,'person scope survives the view switch');
    await chooseSelect(page,'人员','全部人员');
    await Promise.all([page.waitForResponse(response=>!response.url().includes('accountId=11')&&response.url().includes('activity=PRODUCTION')),
      page.getByRole('button',{name:'应用筛选',exact:true}).click()]);
    await page.getByRole('button',{name:'标注甲',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'近 7 天',exact:true}).getAttribute('aria-pressed'),'true');
    assert.equal(await page.getByRole('columnheader').count(),5,'production account table keeps its four content outcome metrics');
    const person=page.getByRole('row').filter({hasText:'标注甲'});
    assert.match(await person.textContent(),/6条内容判定/u);
    assert.match(await person.textContent(),/一次通过率50\.00%3 \/ 6 条/u);
    assert.doesNotMatch(await person.textContent(),/整体通过率/u);
    assert.match(await person.textContent(),/打回率33\.33%2 \/ 6 条/u);
    assert.match(await person.textContent(),/废弃率16\.67%1 \/ 6 条/u);
    assert.equal(await page.getByRole('note').count(),0,'account methodology stays hidden until requested');
    await page.getByRole('region',{name:'账号数据'}).getByRole('button',{name:'指标说明'}).click();
    await page.getByRole('note').getByText(/三类互斥且合计 100%/u).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('note').count(),0);
    await person.getByRole('button',{name:/标注甲一次通过率 50\.00%/u}).click();
    const dialog=page.getByRole('dialog');await dialog.getByText('共 3 条事件。',{exact:false}).waitFor();
    await assertFilterLabelsSingleLine(dialog);
    await dialog.getByRole('combobox',{name:'明细范围'}).click();
    const longOption=page.getByRole('option',{name:'首次返修复检',exact:true});
    assert.ok((await longOption.boundingBox()).height<45,'long dropdown values stay on one line');
    await page.keyboard.press('Escape');
    assert.equal(await dialog.getByRole('tab',{name:'操作明细',exact:true}).getAttribute('aria-selected'),'true');
    assert.match(await dialog.getByRole('combobox',{name:'明细范围'}).textContent(),/一次通过/u);
    await chooseSelect(dialog,'明细范围','首轮质检');
    await dialog.getByText('共 6 条事件。',{exact:false}).waitFor();
    await chooseSelect(dialog,'明细阶段','图片');
    await dialog.getByText('共 2 条事件。',{exact:false}).waitFor();
    await chooseSelect(dialog,'质检结论','退回样本');
    await dialog.getByText('共 1 条事件。',{exact:false}).waitFor();
    assert.ok(requests.some(url=>url.includes('/11/tasks?')&&url.includes('metric=firstPass')&&url.includes('stage=IMAGE')&&url.includes('sampleSet=failed')));
    await chooseSelect(dialog,'明细阶段','全部阶段');
    await dialog.getByText('共 2 条事件。',{exact:false}).waitFor();
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
    await page.getByRole('row').filter({hasText:'标注甲'}).getByRole('button',{name:/一次通过率 50\.00%/u}).waitFor();
    assert.equal(await page.getByRole('region',{name:'整体通过率'}).count(),0,'production account view does not show a QA operation rate');
    await chooseSelect(page,'内容类型','文案和图片');
    await page.getByRole('button',{name:'应用筛选',exact:true}).click();
    await page.waitForFunction(()=>!new URLSearchParams(location.search).has('stage'));
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
    for(const [label,rate] of [['一次通过率','50.00%'],['打回率','33.33%'],['废弃率','16.67%']]){
      const metric=mobilePerson.getByRole('button',{name:new RegExp(`标注甲${label} ${rate.replace('.','\\.')}`,'u')});
      const bounds=await metric.boundingBox();
      assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=391,`${label} is fully inside the mobile viewport`);
    }
    assert.equal(await mobilePerson.getByRole('cell').filter({hasText:'整体通过率'}).count(),0,'production card has no QA pass rate');
    assert.match(await page.getByRole('combobox',{name:'账号排序'}).textContent(),/已判定最多/u);
    await Promise.all([page.waitForResponse(response=>{
      const url=new URL(response.url());return url.pathname.endsWith('/admin/operator-performance')&&url.searchParams.get('sort')==='firstPassRate'&&url.searchParams.get('order')==='desc';
    }),chooseSelect(page,'账号排序','一次通过率最高')]);
    assert.equal(new URL(page.url()).searchParams.get('sort'),'firstPassRate');
    assert.match(await page.getByRole('combobox',{name:'账号排序'}).textContent(),/一次通过率最高/u);
    await page.getByRole('button',{name:'标注甲',exact:true}).click();await page.getByRole('dialog').getByText('共 6 条事件。',{exact:false}).waitFor();
    await assertFilterLabelsSingleLine(dialog);
    assert.ok(await page.getByRole('button',{name:'关闭弹窗',exact:true}).isVisible());
    await dialog.screenshot({path:join(screenshots,'detail-mobile.png'),animations:'disabled'});
    await page.keyboard.press('Escape');
    await page.getByRole('textbox',{name:'账号',exact:true}).fill('');await page.getByRole('button',{name:'应用筛选',exact:true}).click();
    await page.getByRole('button',{name:'质检',exact:true}).click();
    await page.waitForFunction(()=>new URLSearchParams(location.search).get('activity')==='QA');
    await page.getByRole('button',{name:'标注甲',exact:true}).waitFor({state:'detached'});
    assert.match(await page.getByRole('region',{name:'整体通过率'}).textContent(),/80\.00%8 \/ 10 次质检结论通过/u);
    assert.equal(await page.getByRole('region',{name:'账号统计表'}).locator('thead th').count(),8,'QA account table adds overall pass rate alongside activity counts');
    assert.equal(await page.getByRole('region',{name:'账号统计表'}).evaluate(element=>element.scrollWidth<=element.clientWidth+1),true,'mobile QA cards need no horizontal scrolling');
    const reviewerRow=page.getByRole('row').filter({hasText:'质检同学'});
    assert.equal((await reviewerRow.getByRole('cell').nth(1).textContent()).trim(),'5');
    assert.equal((await reviewerRow.getByRole('cell').nth(2).textContent()).trim(),'3');
    assert.match(await reviewerRow.textContent(),/整体通过率80\.00%8 \/ 10 次质检结论/u);
    const qaOverallMetric=reviewerRow.getByRole('cell').filter({hasText:'整体通过率'});
    const qaOverallBounds=await qaOverallMetric.boundingBox();
    assert.ok(qaOverallBounds&&qaOverallBounds.x>=0&&qaOverallBounds.x+qaOverallBounds.width<=391,'QA overall pass rate fits the mobile card');
    await Promise.all([page.waitForResponse(response=>{
      const url=new URL(response.url());return url.pathname.endsWith('/admin/operator-performance')&&url.searchParams.get('sort')==='overallPassRate'&&url.searchParams.get('order')==='desc';
    }),chooseSelect(page,'账号排序','整体通过率最高')]);
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
    await page.keyboard.press('Escape');
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:join(screenshots,'qa-mobile.png'),fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
    assert.ok(root.startsWith(join(tmpdir(),'operator-performance-browser-')));await rm(root,{recursive:true,force:true,maxRetries:4,retryDelay:100});}
});
