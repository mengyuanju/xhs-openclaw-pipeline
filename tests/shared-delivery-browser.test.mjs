import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp,readFile,rm,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('shared delivery browser: common state, date filters, confirmation, aggregate selection, history and mobile',{
  skip:process.env.RUN_SHARED_DELIVERY_BROWSER!=='1',timeout:90_000,
},async()=>{
  const {build}=await import('esbuild'),{chromium}=await import('playwright-core');
  const root=await mkdtemp(join(tmpdir(),'shared-delivery-browser-'));
  let browser,server;const errors=[],requests=[],jobs=[];
  const now=new Date().toISOString();
  let rows=Array.from({length:25},(_,i)=>({itemId:i+1,entryId:i+1,taskId:i+1,query:`交付内容 ${i+1}`,copyRevisionId:i+100,imageRunId:'22345678-1234-4234-8234-123456789abc',
    packageName:'九月内容',clientBatchCode:'batch',assigneeUsername:'worker',ownerUsername:'worker',batchCode:'JF-12345678',
    state:i<2?'PACKED':'DELIVERED',packedAt:now,packedBy:'admin',deliveredAt:i<2?null:now,deliveredBy:i<2?null:'worker',readyAt:now,updatedAt:now,archivedAt:null,
    canConfirm:i<2,downloadedByMe:true,isCurrent:true,versionUpdated:false,batchVisibleCount:25,batchDeliveredCount:23}));
  try {
    await build({stdin:{contents:`import './app/globals.css';import React from 'react';import{createRoot}from'react-dom/client';
      import{ConfirmDialogProvider}from'./components/ui/confirm-dialog';
      import{SharedDeliveryWorkbench}from'./app/delivery-pool/shared-delivery-workbench';
      createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><SharedDeliveryWorkbench role={location.pathname.includes('operator')?'USER':'ADMIN'}/></ConfirmDialogProvider>);`,
      resolveDir:process.cwd(),loader:'tsx'},bundle:true,outfile:join(root,'bundle.js'),jsx:'automatic',platform:'browser',conditions:['style'],alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"test"'}});
    const [js,rawCss]=await Promise.all([readFile(join(root,'bundle.js')),readFile(join(root,'bundle.css'),'utf8')]);
    const {default:postcss}=await import('postcss'),{default:tailwind}=await import('@tailwindcss/postcss');
    const {css}=await postcss([tailwind()]).process(rawCss,{from:join(process.cwd(),'app/globals.css')});
    server=createServer(async(req,res)=>{
      if(req.url==='/bundle.js'){res.setHeader('content-type','application/javascript');res.end(js);return;}
      if(req.url==='/bundle.css'){res.setHeader('content-type','text/css');res.end(css);return;}
      if(req.url.startsWith('/api/')){
        let raw='';for await(const chunk of req)raw+=chunk;const input=raw?JSON.parse(raw):null;
        const url=new URL(req.url,'http://localhost');requests.push({url:req.url,input,method:req.method});let data;
        if(url.pathname.endsWith('/delivery-items')){
          const state=url.searchParams.get('state'),search=url.searchParams.get('search'),offset=Number(url.searchParams.get('offset')),limit=Number(url.searchParams.get('limit'));
          let filtered=rows.filter(row=>!search||row.query.includes(search));
          const summary={total:filtered.length,unpacked:0,packed:filtered.filter(row=>row.state==='PACKED').length,delivered:filtered.filter(row=>row.state==='DELIVERED').length,updated:0};
          filtered=filtered.filter(row=>state==='ALL'||(state==='PENDING'?row.state!=='DELIVERED':row.state===state));
          data={items:filtered.slice(offset,offset+limit),total:filtered.length,summary,updatedAt:new Date().toISOString()};
        }else if(url.pathname.endsWith('/users'))data=[{id:1,username:'admin'},{id:2,username:'worker'}];
        else if(url.pathname.endsWith('/delivery-items/confirm')){
          rows=rows.map(row=>input.itemIds.includes(row.itemId)?{...row,state:'DELIVERED',deliveredBy:'admin',deliveredAt:new Date().toISOString(),canConfirm:false}:row);
          data={confirmed:input.itemIds.length,alreadyConfirmed:0};
        }else if(url.pathname.endsWith('/delivery-archives/preview'))data={token:'preview',itemCount:input.filters?rows.filter(row=>row.state==='DELIVERED').length:input.itemIds.length,totalBytes:10000,batchCount:1};
        else if(url.pathname.endsWith('/delivery-archives')){
          if(req.method==='POST'){jobs.push({id:jobs.length+1,kind:'ARCHIVE',status:'SUCCEEDED',itemCount:25,createdBy:'admin',createdAt:now,artifacts:[{part:1,fileName:'saved.zip',byteSize:10000}]});data=jobs.at(-1);}
          else data={items:jobs,total:jobs.length};
        }else {res.statusCode=404;data=null;}
        res.setHeader('content-type','application/json');res.end(JSON.stringify({data}));return;
      }
      res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><body style="padding:20px"><main id="root"></main><script src="/bundle.js"></script></body></html>');
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'msedge'});
    const admin=await browser.newPage({viewport:{width:1480,height:1100}}),operator=await browser.newPage({viewport:{width:1280,height:950}});
    for(const page of [admin,operator])page.on('pageerror',error=>errors.push(error.message));
    await admin.goto(`${base}/delivery-pool`);await operator.goto(`${base}/operator`);
    await admin.getByRole('checkbox',{name:'选择交付任务 1',exact:true}).waitFor();
    await operator.locator('tbody').getByText('已打包，待交付',{exact:true}).first().waitFor();
    await admin.getByRole('checkbox',{name:'选择交付任务 1',exact:true}).check();
    await admin.getByRole('button',{name:'确认所选已交付',exact:true}).click();
    await admin.getByRole('alertdialog').getByRole('button',{name:'确认已交付',exact:true}).click();
    await admin.getByRole('status').filter({hasText:'已确认 1 条'}).waitFor();
    await operator.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await operator.waitForFunction(()=>Array.from(document.querySelectorAll('tbody tr')).find(row=>row.textContent.includes('#1 交付内容 1'))?.querySelector('[data-label="交付信息"]')?.textContent.includes('admin'));
    assert.equal(requests.filter(req=>req.url.endsWith('/delivery-items/confirm')).length,1);
    await admin.getByRole('combobox',{name:'交付状态',exact:true}).click();await admin.getByRole('option',{name:'已交付',exact:true}).click();
    await admin.getByRole('combobox',{name:'日期依据',exact:true}).click();await admin.getByRole('option',{name:'交付确认时间',exact:true}).click();
    await admin.getByLabel('交付开始日期',{exact:true}).fill('2026-09-18');await admin.getByLabel('交付结束日期',{exact:true}).fill('2026-09-18');
    await Promise.all([admin.waitForResponse(response=>response.url().includes('state=DELIVERED')&&response.url().includes('from=2026-09-18')),
      admin.getByRole('button',{name:'查询',exact:true}).click()]);
    await admin.reload();await admin.getByRole('button',{name:'选择全部筛选结果（24 条）',exact:true}).waitFor();
    assert.equal(await admin.getByLabel('交付开始日期',{exact:true}).inputValue(),'2026-09-18');
    await admin.getByRole('button',{name:'选择全部筛选结果（24 条）',exact:true}).click();
    await admin.getByRole('button',{name:'汇总保存已交付内容',exact:true}).click();
    await admin.getByRole('alertdialog').getByRole('button',{name:'生成文件',exact:true}).click();
    await admin.getByRole('link',{name:'下载第 1 卷',exact:true}).waitFor();
    const previewRequest=requests.find(req=>req.url.endsWith('/delivery-archives/preview'));
    assert.equal(previewRequest.input.filters.state,'DELIVERED');assert.equal(previewRequest.input.itemIds,undefined,'all-filter selection is server-side rather than loaded-page IDs');
    assert.equal(await operator.getByRole('button',{name:'汇总保存已交付内容',exact:true}).count(),0);
    await admin.getByRole('button',{name:'交付记录（含历史版本）',exact:true}).click();
    await admin.waitForFunction(()=>new URLSearchParams(location.search).get('dl_view')==='HISTORY');
    if(process.env.SHARED_DELIVERY_SCREENSHOTS){await mkdir(process.env.SHARED_DELIVERY_SCREENSHOTS,{recursive:true});await admin.screenshot({path:join(process.env.SHARED_DELIVERY_SCREENSHOTS,'delivery-desktop.png'),fullPage:true});}
    await admin.setViewportSize({width:390,height:844});
    assert.ok(await admin.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'mobile delivery page must fit the viewport');
    if(process.env.SHARED_DELIVERY_SCREENSHOTS){await admin.evaluate(()=>window.scrollTo(0,0));await admin.screenshot({path:join(process.env.SHARED_DELIVERY_SCREENSHOTS,'delivery-mobile.png'),fullPage:false});}
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
    assert.ok(root.startsWith(join(tmpdir(),'shared-delivery-browser-')));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
