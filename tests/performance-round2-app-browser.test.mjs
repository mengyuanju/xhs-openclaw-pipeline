import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';

test('round2 app browser: unchanged metadata avoids history reads, real result unlocks the editor, scoped updates and thumbnail fallback work', {
  skip:process.env.RUN_PERFORMANCE_APP_BROWSER !== '1',timeout:80_000,
},async()=>{
  const {build}=await import('esbuild'),{chromium}=await import('playwright-core');
  const root=await mkdtemp(join(tmpdir(),'performance-round2-app-browser-'));
  const editId=randomUUID(),runId=randomUUID(),requests=[],pageErrors=[],unexpected=[],steps=[];
  const staleGate=Promise.withResolvers(),staleCaptured=Promise.withResolvers();let firstState=true;
  const png=await sharp({create:{width:1086,height:1448,channels:4,background:'#c8ddca'}}).png().toBuffer();
  let row={id:editId,task_id:201,target_page:1,source_asset_id:101,version:1,attempts:1,status:'RUNNING',operation:'SVG_DISCLOSURE',
    created_by:'fixture',created_by_account_id:1,error:null,config:{instruction:'程序标识测试',overlay:{text:'程序标识测试',badgeVariant:'solid-pill',badgeColor:'#111827'}}};
  let browser,server;
  try{
    await build({stdin:{contents:`import './app/globals.css';import React,{useState}from'react';import{createRoot}from'react-dom/client';
      import{ConfirmDialogProvider}from'./components/ui/confirm-dialog';import{Toaster}from'./components/ui/sonner';
      import{BackgroundTasksProvider,BackgroundTaskNotifications}from'./app/components/background-tasks';
      import{StandaloneImageEditor}from'./app/components/standalone-image-editor';import{AssetThumbnail}from'./app/components/asset-thumbnail';
      import{readImageEditState}from'./app/components/image-edit-state';void readImageEditState({taskId:201,standalone:true}).catch(()=>{});
      import{notifyWorkspaceUpdated}from'./app/components/workspace-updates';window.fixtureNotify=notifyWorkspaceUpdated;
      const asset={id:101,sha256:'a'.repeat(64),url:'/v1/image-editor/assets/101'};
      function App(){const[small,setSmall]=useState(99),[open,setOpen]=useState(false);return <><BackgroundTaskNotifications/><div>
        <AssetThumbnail id="small" src={'/api/control-plane/v1/assets/'+small} alt="导航缩略图" width="100" height="133"/>
        <img id="main" src="/api/control-plane/v1/assets/99" alt="原图质量判断" width="100" height="133"/>
        <button onClick={()=>setSmall(100)}>切换小图</button><button onClick={()=>setOpen(true)}>打开运行中的编辑器</button></div>
        {open&&<StandaloneImageEditor taskId={201} runId="${runId}" copyRevisionId={1} asset={asset} page={1} runs={[]}
          initialStatus="RUNNING" onChanged={async()=>{}} onSubmitted={()=>{}} onBusyChange={()=>{}} onRunningChange={()=>{}}/>}</>}
      createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><BackgroundTasksProvider accountKey="round2-browser" accountUsername="fixture" accountId={1}><App/></BackgroundTasksProvider><Toaster/></ConfirmDialogProvider>);`,
      resolveDir:process.cwd(),loader:'tsx'},bundle:true,outfile:join(root,'bundle.js'),jsx:'automatic',platform:'browser',conditions:['style'],alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"test"'}});
    const [js,rawCss]=await Promise.all([readFile(join(root,'bundle.js')),readFile(join(root,'bundle.css'),'utf8')]);
    const {default:postcss}=await import('postcss'),{default:tailwind}=await import('@tailwindcss/postcss');
    const {css}=await postcss([tailwind()]).process(rawCss,{from:join(process.cwd(),'app/globals.css')});
    server=createServer(async(req,res)=>{
      const url=new URL(req.url,'http://fixture');
      if(url.pathname==='/bundle.js'){res.setHeader('content-type','application/javascript');res.end(js);return;}
      if(url.pathname==='/bundle.css'){res.setHeader('content-type','text/css');res.end(css);return;}
      if(url.pathname.startsWith('/api/')){
        requests.push({method:req.method,path:url.pathname,query:url.search});
        if(url.pathname.includes('/assets/')){
          if(url.pathname.endsWith('/99')&&url.searchParams.get('variant')==='thumbnail'){res.statusCode=503;res.end('expected thumbnail failure');return;}
          res.setHeader('content-type','image/png');res.end(png);return;
        }
        let data;
        if(req.method!=='GET'){unexpected.push({method:req.method,path:url.pathname});res.statusCode=405;}
        else if(url.pathname==='/api/control-plane/v1/image-editor/workspaces/201/image-edits/state'){
          const receipt=firstState?{...row,status:'QUEUED'}:row;
          if(firstState){firstState=false;staleCaptured.resolve();await staleGate.promise;}
          const {id,task_id,target_page,status,version,error,created_by,created_by_account_id}=receipt;
          data={status,signature:JSON.stringify([[id,version,status,error]]),items:[{id,task_id,target_page,status,version,error,created_by,created_by_account_id}]};
        }else if(url.pathname==='/api/control-plane/v1/image-editor/workspaces/201/image-edits')data=[row];
        else{unexpected.push({method:req.method,path:url.pathname});res.statusCode=404;}
        res.setHeader('content-type','application/json');res.end(JSON.stringify({data}));return;
      }
      res.setHeader('content-type','text/html');res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/bundle.css"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
    });
    await new Promise(done=>server.listen(0,'127.0.0.1',done));
    browser=await chromium.launch({headless:true,channel:process.env.IMAGE_EDIT_BROWSER_CHANNEL??'msedge'});
    const page=await browser.newPage({viewport:{width:1440,height:1080}});
    page.on('pageerror',error=>pageErrors.push(error.message));
    const counts=()=>({state:requests.filter(r=>r.path.endsWith('/image-edits/state')).length,history:requests.filter(r=>r.path.endsWith('/image-edits')).length});
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await staleCaptured.promise;
    await page.getByRole('button',{name:'打开运行中的编辑器',exact:true}).click();
    await page.getByRole('region',{name:'图片编辑组件',exact:true}).waitFor();
    assert.equal(await page.getByLabel('人工生成标识文字',{exact:true}).isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'保存并提交生图',exact:true}).isDisabled(),true);
    staleGate.resolve();
    await page.getByRole('button',{name:'后台任务，1 项处理中，0 条未读提醒',exact:true}).waitFor();
    assert.equal(await page.getByLabel('人工生成标识文字',{exact:true}).isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'保存并提交生图',exact:true}).isDisabled(),true,'stale queued flight cannot unlock a running workspace');
    assert.equal(counts().history,1);
    await page.waitForFunction(()=>document.querySelector('#small')?.getAttribute('src')==='/api/control-plane/v1/assets/99'&&document.querySelector('#small').naturalWidth>0);
    assert.equal(await page.locator('#main').getAttribute('src'),'/api/control-plane/v1/assets/99');
    await page.getByRole('button',{name:'切换小图',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#small')?.getAttribute('src')==='/api/control-plane/v1/assets/100?variant=thumbnail'&&document.querySelector('#small').naturalWidth>0);
    steps.push({name:'RUNNING is read-only; failed thumbnail falls back; a new source retries its thumbnail',counts:counts()});
    await page.waitForResponse(response=>response.url().includes('/image-edits/state')&&response.request().method()==='GET');
    const unchanged=counts();assert.equal(unchanged.history,1);assert.ok(unchanged.state>=3);
    await page.evaluate(()=>window.fixtureNotify({scopes:['image-editor'],taskIds:[202]}));
    await page.waitForTimeout(650);assert.deepEqual(counts(),unchanged,'unrelated task events do not reload this editor');
    steps.push({name:'unchanged running state polls compact metadata; unrelated workspace does not refresh',counts:counts()});
    row={...row,status:'PREVIEW_READY',version:2,result:{asset_id:102,image_run_id:randomUUID(),validation:{passed:true}}};
    await page.evaluate(()=>window.fixtureNotify({scopes:['image-editor'],taskIds:[201]}));
    await page.waitForFunction(()=>!document.querySelector('input[aria-label="人工生成标识文字"]')?.disabled);
    await page.getByRole('button',{name:'后台任务，0 项处理中，1 条未读提醒',exact:true}).waitFor();
    assert.equal(await page.getByLabel('人工生成标识文字',{exact:true}).isDisabled(),false);
    await page.getByRole('tab',{name:/编辑记录/u}).click();
    await page.getByText('程序生成标识 · 预览待确认',{exact:true}).waitFor();
    assert.equal(counts().history,2,'a changed version loads complete result exactly once');
    await page.waitForTimeout(600);assert.equal(await page.locator('[data-sonner-toast]').count(),1,'completion produces one notification');
    steps.push({name:'changed result loads history once, unlocks editor and produces one completion toast',counts:counts()});
    await mkdir('reports',{recursive:true});
    await page.screenshot({path:resolve('reports/performance-round2-app-browser.png'),fullPage:true});
    assert.deepEqual(pageErrors,[]);assert.deepEqual(unexpected,[]);
    await writeFile('reports/performance-round2-app-browser.json',JSON.stringify({passed:true,steps,pageErrors,unexpected,requests,modelsCalled:0,businessDatabaseWrites:0},null,2));
  }finally{
    staleGate.resolve();
    await browser?.close();if(server)await new Promise(done=>server.close(done));
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`)&&root.includes('performance-round2-app-browser-'));
    await rm(root,{recursive:true,force:true});
  }
});

test('round2 legacy center browser: a tracked standalone edit outside history still recovers its completion through the old authenticated edit API',{
  skip:process.env.RUN_PERFORMANCE_APP_BROWSER!=='1',timeout:40_000,
},async()=>{
  const {build}=await import('esbuild'),{chromium}=await import('playwright-core');
  const root=await mkdtemp(join(tmpdir(),'performance-round2-app-legacy-')),id=randomUUID(),requests=[],errors=[];
  let browser,server;
  try{
    await build({stdin:{contents:`import React from'react';import{createRoot}from'react-dom/client';import{BackgroundTasksProvider,BackgroundTaskNotifications}from'./app/components/background-tasks';import{Toaster}from'./components/ui/sonner';createRoot(document.getElementById('root')).render(<BackgroundTasksProvider accountKey="legacy-state" accountUsername="fixture" accountId={1}><BackgroundTaskNotifications/><Toaster/></BackgroundTasksProvider>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,outfile:join(root,'bundle.js'),jsx:'automatic',platform:'browser',alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"test"'}});
    const bundle=await readFile(join(root,'bundle.js'));
    server=createServer((req,res)=>{
      const url=new URL(req.url,'http://fixture');
      if(url.pathname==='/bundle.js'){res.setHeader('content-type','application/javascript');res.end(bundle);return;}
      if(url.pathname.startsWith('/api/')){
        requests.push(url.pathname);let data;
        if(url.pathname.endsWith('/image-edits/state')){res.statusCode=404;data=null;}
        else if(url.pathname.endsWith('/image-edits'))data=[];
        else if(url.pathname===`/api/control-plane/v1/image-editor/edits/${id}`)data={id,task_id:9999,status:'PREVIEW_READY',target_page:1,version:2,created_by:'fixture',created_by_account_id:1};
        else if(url.pathname==='/api/control-plane/v1/image-editor/workspaces/9999')data={status:'PREVIEW_READY'};
        else{res.statusCode=500;data=null;}
        res.setHeader('content-type','application/json');res.end(JSON.stringify({data}));return;
      }
      res.setHeader('content-type','text/html');res.end('<!doctype html><html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script></html>');
    });
    await new Promise(done=>server.listen(0,'127.0.0.1',done));
    browser=await chromium.launch({headless:true,channel:process.env.IMAGE_EDIT_BROWSER_CHANNEL??'msedge'});
    const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(id=>localStorage.setItem('xhs:background-tasks:v1:legacy-state',JSON.stringify([{id,kind:'STANDALONE_IMAGE_EDIT',taskId:9999,page:1,status:'RUNNING',createdAt:Date.now(),read:false,ownerUsername:'fixture',ownerAccountId:1}])),id);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button',{name:'后台任务，0 项处理中，1 条未读提醒',exact:true}).waitFor();
    assert.equal(requests.filter(path=>path.endsWith('/image-edits')).length,1,'fallback uses one shared full history read');
    assert.equal(requests.filter(path=>path===`/api/control-plane/v1/image-editor/edits/${id}`).length,1,'only the missing tracked row is recovered');
    const cached=await page.evaluate(()=>JSON.parse(localStorage.getItem('xhs:background-tasks:v1:legacy-state')));
    assert.equal(cached[0].status,'PREVIEW_READY');assert.equal(cached[0].ownerAccountId,1);assert.deepEqual(errors,[]);
    await writeFile('reports/performance-round2-app-legacy-browser.json',JSON.stringify({passed:true,requests,errors,modelsCalled:0,businessDatabaseWrites:0},null,2));
  }finally{
    await browser?.close();if(server)await new Promise(done=>server.close(done));
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`)&&root.includes('performance-round2-app-legacy-'));
    await rm(root,{recursive:true,force:true});
  }
});
