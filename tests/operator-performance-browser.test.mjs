import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp,readFile,rm,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { buildPerformanceSnapshot,normalizePerformanceFilters,performanceMetricRows,performancePeoplePage,performanceCsv } from '../src/operator-performance.mjs';

test('operator dashboard browser: denominators, drilldown, stale report, export, URL filters and mobile',{
  skip:process.env.RUN_OPERATOR_PERFORMANCE_BROWSER!=='1',timeout:120_000,
},async()=>{
  const {build}=await import('esbuild');const {chromium}=await import('playwright-core');
  const root=await mkdtemp(join(tmpdir(),'operator-performance-browser-'));
  const now=Date.now(),at=new Date(now-1000).toISOString(),token='11111111-1111-4111-8111-111111111111';
  const common={accountId:11,username:'worker-a',displayName:'作业员甲',stage:'COPY',at,query:'示例任务',exclusion:null};
  const rows=[...Array.from({length:10},(_,i)=>({...common,id:`s${i}`,taskId:i+1,kind:'SUBMIT'})),
    ...Array.from({length:4},(_,i)=>({...common,id:`q${i}`,taskId:i+1,kind:'QUALITY',first:true,sampleKind:'RANDOM',outcome:i===3?'RETURN':'PASS'}))];
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
        if(fail&&!url.pathname.endsWith('/export')){res.statusCode=503;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:{code:'TEST_DOWN',message:'统计服务暂不可用'}}));return;}
        if(url.pathname.endsWith('/export')){res.setHeader('Content-Type','text/csv');res.end(performanceCsv(snapshot));return;}
        const filters=normalizePerformanceFilters(input,now);let data;
        if(/\/tasks$/u.test(url.pathname)){
          const items=performanceMetricRows(snapshot.rows,filters.metric,filters.stage,filters.sampleSet);
          data={person:snapshot.people[0],asOf:at,range:snapshot.range,items:items.slice(0,15),total:items.length,page:1,pageSize:15,trend:snapshot.trend,current:[],timeline:[]};
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
    await page.goto(`${base}/workbench-statistics?period=7d`);
    await page.getByRole('button',{name:'作业员甲',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'近 7 天',exact:true}).getAttribute('aria-pressed'),'true');
    const person=page.getByRole('row').filter({hasText:'作业员甲'});
    assert.match(await person.textContent(),/75\.0%/u);assert.match(await person.textContent(),/3 \/ 4 已审/u);
    await person.getByRole('button',{name:/75\.0%/u}).click();
    const dialog=page.getByRole('dialog');await dialog.getByText('共 4 条事件。',{exact:false}).waitFor();
    await dialog.getByLabel('质检结论',{exact:true}).selectOption('failed');
    await dialog.getByText('共 1 条事件。',{exact:false}).waitFor();
    assert.equal(await dialog.getByText('退回',{exact:true}).count(),1);
    await page.keyboard.press('Escape');
    await Promise.all([page.waitForResponse(response=>response.url().includes('/export?')),
      page.getByRole('button',{name:'导出人员报表',exact:true}).click()]);
    assert.ok(requests.some(url=>url.includes(`/export?snapshotToken=${token}`)));
    fail=true;await page.getByRole('button',{name:'刷新统计',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'保留上次成功'}).waitFor();
    assert.ok(await page.getByRole('button',{name:'作业员甲',exact:true}).isVisible());
    fail=false;await page.getByRole('button',{name:'刷新统计',exact:true}).click();
    await page.getByRole('button',{name:'刷新统计',exact:true}).waitFor();
    await page.getByRole('textbox',{name:'作业人员',exact:true}).fill('作业员甲');await page.getByRole('button',{name:'应用筛选',exact:true}).click();
    await page.waitForFunction(()=>new URLSearchParams(location.search).get('query')==='作业员甲');
    await page.reload();await page.getByRole('button',{name:'作业员甲',exact:true}).waitFor();
    assert.equal(await page.getByRole('textbox',{name:'作业人员',exact:true}).inputValue(),'作业员甲');
    const screenshots=resolve('.codex_artifacts/operator-performance');await mkdir(screenshots,{recursive:true});
    await page.locator('canvas').nth(1).waitFor();
    await page.screenshot({path:join(screenshots,'desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:join(screenshots,'mobile.png'),fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'mobile page stays inside viewport; only the table scrolls');
    await page.getByRole('button',{name:'作业员甲',exact:true}).click();await page.getByRole('dialog').getByText('共 14 条事件。',{exact:false}).waitFor();
    assert.ok(await page.getByRole('button',{name:'关闭弹窗',exact:true}).isVisible());
    await page.screenshot({path:join(screenshots,'detail-mobile.png'),fullPage:true});
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
    assert.ok(root.startsWith(join(tmpdir(),'operator-performance-browser-')));await rm(root,{recursive:true,force:true,maxRetries:4,retryDelay:100});}
});
