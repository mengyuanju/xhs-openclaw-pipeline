import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

for(const standalone of [false,true]) {
  test(`${standalone?'standalone':'task'} text repair editor: paragraph selection, multiple locations, live reference preview and adoption`,
    {skip:process.env.RUN_IMAGE_EDIT_BROWSER!=='1',timeout:90000},()=>runTextRepairEditor(standalone));
  test(`${standalone?'standalone':'task'} text repair editor: failed preview can be manually adopted with reason and explicit confirmation`,
    {skip:process.env.RUN_IMAGE_EDIT_BROWSER!=='1',timeout:90000},()=>runTextRepairEditor(standalone,{manualAdoption:true}));
}

test('text repair progress shows concrete failure details before generic messages and escapes model text',
  {skip:process.env.RUN_IMAGE_EDIT_BROWSER!=='1',timeout:45000},async()=>{
  const {build}=await import('esbuild'),{chromium}=await import('playwright-core');
  const directory=await mkdtemp(join(tmpdir(),'text-repair-details-'));let server,browser;
  const referenceReason='图中文字可辨为鼬，但左侧“鼠”部件缺少规范笔画，字形不准确。';
  const locationReason='目标字底部横线与中竖粘连。<script>window.repairFailureInjected=true</script>';
  const referenceMessage='“鼬”参考字形未通过检查，请重新生成参考图';
  const locationMessage='替换后的文字字形或样式未通过检查';
  const progressMessage='正在按失败原因修正参考图';
  const items=[{id:'failed',correctText:'鼬',contextText:'',region:null},{id:'working',correctText:'滩',contextText:'',region:null},
    {id:'malformed',correctText:'撬',contextText:'',region:null}];
  const state={references:[
    {text:'鼬',status:'FAILED',message:referenceMessage,validation:{passed:false,reason:referenceReason}},
    {text:'滩',status:'FAILED',message:'参考字形未通过检查',validation:{passed:false,reason:'  '}},
    {text:'撬',status:'FAILED',message:'参考字形详情不可用，请重新检查',validation:{passed:false,reason:{detail:'不应渲染的对象'}}},
  ],locations:[
    {id:'failed',correctText:'鼬',status:'FAILED',message:locationMessage,validation:{passed:false,reason:locationReason}},
    {id:'working',correctText:'滩',status:'REPAIRING',message:progressMessage,validation:{passed:false,reason:'旧失败原因'}},
    {id:'malformed',correctText:'撬',status:'FAILED',message:'局部校验未通过，请重试',validation:{passed:false,reason:42}},
  ]};
  try {
    await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{TextRepairProgress}from'./app/components/image-text-repair-panel';window.regenerationRequests=[];createRoot(document.getElementById('root')).render(<TextRepairProgress state={${JSON.stringify(state)}} items={${JSON.stringify(items)}} sourceUrl="/source.png" assetUrl={value=>value} status="FAILED" attempts={1} onRegenerate={text=>window.regenerationRequests.push(text)}/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,outfile:join(directory,'bundle.js'),jsx:'automatic',platform:'browser',alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"test"'}});
    const js=await readFile(join(directory,'bundle.js'));
    server=createServer((req,res)=>{
      if(req.url==='/bundle.js'){res.setHeader('content-type','application/javascript');res.end(js);return;}
      res.setHeader('content-type','text/html');res.end('<html><meta charset="utf-8"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
    });
    await new Promise(done=>server.listen(0,'127.0.0.1',done));
    browser=await chromium.launch({headless:true,channel:process.env.IMAGE_EDIT_BROWSER_CHANNEL??'msedge'});
    const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
    const reference=page.getByRole('region',{name:'文字 鼬 的参考图',exact:true});
    await reference.getByText(referenceReason,{exact:true}).waitFor();
    assert.equal(await reference.getByText(referenceMessage,{exact:true}).count(),0,'generic status must not mask the actual reference failure');
    const location=page.getByRole('region',{name:'第 1 处修正结果',exact:true});
    assert.equal(await location.getByText(locationReason,{exact:true}).count(),1);
    assert.equal(await location.getByText(locationMessage,{exact:true}).count(),0,'local failures also show the actual check reason');
    assert.equal(await location.locator('script').count(),0,'model text remains plain React text');
    assert.equal(await page.evaluate(()=>window.repairFailureInjected),undefined);
    await page.getByRole('region',{name:'文字 滩 的参考图',exact:true}).getByText('参考字形未通过检查',{exact:true}).waitFor();
    await page.getByRole('region',{name:'文字 撬 的参考图',exact:true}).getByText('参考字形详情不可用，请重新检查',{exact:true}).waitFor();
    assert.equal(await page.getByRole('region',{name:'第 3 处修正结果',exact:true}).getByText('局部校验未通过，请重试',{exact:true}).count(),1,'nonstring reasons fall back without rendering untrusted objects');
    assert.equal(await page.getByText('不应渲染的对象',{exact:true}).count(),0);
    const working=page.getByRole('region',{name:'第 2 处修正结果',exact:true});
    assert.equal(await working.getByText(progressMessage,{exact:true}).count(),1,'current progress takes precedence over a previous failed check');
    assert.equal(await working.getByText('旧失败原因',{exact:true}).count(),0);
    assert.deepEqual(await page.evaluate(()=>window.regenerationRequests),[],'rendering a failure must not start a paid retry');
    const regenerate=reference.getByRole('button',{name:'重新生成此参考并重做关联位置',exact:true});
    assert.equal(await regenerate.isDisabled(),true);
    await page.getByLabel('确认重新生成参考及关联修正会再次调用模型并产生费用。',{exact:true}).check();
    await regenerate.click();assert.deepEqual(await page.evaluate(()=>window.regenerationRequests),['鼬']);
  } finally {await browser?.close();if(server)await new Promise(done=>server.close(done));await rm(directory,{recursive:true,force:true});}
});

async function runTextRepairEditor(standalone,{manualAdoption=false}={}) {
  const {build}=await import('esbuild'),{chromium}=await import('playwright-core');
  const directory=await mkdtemp(join(tmpdir(),'text-repair-editor-'));
  const runId=randomUUID();let server,browser,edits=[],submitted,regeneration,adoption;
  const source=await sharp({create:{width:1086,height:1448,channels:4,background:'#ecf2ec'}}).png().toBuffer();
  const patch=await sharp({create:{width:30,height:42,channels:4,background:'#ffffff'}}).png().toBuffer();
  try {
    const component=standalone?'StandaloneImageEditor':'CurrentImageEditor';
    await build({stdin:{contents:`import './app/globals.css';import React from 'react';import{createRoot}from'react-dom/client';import{ConfirmDialogProvider}from'./components/ui/confirm-dialog';import{${component}}from'./app/components/${standalone?'standalone':'current'}-image-editor';createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><${component} taskId={1} runId="${runId}" copyRevisionId={1} asset={{id:1,sha256:'a'.repeat(64),url:'/v1/assets/1'}} page={1} runs={[]} onChanged={async()=>{}} ${standalone?'onSubmitted={()=>{}} onBusyChange={()=>{}} onRunningChange={()=>{}} initialStatus="UPLOADED"':'initialOpen={true}'}/></ConfirmDialogProvider>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,outfile:join(directory,'bundle.js'),jsx:'automatic',platform:'browser',conditions:['style'],alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"test"'}});
    const [js,rawCss]=await Promise.all([readFile(join(directory,'bundle.js')),readFile(join(directory,'bundle.css'),'utf8')]);
    const {default:postcss}=await import('postcss'),{default:tailwind}=await import('@tailwindcss/postcss');
    const {css}=await postcss([tailwind()]).process(rawCss,{from:join(process.cwd(),'app/globals.css')});
    server=createServer(async(req,res)=>{
      if(req.url==='/bundle.js'){res.setHeader('content-type','application/javascript');res.end(js);return;}
      if(req.url==='/bundle.css'){res.setHeader('content-type','text/css');res.end(css);return;}
      if(req.url?.includes('/assets/')){res.setHeader('content-type','image/png');res.end(req.url.endsWith('/11')?patch:source);return;}
      let chunks=[];for await(const chunk of req)chunks.push(chunk);const input=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
      if(req.url==='/checkpoint') {
        const edit=edits[0];edit.version+=1;
        if(input.phase==='REFERENCES')edit.textRepairState.references=[{text:'滩',status:'READY',url:'/v1/assets/10',assetId:10,validation:{passed:true}},{text:'鼬',status:'READY',url:'/v1/assets/12',assetId:12,validation:{passed:true}}];
        else {edit.status=input.phase==='FAILED_NO_RESULT'?'FAILED':input.phase;edit.result=input.phase==='FAILED_NO_RESULT'?null:{asset_id:20,image_run_id:randomUUID(),validation:{passed:input.phase==='PREVIEW_READY'}};edit.textRepairState.locations=edit.config.textRepairs.map((item,index)=>({id:item.id,correctText:item.correctText,status:edit.status==='FAILED'&&index===1?'FAILED':'COMPLETED',rect:{x:180,y:310,width:30,height:42},assetId:11,url:'/v1/assets/11',...(edit.status==='FAILED'&&index===1?{message:'错字位置仍不明确',validation:{passed:false}}:{validation:{passed:true}})}));}
        res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true}));return;
      }
      if(req.url?.startsWith('/api/')) {
        const pathname=new URL(req.url,'http://fixture').pathname;let result;
        if(pathname.endsWith('/image-edits/state')) {const items=edits.map(({id,status,version})=>({id,status,version,target_page:1,task_id:1}));result={status:edits[0]?.status??'UPLOADED',signature:JSON.stringify(items),items};}
        else if(req.method==='GET')result=edits;
        else if(pathname.endsWith('/regenerate-reference')) {regeneration=input;edits[0].status='QUEUED';edits[0].version+=1;result=edits[0];}
        else if(pathname.endsWith('/accept')) {adoption=input;edits[0].status='ACCEPTED';edits[0].version+=1;result=edits[0];}
        else {submitted=input;edits=[{id:randomUUID(),version:1,attempts:1,status:'RUNNING',operation:input.operation,source_asset_id:1,target_page:1,created_by:'operator',config:input,textRepairState:{references:[],locations:[]},result:null}];result=edits[0];}
        res.setHeader('content-type','application/json');res.end(JSON.stringify({data:result}));return;
      }
      res.setHeader('content-type','text/html');res.end('<html><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><style>[data-slot="dialog-content"]{translate:-50% -50%}</style><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
    });
    await new Promise(done=>server.listen(0,'127.0.0.1',done));
    browser=await chromium.launch({headless:true,channel:process.env.IMAGE_EDIT_BROWSER_CHANNEL??'msedge'});
    const page=await browser.newPage({viewport:{width:1280,height:940}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('tab',{name:'修正错字',exact:true}).click();
    const submit=page.getByRole('button',{name:standalone?'保存并修正错字':'生成参考并修正错字',exact:true});
    await submit.click();await page.getByRole('alert').filter({hasText:'请填写第 1 处正确文字'}).waitFor();
    assert.equal(submitted,undefined);
    await page.getByLabel('第 1 处正确文字',{exact:true}).fill('滩');
    await page.getByLabel('第 1 处正确词句',{exact:true}).fill('海滩开放信息');
    await submit.click();await page.getByRole('alert').filter({hasText:'请在原图框选第 1 处'}).waitFor();
    const preview=page.getByRole('img',{name:'实时修改预览',exact:true});
    async function draw(rect) {
      await preview.scrollIntoViewIfNeeded();const box=await preview.boundingBox();
      await page.mouse.move(box.x+rect.x*box.width/1086,box.y+rect.y*box.height/1448);await page.mouse.down();
      await page.mouse.move(box.x+(rect.x+rect.width)*box.width/1086,box.y+(rect.y+rect.height)*box.height/1448,{steps:4});await page.mouse.up();
    }
    const regions=[{x:100,y:300,width:550,height:110},{x:90,y:520,width:600,height:120},{x:100,y:300,width:550,height:110}];
    await draw(regions[0]);
    await page.getByRole('button',{name:'添加另一处错字',exact:true}).click();
    await page.getByLabel('第 2 处正确文字',{exact:true}).fill('滩');await draw(regions[1]);
    await page.getByRole('button',{name:'添加另一处错字',exact:true}).click();
    await page.getByLabel('第 3 处正确文字',{exact:true}).fill('鼬');await draw(regions[2]);
    assert.equal(await preview.locator('svg rect').count(),3);
    await page.getByLabel('确认生成文字参考图、修正图片并进行视觉校验会调用模型并产生费用；完成后检查参考图和修改预览再采用。',{exact:true}).check();
    await submit.click();
    await page.getByRole('region',{name:'文字参考与修正进度',exact:true}).waitFor();
    assert.equal(submitted.operation,'AI_TEXT_REPAIR');assert.equal(submitted.confirmation,'LIVE_IMAGE_COST_ACCEPTED');assert.deepEqual(submitted.references,[]);
    assert.deepEqual(submitted.textRepairs.map(item=>item.correctText),['滩','滩','鼬']);
    assert.equal(new Set(submitted.textRepairs.map(item=>item.id)).size,3);
    for(const [index,item]of submitted.textRepairs.entries())for(const key of ['x','y','width','height'])assert.ok(Math.abs(item.region[key]-regions[index][key])<=3,JSON.stringify(item.region));
    async function checkpoint(phase) {
      await page.request.post(`http://127.0.0.1:${server.address().port}/checkpoint`,{data:{phase}});
      await page.evaluate(()=>window.dispatchEvent(new CustomEvent('xhs:workspace-updated',{detail:{scopes:['image-edits','image-editor'],taskIds:[1]}})));
    }
    await checkpoint('REFERENCES');
    await page.getByRole('img',{name:'模型生成的 滩 字形参考图',exact:true}).waitFor();
    assert.equal(await page.getByRole('img',{name:'模型生成的 滩 字形参考图',exact:true}).count(),1,'two identical targets share one displayed reference');
    assert.equal(await page.getByRole('img',{name:'模型生成的 鼬 字形参考图',exact:true}).count(),1);
    assert.equal(edits[0].status,'RUNNING','references are visible before repair completes');
    await checkpoint('PREVIEW_READY');
    await page.getByRole('img',{name:'第 1 处修改前',exact:true}).waitFor();
    assert.equal(await page.getByRole('img',{name:'第 1 处修改前',exact:true}).getAttribute('viewBox'),'180 310 30 42');
    assert.equal(await page.getByRole('img',{name:'第 1 处修改后',exact:true}).count(),1);
    if(standalone) {
      await page.reload();await page.getByRole('img',{name:'模型生成的 滩 字形参考图',exact:true}).waitFor();
      assert.equal(await page.getByRole('tab',{name:'修正错字',exact:true}).getAttribute('aria-selected'),'true');
      assert.equal(await page.getByLabel('第 1 处正确文字',{exact:true}).inputValue(),'滩');
      assert.equal(await page.getByRole('button',{name:'保存草稿',exact:true}).count(),0);
    }
    if(manualAdoption) {
      await checkpoint('FAILED_NO_RESULT');await page.getByText('错字位置仍不明确',{exact:true}).waitFor();
      await page.getByRole('tab',{name:standalone?/^编辑记录/u:/^任务记录/u}).click();
      assert.equal(await page.getByRole('button',{name:'仍采用此结果',exact:true}).count(),0,'a failed request without a full image cannot be adopted');
      assert.equal(await page.getByRole('link',{name:'打开结果',exact:true}).count(),0);
      await page.getByRole('tab',{name:'本次编辑',exact:true}).click();
    }
    await checkpoint('FAILED');await page.getByText('错字位置仍不明确',{exact:true}).waitFor();
    await page.getByRole('button',{name:'失败结果',exact:true}).waitFor();
    await page.getByRole('tab',{name:standalone?/^编辑记录/u:/^任务记录/u}).click();
    assert.equal(await page.getByRole('button',{name:'采用此版本',exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'仍采用此结果',exact:true}).count(),1);
    assert.equal(await page.getByRole('button',{name:'重试未完成的位置（可能再次收费）',exact:true}).count(),1);
    if(manualAdoption) {
      assert.equal(await page.getByRole('img',{name:'第 2 处修改后',exact:true}).count(),1,'failed patch remains visible for manual inspection');
      assert.equal(await page.getByRole('img',{name:'模型生成的 滩 字形参考图',exact:true}).count(),1);
      await page.getByRole('button',{name:'失败结果',exact:true}).click();
      await page.getByRole('img',{name:'修改结果预览',exact:true}).waitFor();
      await page.getByRole('button',{name:'仍采用此结果',exact:true}).click();
      await page.getByRole('button',{name:'确认仍采用此结果',exact:true}).click();
      await page.getByRole('alert').filter({hasText:'请先填写“操作原因”'}).waitFor();
      assert.equal(adoption,undefined,'an empty reason never submits acceptance');
      const reason='已对照原图和字形参考检查，人工确认采用';
      await page.getByLabel('仍采用此结果操作原因',{exact:true}).fill(reason);
      await page.getByRole('button',{name:'确认仍采用此结果',exact:true}).click();
      await page.getByRole('alertdialog').getByRole('button',{name:'取消',exact:true}).click();
      assert.equal(adoption,undefined,'cancelling explicit confirmation never submits acceptance');
      await page.getByRole('button',{name:'确认仍采用此结果',exact:true}).click();
      const acceptResponse=page.waitForResponse(response=>response.url().endsWith('/accept')&&response.request().method()==='POST');
      await page.getByRole('alertdialog').getByRole('button',{name:'仍然采用',exact:true}).click();await acceptResponse;
      assert.equal(adoption.version,5);assert.equal(adoption.acceptRejectedResult,true);assert.equal(adoption.reason,reason);
      assert.equal(edits[0].status,'ACCEPTED');assert.equal(edits[0].result.validation.passed,false,'manual adoption preserves failed automatic validation');
      await page.getByText('该结果已由用户明确采用，审计记录已保留。',{exact:true}).waitFor();
      await page.getByText('修正错字 · 已人工采用 · 自动验收未通过',{exact:true}).waitFor();
      assert.deepEqual(errors,[]);return;
    }
    await page.getByRole('tab',{name:'本次编辑',exact:true}).click();
    await page.getByLabel('确认重新生成参考及关联修正会再次调用模型并产生费用。',{exact:true}).check();
    const regenerateResponse=page.waitForResponse(response=>response.url().endsWith('/regenerate-reference')&&response.request().method()==='POST');
    await page.getByRole('button',{name:'重新生成此参考并重做关联位置',exact:true}).first().click();
    await regenerateResponse;
    assert.equal(regeneration.text,'滩');assert.equal(regeneration.confirmation,'LIVE_IMAGE_COST_ACCEPTED');assert.equal(regeneration.version,4);
    await checkpoint('REFERENCES');await checkpoint('PREVIEW_READY');
    await page.getByRole('img',{name:'第 1 处修改后',exact:true}).waitFor();
    await page.waitForFunction(()=>document.querySelector('[aria-label="文字参考与修正进度"]')?.getAttribute('data-status')==='PREVIEW_READY');
    if(!standalone) {
      const output=resolve('output');await mkdir(output,{recursive:true});
      await page.getByRole('region',{name:'文字参考与修正进度',exact:true}).getByText('模型生成的文字参考图',{exact:true}).scrollIntoViewIfNeeded();
      await page.screenshot({path:join(output,'text-repair-ui-desktop.png'),animations:'disabled'});
      await page.setViewportSize({width:420,height:880});
      await page.getByRole('tablist',{name:'移动端工作区',exact:true}).getByRole('tab',{name:'编辑',exact:true}).click();
      await page.getByRole('region',{name:'文字参考与修正进度',exact:true}).getByText('模型生成的文字参考图',{exact:true}).scrollIntoViewIfNeeded();
      await page.screenshot({path:join(output,'text-repair-ui-mobile.png'),animations:'disabled'});
      await page.setViewportSize({width:1280,height:940});
    }
    await page.getByRole('tab',{name:standalone?/^编辑记录/u:/^任务记录/u}).click();
    await page.getByRole('button',{name:'采用此版本',exact:true}).click();
    await page.getByLabel('采用此版本操作原因',{exact:true}).fill('参考字形与各处修正均已检查');
    const acceptResponse=page.waitForResponse(response=>response.url().endsWith('/accept')&&response.request().method()==='POST');
    await page.getByRole('button',{name:'确认采用此版本',exact:true}).click();await acceptResponse;
    assert.equal(adoption.version,7,'adoption uses the newest version after reference and location checkpoints');
    assert.equal(edits[0].status,'ACCEPTED');
    assert.deepEqual(errors,[]);
  } finally {await browser?.close();if(server)await new Promise(done=>server.close(done));await rm(directory,{recursive:true,force:true});}
}
