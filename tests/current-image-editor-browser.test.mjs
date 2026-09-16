import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

test('image editor browser: prompt-localized edit, fee gate, reference upload, preview and explicit acceptance',{skip:process.env.RUN_IMAGE_EDIT_BROWSER!=='1',timeout:60000},async()=>{
  const {build}=await import('esbuild'),{chromium}=await import('playwright-core');
  const root=await mkdtemp(join(tmpdir(),'image-edit-browser-')),bundle=join(root,'bundle.js'),stylesheet=join(root,'bundle.css');
  const runId=randomUUID(),editId=randomUUID();let edits=[],submitted=null,actions=[];
  const png=await sharp({create:{width:1086,height:1448,channels:4,background:'#eeeeee'}}).png().toBuffer();
  let browser,server;
  try{
    await build({stdin:{contents:`import './app/globals.css';import React from 'react';import{createRoot}from'react-dom/client';import{CurrentImageEditor}from'./app/components/current-image-editor';createRoot(document.getElementById('root')).render(<CurrentImageEditor taskId={1} runId="${runId}" copyRevisionId={1} asset={{id:1,sha256:'${'a'.repeat(64)}',url:'/v1/assets/1'}} page={1} runs={[]} onChanged={async()=>{}}/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,outfile:bundle,jsx:'automatic',platform:'browser',conditions:['style'],alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"test"'}});
    const [js,css]=await Promise.all([readFile(bundle),readFile(stylesheet)]);
    server=createServer(async(req,res)=>{
      if(req.url==='/bundle.js'){res.setHeader('content-type','application/javascript');res.end(js);return;}
      if(req.url==='/bundle.css'){res.setHeader('content-type','text/css');res.end(css);return;}
      if(req.url?.includes('/assets/')){res.setHeader('content-type','image/png');res.end(png);return;}
      if(req.url?.startsWith('/api/')){
        let body='';for await(const chunk of req)body+=chunk;
        const data=body?JSON.parse(body):null;
        if(req.method==='POST'&&req.url.endsWith('/image-edit-references')){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:{id:9,sha256:'b'.repeat(64),url:'/v1/assets/9'}}));return;}
        if(req.method==='POST'&&req.url.endsWith('/image-edits')){submitted=data;edits=[{id:editId,version:1,status:'PREVIEW_READY',operation:data.operation,target_page:1,config:{instruction:data.instruction},result:{asset_id:2,image_run_id:randomUUID(),validation:{passed:true}}}];}
        else if(req.method==='POST'){actions.push({url:req.url,data});edits=edits.map(e=>({...e,status:req.url.endsWith('/accept')?'ACCEPTED':'CANCELLED',version:2}));}
        res.setHeader('content-type','application/json');res.end(JSON.stringify({data:req.method==='GET'?edits:edits[0]}));return;
      }
      res.setHeader('content-type','text/html');res.end('<html><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><style>[data-slot="dialog-content"]{translate:-50% -50%}</style><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    browser=await chromium.launch({headless:true,channel:process.env.IMAGE_EDIT_BROWSER_CHANNEL??'msedge'});
    const page=await browser.newPage({viewport:{width:1010,height:878}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button',{name:'修改图片',exact:true}).click();
    const dialog=page.getByRole('dialog');
    const [dialogBox,previewBox,settingsBox,dialogStyle,overlayStyle]=await Promise.all([
      dialog.boundingBox(),
      page.getByRole('region',{name:'图片预览'}).boundingBox(),
      page.getByRole('region',{name:'图片修改设置'}).boundingBox(),
      dialog.evaluate(element=>({display:getComputedStyle(element).display,overflow:getComputedStyle(element).overflow,zIndex:getComputedStyle(element).zIndex,position:getComputedStyle(element).position,left:getComputedStyle(element).left,top:getComputedStyle(element).top,translate:getComputedStyle(element).translate,transform:getComputedStyle(element).transform})),
      page.locator('[data-slot="dialog-overlay"]').evaluate(element=>({position:getComputedStyle(element).position,zIndex:getComputedStyle(element).zIndex})),
    ]);
    assert.ok(dialogBox&&dialogBox.width<=1120&&dialogBox.height<=900&&dialogBox.x>=0&&dialogBox.y>=0&&dialogBox.x+dialogBox.width<=1010&&dialogBox.y+dialogBox.height<=878,JSON.stringify({dialogBox,dialogStyle}));
    assert.ok(previewBox&&settingsBox&&previewBox.x+previewBox.width<settingsBox.x);
    assert.equal(dialogStyle.display,'grid');assert.equal(dialogStyle.overflow,'hidden');assert.equal(dialogStyle.zIndex,'141');assert.equal(dialogStyle.translate,'-50% -50%');assert.equal(dialogStyle.transform,'none');
    assert.deepEqual(overlayStyle,{position:'fixed',zIndex:'140'});
    await page.getByLabel('人工生成标识文字',{exact:true}).fill('人工生成');
    assert.equal(await page.locator('svg text').textContent(),'人工生成');
    assert.equal(await page.getByLabel('文本类型').count(),0);
    assert.equal(await page.getByLabel('字号').count(),0);
    assert.equal(await page.getByText('样式由管理员的图片编辑提示词控制',{exact:false}).count(),1);
    assert.equal(await page.getByRole('button',{name:'保存草稿',exact:true}).isDisabled(),false);
    assert.equal(await page.getByRole('button',{name:'生成修改预览',exact:true}).isDisabled(),false);
    await page.getByRole('button',{name:'生成修改预览',exact:true}).click();
    await page.getByRole('alert').getByText('请先勾选费用确认',{exact:false}).waitFor();
    assert.equal(submitted,null);
    await page.getByRole('tab',{name:'局部修改'}).click();
    assert.equal(await page.getByLabel('选区方式').count(),0);
    assert.equal(await page.getByLabel('选区横坐标').count(),0);
    assert.equal(await page.getByLabel('画笔半径').count(),0);
    await page.getByRole('button',{name:'保存草稿',exact:true}).click();
    await page.getByRole('alert').getByText('请先填写局部修改说明',{exact:false}).waitFor();
    assert.equal(submitted,null);
    await page.getByLabel('图片修改要求').fill('把画面左下角人物手中的黑色书包替换成手提文件袋，保持其他区域不变');
    await page.getByRole('button',{name:'生成修改预览',exact:true}).click();
    await page.getByRole('alert').getByText('请先勾选费用确认',{exact:false}).waitFor();
    assert.equal(submitted,null);
    const feeCheckbox=page.getByLabel('确认调用图片编辑与实体校验模型，会产生费用；自动修复和人工重试也可能收费。');
    await feeCheckbox.check();
    const feeVisual=page.locator('[data-fee-checkbox]');
    const [feeInputBox,feeBox,feeState]=await Promise.all([feeCheckbox.boundingBox(),feeVisual.boundingBox(),feeCheckbox.evaluate(element=>{const visual=element.nextElementSibling,parent=element.parentElement;return{checked:element.checked,inputOpacity:getComputedStyle(element).opacity,width:getComputedStyle(visual).width,height:getComputedStyle(visual).height,backgroundColor:getComputedStyle(visual).backgroundColor,backgroundImage:getComputedStyle(visual).backgroundImage,outlineWidth:getComputedStyle(visual).outlineWidth,parentDisplay:getComputedStyle(parent).display,parentOutlineWidth:getComputedStyle(parent).outlineWidth};})]);
    assert.ok(feeInputBox&&feeInputBox.width<=1&&feeInputBox.height<=1,JSON.stringify({feeInputBox,feeState}));
    assert.ok(feeBox&&feeBox.width===18&&feeBox.height===18,JSON.stringify({feeBox,feeState}));
    assert.equal(feeState.checked,true);assert.equal(feeState.inputOpacity,'0');assert.equal(feeState.width,'18px');assert.equal(feeState.height,'18px');assert.equal(feeState.backgroundColor,'rgb(217, 52, 70)');assert.match(feeState.backgroundImage,/svg/u);assert.ok(Number.parseFloat(feeState.outlineWidth)<=3);assert.equal(feeState.parentDisplay,'grid');assert.equal(feeState.parentOutlineWidth,'0px');
    await page.getByRole('button',{name:'生成修改预览',exact:true}).click();
    await page.getByRole('heading',{name:'修改前后滑动对比'}).waitFor();
    assert.equal(submitted.operation,'AI_LOCAL');assert.equal(submitted.mask,undefined);assert.match(submitted.instruction,/画面左下角/u);
    assert.equal(submitted.confirmation,'LIVE_IMAGE_COST_ACCEPTED');assert.equal(actions.length,0);
    assert.equal(await page.getByRole('status').getByText('系统正在处理',{exact:false}).count(),1);
    assert.equal(await page.getByRole('button',{name:'采用此版本',exact:true}).isDisabled(),false);
    await page.getByRole('button',{name:'采用此版本',exact:true}).click();
    await page.getByRole('alert').getByText('请先填写“操作原因”',{exact:false}).waitFor();
    assert.equal(actions.length,0);
    await page.getByLabel('采用拒绝重试原因').fill('预览确认');await page.getByRole('button',{name:'采用此版本',exact:true}).click();
    await page.getByText('局部修改 · 已采用',{exact:true}).waitFor();assert.equal(actions.length,1);assert.match(actions[0].data.requestId,/^[a-f0-9-]{36}$/);
    submitted=null;await page.getByRole('tab',{name:'实体替换'}).click();
    assert.equal(await page.getByLabel('参考图来源说明').count(),0);
    assert.equal(await page.getByText('精确合成',{exact:true}).count(),0);
    const uploadInput=page.getByLabel('上传真实产品参考图'),uploadPicker=uploadInput.locator('..');
    const [uploadBox,uploadStyle,inputStyle]=await Promise.all([
      uploadPicker.boundingBox(),
      uploadPicker.evaluate(element=>({borderStyle:getComputedStyle(element).borderStyle,borderWidth:getComputedStyle(element).borderWidth,backgroundColor:getComputedStyle(element).backgroundColor})),
      uploadInput.evaluate(element=>({opacity:getComputedStyle(element).opacity,position:getComputedStyle(element).position})),
    ]);
    assert.ok(uploadBox&&uploadBox.height>=100,JSON.stringify({uploadBox,uploadStyle}));
    assert.equal(uploadStyle.borderStyle,'dashed');assert.equal(uploadStyle.borderWidth,'2px');assert.notEqual(uploadStyle.backgroundColor,'rgba(0, 0, 0, 0)');
    assert.deepEqual(inputStyle,{opacity:'0',position:'absolute'});
    assert.equal(await page.getByText('点击选择产品图片',{exact:true}).count(),1);
    assert.equal(await page.getByText('PNG / JPG / WebP · 最大 5 MB',{exact:true}).count(),1);
    await uploadInput.setInputFiles({name:'reference.png',mimeType:'image/png',buffer:png});
    await page.getByRole('img',{name:'已上传的真实产品参考图',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'生成修改预览',exact:true}).isDisabled(),false);
    await page.getByRole('button',{name:'生成修改预览',exact:true}).click();
    await page.getByRole('alert').getByText('请填写需要替换的目标物品说明',{exact:false}).waitFor();
    assert.equal(submitted,null);
    await page.getByLabel('目标物品说明').fill('画面右侧台面上、木托盘后方的米白色拿铁杯');
    await page.getByRole('button',{name:'生成修改预览',exact:true}).click();
    await page.getByRole('alert').getByText('请在左侧原图上拖动框选',{exact:false}).waitFor();
    assert.equal(submitted,null);
    const targetCanvas=page.getByRole('img',{name:'实时修改预览'}),targetBox=await targetCanvas.boundingBox();
    assert.ok(targetBox);
    await page.mouse.move(targetBox.x+targetBox.width*.62,targetBox.y+targetBox.height*.42);
    await page.mouse.down();
    await page.mouse.move(targetBox.x+targetBox.width*.88,targetBox.y+targetBox.height*.68,{steps:5});
    await page.mouse.up();
    await page.getByRole('status').getByText('已框选',{exact:false}).waitFor();
    assert.equal(await page.getByRole('button',{name:'重新框选',exact:true}).isDisabled(),false);
    await page.getByLabel('确认调用图片编辑与实体校验模型，会产生费用；自动修复和人工重试也可能收费。').check();
    await page.getByRole('button',{name:'生成修改预览',exact:true}).click();
    assert.equal(submitted.operation,'AI_FUSION');assert.deepEqual(submitted.references,[{assetId:9,purpose:'真实产品替换'}]);assert.equal(submitted.mask,undefined);
    assert.equal(submitted.target.description,'画面右侧台面上、木托盘后方的米白色拿铁杯');
    assert.ok(submitted.target.region.width>24&&submitted.target.region.height>24);
    assert.match(submitted.instruction,/木托盘后方/u);
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();if(server)await new Promise(r=>server.close(r));assert.ok(resolve(root).startsWith(resolve(tmpdir())));await rm(root,{recursive:true,force:true});}
});
