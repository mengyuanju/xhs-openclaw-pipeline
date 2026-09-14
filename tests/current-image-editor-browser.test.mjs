import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

test('image editor browser: tabs, fee gate, selected mask, reference upload, preview and explicit acceptance',{skip:process.env.RUN_IMAGE_EDIT_BROWSER!=='1',timeout:60000},async()=>{
  const {build}=await import('esbuild'),{chromium}=await import('playwright-core');
  const root=await mkdtemp(join(tmpdir(),'image-edit-browser-')),bundle=join(root,'bundle.js');
  const runId=randomUUID(),editId=randomUUID();let edits=[],submitted=null,actions=[];
  const png=await sharp({create:{width:1086,height:1448,channels:4,background:'#eeeeee'}}).png().toBuffer();
  let browser,server;
  try{
    await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{CurrentImageEditor}from'./app/components/current-image-editor';createRoot(document.getElementById('root')).render(<CurrentImageEditor taskId={1} runId="${runId}" copyRevisionId={1} asset={{id:1,sha256:'${'a'.repeat(64)}',url:'/v1/assets/1'}} page={1} runs={[]} onChanged={async()=>{}}/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,outfile:bundle,jsx:'automatic',platform:'browser',alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"test"'}});
    const js=await readFile(bundle);
    server=createServer(async(req,res)=>{
      if(req.url==='/bundle.js'){res.setHeader('content-type','application/javascript');res.end(js);return;}
      if(req.url?.includes('/assets/')){res.setHeader('content-type','image/png');res.end(png);return;}
      if(req.url?.startsWith('/api/')){
        let body='';for await(const chunk of req)body+=chunk;
        const data=body?JSON.parse(body):null;
        if(req.method==='POST'&&req.url.endsWith('/image-edit-references')){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:{id:9,sha256:'b'.repeat(64),url:'/v1/assets/9'}}));return;}
        if(req.method==='POST'&&req.url.endsWith('/image-edits')){submitted=data;edits=[{id:editId,version:1,status:'PREVIEW_READY',operation:data.operation,target_page:1,config:{instruction:data.instruction},result:{asset_id:2,image_run_id:randomUUID(),validation:{passed:true}}}];}
        else if(req.method==='POST'){actions.push({url:req.url,data});edits=edits.map(e=>({...e,status:req.url.endsWith('/accept')?'ACCEPTED':'CANCELLED',version:2}));}
        res.setHeader('content-type','application/json');res.end(JSON.stringify({data:req.method==='GET'?edits:edits[0]}));return;
      }
      res.setHeader('content-type','text/html');res.end('<html><meta charset="utf-8"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    browser=await chromium.launch({headless:true,channel:process.env.IMAGE_EDIT_BROWSER_CHANNEL??'msedge'});
    const page=await browser.newPage({viewport:{width:1440,height:1200}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button',{name:'修改图片',exact:true}).click();
    await page.getByLabel('指定短句',{exact:true}).fill('真实参考');
    assert.equal(await page.locator('svg text').textContent(),'真实参考');
    assert.equal(await page.getByLabel('文本类型').inputValue(),'CUSTOM');
    assert.equal(await page.getByRole('button',{name:'生成修改预览',exact:true}).isDisabled(),true);
    await page.getByRole('tab',{name:'提示词修改'}).click();
    assert.equal(await page.getByRole('button',{name:'生成修改预览',exact:true}).isDisabled(),true);
    await page.getByLabel('局部修改（选区外像素不变）').check();
    await page.getByLabel('选区横坐标').fill('20');await page.getByLabel('选区纵坐标').fill('30');
    await page.getByLabel('图片修改要求').fill('改变选区颜色');
    await page.getByLabel('确认调用图片编辑与实体校验模型，会产生费用；自动修复和人工重试也可能收费。').check();
    await page.getByRole('button',{name:'生成修改预览',exact:true}).click();
    await page.getByRole('heading',{name:'修改前后滑动对比'}).waitFor();
    assert.equal(submitted.operation,'AI_LOCAL');assert.equal(submitted.mask.x,20);assert.equal(submitted.mask.y,30);
    assert.equal(submitted.confirmation,'LIVE_IMAGE_COST_ACCEPTED');assert.equal(actions.length,0);
    assert.equal(await page.getByRole('button',{name:'采用此版本',exact:true}).isDisabled(),true);
    await page.getByLabel('采用拒绝重试原因').fill('预览确认');await page.getByRole('button',{name:'采用此版本',exact:true}).click();
    await page.getByText('AI 局部修改 · 已采用',{exact:true}).waitFor();assert.equal(actions.length,1);assert.match(actions[0].data.requestId,/^[a-f0-9-]{36}$/);
    await page.getByRole('tab',{name:'实体图片'}).click();await page.getByLabel('参考图来源说明').fill('自有产品实拍');
    await page.getByLabel('上传实体参考图').setInputFiles({name:'reference.png',mimeType:'image/png',buffer:png});
    await page.getByRole('img',{name:'参考图 1',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'生成修改预览',exact:true}).isDisabled(),false);
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();if(server)await new Promise(r=>server.close(r));assert.ok(resolve(root).startsWith(resolve(tmpdir())));await rm(root,{recursive:true,force:true});}
});
