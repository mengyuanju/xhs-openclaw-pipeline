import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

test('independent image editor browser: list, inline upload dialog, save-to-queue, status, download and mobile',
 {skip:process.env.RUN_IMAGE_EDIT_BROWSER!=='1',timeout:90000},async()=>{
  const {build}=await import('esbuild'),{chromium}=await import('playwright-core');
  const root=await mkdtemp(join(tmpdir(),'standalone-editor-browser-'));
  const png=await sharp({create:{width:1086,height:1448,channels:4,background:'#e6f0ec'}}).png().toBuffer();
  const workspace={id:501,title:'独立上传图片',runId:randomUUID(),copyRevisionId:91,
    assets:[{id:601,sha256:'a'.repeat(64),url:'/v1/image-editor/assets/601'}],runs:[]};
  let server,browser,uploaded=false,edits=[],submitted,submissionCount=0,failSubmission=false;
  try {
    await build({stdin:{contents:`import './app/globals.css';import React from 'react';import{createRoot}from'react-dom/client';import{ConfirmDialogProvider}from'./components/ui/confirm-dialog';import{ImageEditorWorkbench}from'./app/image-editor/workbench';createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><ImageEditorWorkbench/></ConfirmDialogProvider>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,outfile:join(root,'bundle.js'),jsx:'automatic',platform:'browser',conditions:['style'],alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"test"','process.env':'{}'}});
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
        if(path==='/v1/image-editor/workspaces'&&req.method==='POST'){uploaded=true;assert.equal(data.images.length,1);result=workspace;}
        else if(path==='/v1/image-editor/workspaces'){assert.equal(new URL(req.url,'http://localhost').searchParams.get('queue'),'true');result={total:edits.length?1:0,items:edits.length?[{id:501,title:workspace.title,owner:'本人',status:edits[0].status,error:edits[0].error}]:[]};}
        else if(path==='/v1/image-editor/workspaces/501')result=workspace;
        else if(path==='/v1/image-editor/workspaces/501/image-edits') {
          if(req.method==='POST'){submissionCount+=1;if(failSubmission){res.statusCode=503;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:{code:'UNAVAILABLE',message:'暂时无法提交'}}));return;}submitted=data;edits=[{id:randomUUID(),status:'QUEUED',version:1,attempts:0,operation:data.operation,target_page:1,source_asset_id:601,created_by:'本人',config:{instruction:data.instruction},result:null}];result=edits[0];}
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
    await page.getByLabel('上传待编辑图片',{exact:true}).setInputFiles({name:'source.png',mimeType:'image/png',buffer:png});
    await page.getByRole('region',{name:'图片编辑组件'}).waitFor();
    assert.equal(await page.getByRole('dialog').count(),1,'editor appears inline, not as a second modal');
    assert.equal(await page.getByRole('button',{name:'修改图片',exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'保存草稿',exact:true}).count(),0);
    assert.equal(submissionCount,0,'upload alone does not enqueue generation');
    await page.getByRole('button',{name:'程序叠加（SVG + Sharp）',exact:true}).click();
    await page.getByLabel('人工生成标识文字',{exact:true}).fill('AI生成');
    failSubmission=true;
    await page.getByRole('button',{name:'保存并提交生图',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'暂时无法提交'}).waitFor();
    assert.equal(await page.getByRole('dialog').count(),1,'failed save keeps editing open');
    failSubmission=false;
    await page.getByRole('button',{name:'保存并提交生图',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'hidden'});
    const list=page.getByRole('region',{name:'图片编辑列表'});
    await list.getByText('待生图',{exact:true}).waitFor();
    assert.equal(submitted.operation,'SVG_DISCLOSURE');assert.equal(submitted.draft,false);
    assert.equal(submissionCount,2,'one failed attempt and one successful submission');
    edits[0].status='RUNNING';
    await list.getByRole('button',{name:'刷新',exact:true}).click();
    await list.getByText('生图中',{exact:true}).waitFor();
    edits[0]={...edits[0],status:'PREVIEW_READY',version:2,attempts:1,result:{asset_id:602,image_run_id:randomUUID(),validation:{passed:true}}};
    await list.getByRole('button',{name:'刷新',exact:true}).click();
    await list.getByText('已完成',{exact:true}).waitFor();
    await list.getByRole('button',{name:'查看 / 编辑',exact:true}).click();
    await page.getByRole('tab',{name:/编辑记录/u}).click();
    const download=page.getByRole('link',{name:'下载结果',exact:true});await download.waitFor();
    assert.equal(await download.getAttribute('href'),'/api/control-plane/v1/image-editor/assets/602?download=true');
    const event=page.waitForEvent('download');await download.click();assert.equal((await event).suggestedFilename(),'edited.png');
    if(process.env.IMAGE_EDITOR_SCREENSHOT_DIR)await page.screenshot({path:join(process.env.IMAGE_EDITOR_SCREENSHOT_DIR,'image-editor-desktop.png')});
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.getByRole('dialog').isVisible());
    await page.getByRole('tab',{name:/^记录/u}).click();
    assert.ok(await download.isVisible());
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    const dialogBounds=await page.getByRole('dialog').boundingBox();
    assert.ok(dialogBounds.x>=0 && dialogBounds.x+dialogBounds.width<=390);
    if(process.env.IMAGE_EDITOR_SCREENSHOT_DIR)await page.screenshot({path:join(process.env.IMAGE_EDITOR_SCREENSHOT_DIR,'image-editor-mobile.png')});
    await page.getByRole('button',{name:'关闭弹窗',exact:true}).click();
    edits[0].status='FAILED';edits[0].error='验收未通过';
    await list.getByRole('button',{name:'刷新',exact:true}).click();
    await list.getByText('生成失败，可打开记录重试',{exact:true}).waitFor();
    assert.equal(await list.getByText('已完成',{exact:true}).count(),1);
    await page.getByRole('button',{name:'新增图片',exact:true}).click();
    assert.equal(await page.getByRole('region',{name:'图片编辑组件'}).count(),0,'new upload clears the previous editor');
    await page.getByRole('button',{name:'关闭弹窗',exact:true}).click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    assert.deepEqual(errors,[]);
  } finally {
    await browser?.close();if(server)await new Promise(r=>server.close(r));
    assert.ok(resolve(root).startsWith(resolve(tmpdir())));await rm(root,{recursive:true,force:true});
  }
});
