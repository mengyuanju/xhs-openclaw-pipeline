import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp,readFile,rm,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizePersonalFilters,selectPersonalTasks,summarizePersonalWorkspace } from '../src/personal-workspace.mjs';
import { DEFAULT_HUMAN_QUALITY_SETTINGS } from '../src/human-quality-settings.mjs';

test('personal workspace browser: card drilldowns, URL restoration, history permission, refresh, delivery dialog and mobile',{
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
  let browser,server,failStatistics=false;
  const errors=[],requests=[];
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
          data={...summarizePersonalWorkspace(facts,events,[],normalizePersonalFilters(Object.fromEntries(url.searchParams))),notices:[]};
        } else if(url.pathname.endsWith('/personal-workspace/tasks')) {
          data=selectPersonalTasks(facts,events,normalizePersonalFilters(Object.fromEntries(url.searchParams)));
          data.items=data.items.map(item=>({...item,personalHistory:item.history}));data.updatedAt=new Date().toISOString();
        } else if(url.pathname.endsWith('/delivery-items')) data={items:[],total:0,summary:{total:0,unpacked:0,packed:0,delivered:0,updated:0},updatedAt:new Date().toISOString()};
        else if(url.pathname==='/api/human-quality-settings') data=DEFAULT_HUMAN_QUALITY_SETTINGS;
        else {res.statusCode=404;data=null;}
        res.setHeader('content-type','application/json');res.end(JSON.stringify({data}));return;
      }
      res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><body style="padding:24px"><main id="root"></main><script src="/bundle.js"></script></body></html>');
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`${base}/workbench/personal-statistics`);
    const rework=page.getByRole('link',{name:'待返修 2 项作业 · 含返修处理/确认',exact:true});await rework.waitFor();
    assert.equal(requests.some(url=>url.includes('/delivery-items')),false,'delivery history is lazy');
    await page.getByRole('img',{name:'每日文案与图片完成作业',exact:true}).waitFor();
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
    await page.goto(`${base}/workbench/personal-statistics`);await rework.waitFor();
    facts=facts.map(item=>item.id===2?{...item,state:'COPY_QC_PENDING',mandatoryCopyQc:true}:item);
    await page.evaluate(()=>window.dispatchEvent(new Event('xhs:workspace-updated')));
    await page.getByRole('link',{name:'待返修 1 项作业 · 含返修处理/确认',exact:true}).waitFor();
    failStatistics=true;await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByRole('alert').filter({hasText:'保留上次成功'}).waitFor();
    assert.ok(await page.getByRole('link',{name:'待返修 1 项作业 · 含返修处理/确认',exact:true}).isVisible());failStatistics=false;
    await page.setViewportSize({width:390,height:844});await page.goto(`${base}/workbench/personal-statistics`);
    await page.getByRole('link',{name:'待返修 1 项作业 · 含返修处理/确认',exact:true}).waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'mobile statistics should not overflow');
    if(process.env.PERSONAL_WORKSPACE_SCREENSHOTS)await page.screenshot({path:join(process.env.PERSONAL_WORKSPACE_SCREENSHOTS,'statistics-mobile.png'),fullPage:true});
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
    assert.deepEqual(errors,[]);
  } finally {
    await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
    assert.ok(root.startsWith(join(tmpdir(),'personal-workspace-browser-')));await rm(root,{recursive:true,force:true,maxRetries:4,retryDelay:100});
  }
});
