import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { decodeReference } from '../src/image-edit-pixels.mjs';

test('independent image editor browser: list, inline upload dialog, save-to-queue, status, download and mobile',
 {skip:process.env.RUN_IMAGE_EDIT_BROWSER!=='1',timeout:90000},async()=>{
  const {build}=await import('esbuild'),{chromium}=await import('playwright-core');
  const root=await mkdtemp(join(tmpdir(),'standalone-editor-browser-'));
  const png=await sharp({create:{width:1086,height:1448,channels:4,background:'#e6f0ec'}}).png().toBuffer();
  const workspace={id:501,title:'独立上传图片',runId:randomUUID(),copyRevisionId:91,
    assets:[{id:601,sha256:'a'.repeat(64),url:'/v1/image-editor/assets/601'}],runs:[]};
  let server,browser,uploaded=false,edits=[],submitted,submissionCount=0,failSubmission=false,extraRows=[],batchSubmissions=0,batchPayload,acceptedBatchPayload,individualAcceptCalls=0;
  const deleted=new Set(),deletions=[];
  try {
    await build({stdin:{contents:`import './app/globals.css';import React from 'react';import{createRoot}from'react-dom/client';import{ConfirmDialogProvider}from'./components/ui/confirm-dialog';import{ImageEditorWorkbench}from'./app/image-editor/workbench';import{BackgroundTasksProvider,BackgroundTaskNotifications}from'./app/components/background-tasks';import{Toaster}from'./components/ui/sonner';createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><BackgroundTasksProvider accountKey="browser-test" accountUsername="本人" accountId={8}><ImageEditorWorkbench/><BackgroundTaskNotifications/><Toaster/></BackgroundTasksProvider></ConfirmDialogProvider>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,outfile:join(root,'bundle.js'),jsx:'automatic',platform:'browser',conditions:['style'],alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"test"','process.env':'{}'}});
    const [js,rawCss]=await Promise.all([readFile(join(root,'bundle.js')),readFile(join(root,'bundle.css'),'utf8')]);
    const {default:postcss}=await import('postcss'),{default:tailwind}=await import('@tailwindcss/postcss');
    const {css}=await postcss([tailwind()]).process(rawCss,{from:join(process.cwd(),'app/globals.css')});
    server=createServer(async(req,res)=>{
      if(req.url==='/bundle.js'){res.setHeader('content-type','application/javascript');res.end(js);return;}
      if(req.url==='/bundle.css'){res.setHeader('content-type','text/css');res.end(css);return;}
      if(req.url?.startsWith('/api/control-plane/')) {
        const path=new URL(req.url,'http://localhost').pathname.replace('/api/control-plane','');
        let chunks=[];for await(const chunk of req)chunks.push(chunk);const data=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
        if(path.startsWith('/v1/image-editor/assets/')){res.setHeader('content-type','image/png');if(req.url.includes('download=true'))res.setHeader('content-disposition','attachment; filename="edited.png"');res.end(png);return;}
        let result;
        if(path==='/v1/image-editor/workspaces/delete'){deletions.push(data.workspaceIds);for(const id of data.workspaceIds)deleted.add(id);result={deletedIds:data.workspaceIds};}
        else if(path==='/v1/image-editor/workspaces'&&req.method==='POST'){uploaded=true;deleted.delete(workspace.id);assert.equal(data.images.length,workspace.assets.length);result={...workspace,status:'UPLOADED'};}
        else if(path==='/v1/image-editor/workspaces'){assert.equal(new URL(req.url,'http://localhost').searchParams.get('queue'),'true');const items=[...(edits.length?[{id:501,title:workspace.title,owner:'本人',status:edits[0].status,operation:edits[0].operation,nodeId:null,error:edits[0].error}]:[]),...extraRows].filter(item=>!deleted.has(item.id));result={total:items.length,items};}
        else if(path.startsWith('/v1/image-editor/edits/')) {
          const edit=edits.find(item=>path.endsWith(item.id)||path.endsWith(`${item.id}/accept`));
          if(!edit){res.statusCode=404;result=null;}
          else if(path.endsWith('/accept')&&req.method==='POST') {individualAcceptCalls+=1;edit.status='ACCEPTED';result=edit;}
          else result=deleted.has(501)?{id:edit.id,task_id:501,status:'DELETED'}:edit;
        }
        else if(path==='/v1/image-editor/workspaces/501')result={...workspace,status:edits[0]?.status??'UPLOADED',operation:edits[0]?.operation};
        else if(path==='/v1/image-editor/workspaces/501/image-edits/batch') {
          batchSubmissions+=1;batchPayload=data;assert.equal(data.edits.length,2);
          const created=data.edits.map(item=>({id:randomUUID(),status:'QUEUED',version:1,attempts:0,operation:item.operation,target_page:item.targetPage,source_asset_id:item.sourceAssetId,created_by:'本人',created_by_account_id:8,config:item,result:null}));
          edits=[...created,...edits];result=created;
        }
        else if(/^\/v1\/image-editor\/workspaces\/501\/image-edits\/batch\/.+\/accept$/u.test(path)) {
          acceptedBatchPayload=data;
          assert.equal(data.edits.length,2);
          assert.equal(data.imageRunId,workspace.runId);
          for(const edit of edits.filter(item=>data.edits.some(selected=>selected.id===item.id)))edit.status='ACCEPTED';
          result={imageRunId:randomUUID(),processed:2};
        }
        else if(path==='/v1/image-editor/workspaces/501/image-edits') {
          if(req.method==='POST'){submissionCount+=1;if(failSubmission){res.statusCode=503;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:{code:'UNAVAILABLE',message:'暂时无法提交'}}));return;}submitted=data;edits=[{id:randomUUID(),status:'QUEUED',version:1,attempts:0,operation:data.operation,target_page:data.targetPage,source_asset_id:data.sourceAssetId,created_by:'本人',created_by_account_id:8,config:data,result:null},...edits];result=edits[0];}
          else result=edits;
        }else {res.statusCode=404;result=null;}
        res.setHeader('content-type','application/json');res.end(JSON.stringify({data:result}));return;
      }
      res.setHeader('content-type','text/html');res.end('<html><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    browser=await chromium.launch({headless:true,channel:process.env.IMAGE_EDIT_BROWSER_CHANNEL??'msedge'});
    const page=await browser.newPage({viewport:{width:1280,height:960}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{window.EyeDropper=undefined;});
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForTimeout(1500);
    assert.deepEqual(errors,[],await page.locator('body').innerText());
    assert.equal(await page.getByRole('heading',{name:'图片编辑',exact:true}).count(),1);
    assert.equal(await page.locator('input[type=file]').count(),0,'upload belongs only in the dialog');
    await page.getByRole('button',{name:'新增图片',exact:true}).click();
    assert.equal(await page.getByRole('dialog').count(),1);
    assert.equal(await page.getByRole('region',{name:'图片编辑组件'}).count(),0);
    await page.getByLabel('上传待编辑图片',{exact:true}).setInputFiles({name:'invalid.txt',mimeType:'text/plain',buffer:Buffer.from('not an image')});
    await page.getByRole('alert').filter({hasText:'PNG/JPEG/WebP'}).waitFor();
    assert.equal(uploaded,false,'invalid files never reach the API');
    await page.getByLabel('上传待编辑图片',{exact:true}).setInputFiles({name:'oversized-source.png',mimeType:'image/png',buffer:Buffer.alloc(5_680_000)});
    const oversizedSourceError=page.getByRole('alert').filter({hasText:'5.42 MiB'});
    await oversizedSourceError.waitFor();
    assert.match(await oversizedSourceError.innerText(),/oversized-source\.png/u);
    assert.match(await oversizedSourceError.innerText(),/5[，,\s]?242[，,\s]?880\s*字节/u);
    assert.equal(uploaded,false,'oversized originals never create a workspace');
    await page.getByLabel('上传待编辑图片',{exact:true}).setInputFiles({name:'source.png',mimeType:'image/png',buffer:png});
    await page.getByRole('region',{name:'图片编辑组件'}).waitFor();
    assert.equal(await page.getByRole('dialog').count(),1,'editor appears inline, not as a second modal');
    assert.equal(await page.getByRole('button',{name:'修改图片',exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'保存草稿',exact:true}).count(),0);
    assert.equal(submissionCount,0,'upload alone does not enqueue generation');
    assert.equal(await page.getByRole('link',{name:/下载/u}).count(),0,'uploaded originals have no download button');
    assert.equal(await page.getByRole('combobox',{name:'程序标识样式',exact:true}).count(),0);
    await page.getByRole('button',{name:'程序叠加（SVG + Sharp）',exact:true}).click();
    const badgeStyle=page.getByRole('combobox',{name:'程序标识样式',exact:true});
    assert.equal(await badgeStyle.textContent(),'实心徽章');
    assert.equal(await page.getByRole('radio',{name:'自定义颜色',exact:true}).isChecked(),true);
    assert.equal(await page.locator('[data-disclosure-preview] rect').getAttribute('fill'),'#111827');
    assert.equal(await page.locator('[data-disclosure-preview] text').getAttribute('fill'),'#FFFFFF');
    for(const radio of await page.getByRole('radiogroup',{name:'程序标识配色',exact:true}).getByRole('radio').all()) {
      const bounds=await radio.boundingBox();assert.ok(bounds.width<=20&&bounds.height<=20,'standalone color modes retain compact radio controls');
    }
    await page.getByRole('radio',{name:'自定义颜色',exact:true}).check();
    const badgeColorInput=page.getByLabel('程序标识颜色值',{exact:true});
    assert.equal(await badgeColorInput.inputValue(),'#111827');
    await badgeStyle.click();await page.getByRole('option',{name:'描边徽章',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'屏幕取色',exact:true}).count(),0,'unsupported browsers retain native picker and HEX inputs');
    await badgeColorInput.fill('#bad');
    await page.getByRole('alert').filter({hasText:'请输入有效的颜色值'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'保存并提交生图',exact:true}).isDisabled(),true);
    assert.equal(submissionCount,0,'invalid colors never submit');
    await page.getByLabel('程序标识取色器',{exact:true}).fill('#f1e2d3');
    assert.equal(await badgeColorInput.inputValue(),'#F1E2D3');
    assert.equal(await page.locator('[data-disclosure-preview] rect').getAttribute('stroke'),'#F1E2D3');
    assert.equal(await page.locator('[data-disclosure-preview] text').getAttribute('fill'),'#F1E2D3');
    await badgeStyle.click();await page.getByRole('option',{name:'实心徽章',exact:true}).click();
    assert.equal(await page.locator('[data-disclosure-preview] rect').getAttribute('fill'),'#F1E2D3');
    assert.equal(await page.locator('[data-disclosure-preview] text').getAttribute('fill'),'#000000');
    await badgeColorInput.fill('#111827');
    await page.getByLabel('人工生成标识文字',{exact:true}).fill('AI生成');
    failSubmission=true;
    await page.getByRole('button',{name:'保存并提交生图',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'暂时无法提交'}).waitFor();
    assert.equal(await page.getByRole('dialog').count(),1,'failed save keeps editing open');
    failSubmission=false;
    await page.getByRole('button',{name:'保存并提交生图',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'hidden'});
    const list=page.getByRole('region',{name:'图片编辑列表'});
    await list.getByText('准备处理',{exact:true}).waitFor();
    assert.equal(await list.getByText('中心程序处理',{exact:true}).count(),1);
    assert.equal(submitted.operation,'SVG_DISCLOSURE');assert.equal(submitted.draft,false);
    assert.equal(submitted.overlay.badgeVariant,'solid-pill');
    assert.equal(submitted.overlay.badgeColor,'#111827','new editor explicitly submits the fixed dark solid default');
    assert.equal(submissionCount,2,'one failed attempt and one successful submission');
    edits[0].status='RUNNING';
    await list.getByRole('button',{name:'刷新',exact:true}).click();
    await list.getByText('程序处理中',{exact:true}).waitFor();
    assert.equal(await list.getByRole('button',{name:'删除',exact:true}).isDisabled(),true);
    assert.equal(await list.getByLabel('全选本页可删除图片').isDisabled(),true);
    await list.getByRole('button',{name:'查看',exact:true}).click();
    await page.getByRole('heading',{name:'查看图片',exact:true}).waitFor();
    await page.getByLabel('人工生成标识文字',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('人工生成标识文字',{exact:true}).isDisabled(),true);
    assert.equal(await badgeStyle.textContent(),'实心徽章','saved solid style is restored');
    assert.equal(await badgeStyle.isDisabled(),true);
    assert.equal(await page.getByRole('radio',{name:'自定义颜色',exact:true}).isChecked(),true,'saved custom mode is restored');
    assert.equal(await badgeColorInput.inputValue(),'#111827','saved custom color is restored');
    assert.equal(await badgeColorInput.isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'保存并提交生图',exact:true}).isDisabled(),true);
    assert.equal(await page.getByRole('link',{name:/下载/u}).count(),0);
    await page.getByRole('tab',{name:/编辑记录/u}).click();
    await page.getByText('程序生成标识 · 程序处理中',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'直接删除此修复',exact:true}).isDisabled(),true);

    edits[0]={...edits[0],status:'PREVIEW_READY',version:2,attempts:1,result:{asset_id:602,image_run_id:randomUUID(),validation:{passed:true}}};
    const download=page.getByRole('link',{name:'下载图片',exact:true});await download.waitFor();
    assert.equal(await page.getByRole('button',{name:'保存并提交生图',exact:true}).isEnabled(),true);
    const downloadBounds=await download.boundingBox(),saveBounds=await page.getByRole('button',{name:'保存并提交生图',exact:true}).boundingBox();
    assert.ok(downloadBounds.x<saveBounds.x,'download sits to the left of save');
    assert.equal(await download.getAttribute('href'),'/api/control-plane/v1/image-editor/assets/602?download=true');
    const event=page.waitForEvent('download');await download.click();assert.equal((await event).suggestedFilename(),'edited.png');
    if(process.env.IMAGE_EDITOR_SCREENSHOT_DIR)await page.screenshot({path:join(process.env.IMAGE_EDITOR_SCREENSHOT_DIR,'image-editor-desktop.png')});
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.getByRole('dialog').isVisible());
    await page.getByRole('tab',{name:/^记录/u}).click();
    assert.ok(await download.isVisible());
    assert.ok((await download.boundingBox()).x<(await page.getByRole('button',{name:'保存并提交生图',exact:true}).boundingBox()).x,'download remains left of save on mobile');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    const dialogBounds=await page.getByRole('dialog').boundingBox();
    assert.ok(dialogBounds.x>=0 && dialogBounds.x+dialogBounds.width<=390);
    if(process.env.IMAGE_EDITOR_SCREENSHOT_DIR)await page.screenshot({path:join(process.env.IMAGE_EDITOR_SCREENSHOT_DIR,'image-editor-mobile.png')});
    await page.setViewportSize({width:1280,height:960});
    await page.getByRole('tab',{name:'本次编辑',exact:true}).click();
    assert.equal(await page.getByLabel('人工生成标识文字',{exact:true}).inputValue(),'AI生成','last submitted values are restored');
    await page.getByLabel('人工生成标识文字',{exact:true}).fill('再次生成');
    await page.getByRole('button',{name:'保存并提交生图',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'hidden'});
    await list.getByText('准备处理',{exact:true}).waitFor();
    assert.equal(submitted.overlay.text,'再次生成');assert.equal(submissionCount,3);
    await list.getByRole('button',{name:'查看 / 编辑',exact:true}).click();
    await page.getByRole('region',{name:'图片编辑组件'}).waitFor();
    assert.equal(await page.getByRole('link',{name:/下载/u}).count(),0,'previous result is hidden while new generation is queued');
    await page.getByRole('button',{name:'关闭弹窗',exact:true}).click();
    edits[0].status='FAILED';edits[0].error='验收未通过';
    await list.getByRole('button',{name:'刷新',exact:true}).click();
    await list.getByText('生成失败，可打开记录重试',{exact:true}).waitFor();
    assert.equal(await list.getByText('已完成',{exact:true}).count(),1);
    await list.getByRole('button',{name:'删除',exact:true}).click();
    await page.getByRole('alertdialog').getByRole('button',{name:'确认删除',exact:true}).click();
    await list.getByText('暂无图片，点击右上角“新增图片”开始编辑。',{exact:true}).waitFor();
    assert.deepEqual(deletions[0],[501]);
    await page.waitForFunction(()=>{
      const tasks=JSON.parse(localStorage.getItem('xhs:background-tasks:v1:browser-test')??'[]');
      return tasks.length>0&&tasks.every(task=>task.taskId!==501||task.status==='DELETED'&&task.read);
    });
    await page.waitForFunction(()=>![...document.querySelectorAll('[data-sonner-toast]')].some(item=>item.textContent.includes('独立图片编辑 #501')));
    await page.getByRole('button',{name:/^后台任务，/u}).click();
    await page.getByRole('dialog').getByText('暂无后台任务。',{exact:true}).waitFor();
    await page.getByRole('button',{name:'关闭弹窗',exact:true}).click();

    deleted.clear();extraRows=[{id:502,title:'第二张图片',owner:'本人',status:'PREVIEW_READY'}];
    await list.getByRole('button',{name:'刷新',exact:true}).click();
    await list.getByText('第二张图片',{exact:true}).waitFor();
    await list.getByLabel('全选本页可删除图片').check();
    await list.getByRole('button',{name:'批量删除（2）',exact:true}).click();
    await page.getByRole('alertdialog').getByRole('button',{name:'确认删除',exact:true}).click();
    await list.getByText('暂无图片，点击右上角“新增图片”开始编辑。',{exact:true}).waitFor();
    assert.deepEqual(deletions[1],[501,502]);
    await page.getByRole('button',{name:'新增图片',exact:true}).click();
    assert.equal(await page.getByRole('region',{name:'图片编辑组件'}).count(),0,'new upload clears the previous editor');
    edits=[];workspace.assets.push({id:603,sha256:'c'.repeat(64),url:'/v1/image-editor/assets/603'},{id:604,sha256:'d'.repeat(64),url:'/v1/image-editor/assets/604'});
    await page.getByLabel('上传待编辑图片',{exact:true}).setInputFiles([{name:'one.png',mimeType:'image/png',buffer:png},{name:'two.png',mimeType:'image/png',buffer:png},{name:'three.png',mimeType:'image/png',buffer:png}]);
    await page.getByRole('region',{name:'图片编辑组件'}).waitFor();
    await page.getByRole('button',{name:'程序叠加（SVG + Sharp）',exact:true}).click();
    assert.equal(await badgeStyle.textContent(),'实心徽章','new uploads use the solid default');
    assert.equal(await page.getByRole('radio',{name:'自定义颜色',exact:true}).isChecked(),true,'new uploads use the fixed dark color');
    assert.equal(await badgeColorInput.inputValue(),'#111827');
    await page.getByRole('radio',{name:'自定义颜色',exact:true}).check();
    await badgeColorInput.fill('#234567');
    await badgeStyle.click();await page.getByRole('option',{name:'实心徽章',exact:true}).click();
    assert.equal(await page.getByLabel('选择第 1 页').isChecked(),true,'current page is selected by default');
    await page.getByRole('button',{name:'预览第 2 页',exact:true}).click();
    assert.equal(await page.getByLabel('选择第 2 页').isChecked(),false,'previewing does not select a page');
    assert.equal(await page.getByLabel('选择第 1 页').isChecked(),true);
    await page.getByLabel('选择第 3 页').check();
    await page.getByRole('button',{name:'生成已选 2 张程序标识预览',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'hidden'});
    await list.getByText('准备处理',{exact:true}).waitFor();
    assert.equal(batchSubmissions,1,'selected pages are submitted in one atomic request');
    assert.deepEqual(batchPayload.edits.map(edit=>[edit.targetPage,edit.batchSize,edit.sourceAssetId]),[[1,2,601],[3,2,604]]);
    assert.ok(batchPayload.edits.every(edit=>edit.operation==='SVG_DISCLOSURE'&&edit.overlay.badgeVariant==='solid-pill'));
    assert.ok(batchPayload.edits.every(edit=>edit.overlay.badgeColor==='#234567'),'selected pages share their custom color');
    assert.deepEqual(edits.map(edit=>edit.target_page),[1,3]);
    edits=edits.map(edit=>({...edit,status:'PREVIEW_READY',result:{asset_id:edit.source_asset_id+100,image_run_id:randomUUID(),validation:{passed:true}}}));
    await list.getByRole('button',{name:'刷新',exact:true}).click();
    await list.getByRole('button',{name:'查看 / 编辑',exact:true}).click();
    await page.getByRole('tab',{name:/编辑记录/u}).click();
    await page.getByRole('button',{name:'查看第 3 页预览待确认',exact:true}).click();
    assert.equal(await page.getByRole('region',{name:'图片预览'}).locator('img').first().getAttribute('src'),'/api/control-plane/v1/image-editor/assets/604');
    await page.getByRole('region',{name:'已选标识批次状态'}).getByRole('button',{name:'一次采用已选 2 张',exact:true}).click();
    await page.getByLabel('已选标识采用原因').fill('预览符合要求');
    await page.getByRole('region',{name:'已选标识批次状态'}).getByRole('button',{name:'确认采用',exact:true}).click();
    await page.getByRole('region',{name:'已选标识批次状态'}).getByRole('button',{name:'已采用 2 张标识',exact:true}).waitFor();
    assert.deepEqual(acceptedBatchPayload.edits.map(edit=>edit.id).sort(),edits.map(edit=>edit.id).sort());
    edits=[...edits.map((edit,index)=>({...edit,status:index===0?'PREVIEW_READY':'ACCEPTED',config:{...edit.config,batchSize:undefined}})),
      {...edits[0],id:randomUUID(),target_page:2,source_asset_id:603,status:'ACCEPTED',config:{...edits[0].config,targetPage:2,sourceAssetId:603,batchSize:undefined}}];
    await page.getByRole('button',{name:'关闭弹窗',exact:true}).click();
    await list.getByRole('button',{name:'刷新',exact:true}).click();
    await list.getByRole('button',{name:'查看 / 编辑',exact:true}).click();
    await page.getByRole('tab',{name:/编辑记录/u}).click();
    await page.getByRole('region',{name:'已选标识批次状态'}).getByRole('button',{name:'继续采用剩余 1 张',exact:true}).click();
    await page.getByLabel('已选标识采用原因').fill('旧批次继续采用');
    await page.getByRole('region',{name:'已选标识批次状态'}).getByRole('button',{name:'确认采用',exact:true}).click();
    await page.getByRole('region',{name:'已选标识批次状态'}).getByRole('button',{name:'已采用 3 张标识',exact:true}).waitFor();
    assert.equal(individualAcceptCalls,1,'a partially accepted legacy batch resumes only its pending page');
    edits=edits.map(edit=>({...edit,status:'PREVIEW_READY'}));
    await page.getByRole('button',{name:'关闭弹窗',exact:true}).click();
    await list.getByRole('button',{name:'刷新',exact:true}).click();
    await list.getByRole('button',{name:'查看 / 编辑',exact:true}).click();
    await page.getByRole('tab',{name:/编辑记录/u}).click();
    await page.getByRole('region',{name:'已选标识批次状态'}).getByRole('button',{name:'逐张采用旧批次 3 张',exact:true}).click();
    await page.getByLabel('已选标识采用原因').fill('旧批次采用');
    await page.getByRole('region',{name:'已选标识批次状态'}).getByRole('button',{name:'确认采用',exact:true}).click();
    await page.getByRole('region',{name:'已选标识批次状态'}).getByRole('button',{name:'已采用 3 张标识',exact:true}).waitFor();
    assert.equal(individualAcceptCalls,4,'a legacy batch without batchSize does not call atomic adoption');
    await page.getByRole('tab',{name:'本次编辑',exact:true}).click();
    assert.equal(await page.getByRole('radio',{name:'自定义颜色',exact:true}).isChecked(),true);
    assert.equal(await badgeColorInput.inputValue(),'#234567','batch history restores the custom color');
    await page.getByRole('radio',{name:'自动配色',exact:true}).check();
    await page.getByRole('button',{name:'清空',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'生成已选 0 张程序标识预览',exact:true}).isDisabled(),true);
    await page.getByLabel('选择第 2 页').check();
    await page.getByRole('button',{name:'生成已选 1 张程序标识预览',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'hidden'});
    assert.equal(submitted.targetPage,2,'single selection uses its own page');
    assert.equal(submitted.sourceAssetId,603,'single selection uses the matching source asset');
    assert.equal(batchSubmissions,1,'single selection does not create a batch');
    assert.equal(submitted.overlay.badgeVariant,'solid-pill');
    assert.equal(Object.hasOwn(submitted.overlay,'badgeColor'),false,'automatic submissions omit the historic custom color');
    extraRows=[{id:505,title:'模型标识',owner:'本人',status:'QUEUED',operation:'TEXT',nodeId:'model-worker',error:null}];
    await list.getByRole('button',{name:'刷新',exact:true}).click();
    const programmaticRow=list.getByRole('row').filter({hasText:workspace.title});
    const modelRow=list.getByRole('row').filter({hasText:'模型标识'});
    await programmaticRow.getByText('准备处理',{exact:true}).waitFor();
    await modelRow.getByText('待生图',{exact:true}).waitFor();
    assert.equal(await modelRow.getByText('model-worker',{exact:true}).count(),1);
    assert.equal(await modelRow.getByText('中心程序处理',{exact:true}).count(),0);
    extraRows[0].status='RUNNING';
    await list.getByRole('button',{name:'刷新',exact:true}).click();
    await modelRow.getByText('生图中',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    assert.deepEqual(errors,[]);
  } finally {
    await browser?.close();if(server)await new Promise(r=>server.close(r));
    assert.ok(resolve(root).startsWith(resolve(tmpdir())));await rm(root,{recursive:true,force:true});
  }
});

test('independent image editor browser: reference upload errors explain size and actual format, and allow corrected files',
 {skip:process.env.RUN_IMAGE_EDIT_BROWSER!=='1',timeout:45000},async()=>{
  const {build}=await import('esbuild'),{chromium}=await import('playwright-core');
  const root=await mkdtemp(join(tmpdir(),'standalone-reference-errors-'));
  const png=await sharp({create:{width:1086,height:1448,channels:3,background:'#eeeeee'}}).png().toBuffer();
  const jpeg=await sharp(png).jpeg().toBuffer(),uploadRequests=[];
  let browser,server,editSubmissions=0;
  try {
    await build({stdin:{contents:`import './app/globals.css';import React from 'react';import{createRoot}from'react-dom/client';import{ConfirmDialogProvider}from'./components/ui/confirm-dialog';import{StandaloneImageEditor}from'./app/components/standalone-image-editor';const asset={id:1,sha256:'a'.repeat(64),url:'/v1/image-editor/assets/1'};createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><StandaloneImageEditor taskId={838} runId="${randomUUID()}" copyRevisionId={1} asset={asset} page={1} runs={[]} onChanged={async()=>{}} onSubmitted={()=>{}} onBusyChange={()=>{}} initialStatus="UPLOADED" onRunningChange={()=>{}}/></ConfirmDialogProvider>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,outfile:join(root,'bundle.js'),jsx:'automatic',platform:'browser',conditions:['style'],alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"test"','process.env':'{}'}});
    const [js,rawCss]=await Promise.all([readFile(join(root,'bundle.js')),readFile(join(root,'bundle.css'),'utf8')]);
    const {default:postcss}=await import('postcss'),{default:tailwind}=await import('@tailwindcss/postcss');
    const {css}=await postcss([tailwind()]).process(rawCss,{from:join(process.cwd(),'app/globals.css')});
    server=createServer(async(req,res)=>{
      if(req.url==='/bundle.js'){res.setHeader('content-type','application/javascript');res.end(js);return;}
      if(req.url==='/bundle.css'){res.setHeader('content-type','text/css');res.end(css);return;}
      if(req.url?.includes('/assets/')){res.setHeader('content-type','image/png');res.end(png);return;}
      if(req.url?.startsWith('/api/')){
        let body='';for await(const chunk of req)body+=chunk;
        const data=body?JSON.parse(body):null;
        res.setHeader('content-type','application/json');
        if(req.method==='POST'&&req.url.endsWith('/image-edit-references')){
          uploadRequests.push(data);
          assert.equal(req.url,'/api/control-plane/v1/image-editor/workspaces/838/image-edit-references');
          assert.deepEqual(Buffer.from(data.base64,'base64'),jpeg);
          if(data.mediaType==='image/png'){
            let validationError;
            try {await decodeReference(Buffer.from(data.base64,'base64'),data.mediaType);}
            catch(error){validationError=error;}
            assert.ok(validationError instanceof TypeError);
            res.statusCode=400;res.end(JSON.stringify({error:{code:'VALIDATION_ERROR',message:validationError.message}}));return;
          }
          assert.equal(data.mediaType,'image/jpeg');
          res.end(JSON.stringify({data:{id:9,sha256:'b'.repeat(64),url:'/v1/image-editor/assets/9'}}));return;
        }
        if(req.method==='POST')editSubmissions+=1;
        res.end(JSON.stringify({data:[]}));return;
      }
      res.setHeader('content-type','text/html');res.end('<html><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    browser=await chromium.launch({headless:true,channel:process.env.IMAGE_EDIT_BROWSER_CHANNEL??'msedge'});
    const page=await browser.newPage({viewport:{width:1280,height:960}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('tab',{name:'实体替换',exact:true}).click();
    const input=page.getByLabel('上传真实产品参考图',{exact:true});
    await page.waitForFunction(()=>document.querySelector('input[aria-label="上传真实产品参考图"]')?.disabled===false);
    await input.setInputFiles({name:'large.jpg',mimeType:'image/jpeg',buffer:Buffer.alloc(5_680_000)});
    const sizeError=page.getByRole('alert').filter({hasText:'5.42 MiB'});
    await sizeError.waitFor();
    assert.match(await sizeError.innerText(),/5\s*MiB/u);
    assert.match(await sizeError.innerText(),/5[，,\s]?242[，,\s]?880\s*字节/u);
    assert.match(await sizeError.innerText(),/5[，,\s]?680[，,\s]?000\s*字节/u);
    assert.equal(uploadRequests.length,0,'oversized reference files never reach the upload API');
    assert.equal(await input.inputValue(),'','reselecting the same failed file remains possible');
    const screenshots=resolve('.codex_artifacts/image-upload-feedback');await mkdir(screenshots,{recursive:true});
    await page.screenshot({path:join(screenshots,'standalone-size-error.png'),animations:'disabled'});
    await input.setInputFiles({name:'reference.png',mimeType:'image/png',buffer:jpeg});
    const formatError=page.getByRole('alert').filter({hasText:'实际为 JPEG'});
    await formatError.waitFor();
    assert.match(await formatError.innerText(),/\.jpg/u);assert.match(await formatError.innerText(),/\.jpeg/u);
    assert.equal(uploadRequests.length,1);
    assert.equal(await page.getByRole('img',{name:'已上传的真实产品参考图',exact:true}).count(),0);
    await page.screenshot({path:join(screenshots,'standalone-format-error.png'),animations:'disabled'});
    await input.setInputFiles({name:'reference.jpg',mimeType:'image/jpeg',buffer:jpeg});
    await page.getByRole('img',{name:'已上传的真实产品参考图',exact:true}).waitFor();
    assert.equal(uploadRequests.length,2,'correcting the file type permits another upload');
    assert.equal(await page.getByRole('alert').count(),0,'successful upload clears the earlier error');
    assert.equal(editSubmissions,0,'reference uploads never submit a model edit');
    assert.deepEqual(errors,[]);
  } finally {
    await browser?.close();if(server)await new Promise(r=>server.close(r));
    assert.ok(resolve(root).startsWith(resolve(tmpdir())));await rm(root,{recursive:true,force:true});
  }
});
