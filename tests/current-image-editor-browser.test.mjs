import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { localEditAlternatives } from '../src/local-edit-alternatives.mjs';

test('image editor browser: prompt-localized edit, multi-page product replacement, preview and explicit acceptance',{skip:process.env.RUN_IMAGE_EDIT_BROWSER!=='1',timeout:75000},async()=>{
  const {build}=await import('esbuild'),{chromium}=await import('playwright-core');
  const root=await mkdtemp(join(tmpdir(),'image-edit-browser-')),bundle=join(root,'bundle.js'),stylesheet=join(root,'bundle.css');
  const runId=randomUUID(),editId=randomUUID(),failedEditId=randomUUID();let edits=[],submitted=null,submissions=[],actions=[];
  const png=await sharp({create:{width:1086,height:1448,channels:4,background:'#eeeeee'}}).png().toBuffer();
  let browser,server;
  try{
    await build({stdin:{contents:`import './app/globals.css';import React from 'react';import{createRoot}from'react-dom/client';import{ConfirmDialogProvider}from'./components/ui/confirm-dialog';import{CurrentImageEditor}from'./app/components/current-image-editor';const assets=[1,2,3].map(id=>({id,sha256:String.fromCharCode(96+id).repeat(64),url:'/v1/assets/'+id}));createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><CurrentImageEditor taskId={1} runId="${runId}" copyRevisionId={1} asset={assets[0]} assets={assets} page={1} runs={[]} onChanged={async()=>{}}/></ConfirmDialogProvider>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,outfile:bundle,jsx:'automatic',platform:'browser',conditions:['style'],alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"test"'}});
    const [js,rawCss]=await Promise.all([readFile(bundle),readFile(stylesheet,'utf8')]);
    const {default:postcss}=await import('postcss'), {default:tailwind}=await import('@tailwindcss/postcss');
    const {css}=await postcss([tailwind()]).process(rawCss,{from:join(process.cwd(),'app/globals.css')});
    server=createServer(async(req,res)=>{
      if(req.url==='/bundle.js'){res.setHeader('content-type','application/javascript');res.end(js);return;}
      if(req.url==='/bundle.css'){res.setHeader('content-type','text/css');res.end(css);return;}
      if(req.url?.includes('/assets/')){res.setHeader('content-type','image/png');res.end(png);return;}
      if(req.url==='/inject-rejected'&&req.method==='POST'){
        edits=[{id:failedEditId,version:3,status:'FAILED',operation:'AI_LOCAL',source_asset_id:1,target_page:1,created_by:'operator',
          config:{instruction:'把右下角汤勺移动到锅的左侧，并保持少量老抽倒入锅内',confirmation:'LIVE_IMAGE_COST_ACCEPTED'},
          error:'局部修改结果未通过验收：汤勺被删除但没有在左侧重新出现',
          result:{asset_id:17,image_run_id:randomUUID(),validation:{stage:'LOCAL_EDIT_RESULT',passed:false,billedImageGeneration:true,
            localConsistency:{passed:false,reason:'汤勺被删除，但没有在左侧重新出现，也没有形成老抽倒入锅内的接触关系。',
              repairableFromRejected:true,failureCodes:['DESTINATION_OBJECT_MISSING','POUR_CONTACT_MISSING'],
              repairInstruction:'只在锅左侧补生成半勺老抽的汤勺，并让连续液流落入锅内',repairRegions:[{x:430,y:810,width:340,height:540}],repairAttempt:0,repairMaxAttempts:2}}}},
          ...edits.filter(edit=>edit.id!==failedEditId)];
        res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true}));return;
      }
      if(req.url?.startsWith('/api/')){
        let body='';for await(const chunk of req)body+=chunk;
        const data=body?JSON.parse(body):null;
        if(req.method==='POST'&&req.url.endsWith('/image-edit-references')){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:{id:9,sha256:'b'.repeat(64),url:'/v1/assets/9'}}));return;}
        let response;
        if(req.method==='POST'&&req.url.endsWith('/image-edits')){submitted=data;submissions.push(data);const needsSuggestion=!data.draft&&data.operation==='AI_LOCAL'&&data.instruction.includes('一勺老抽');const suggestion=needsSuggestion?{stage:'LOCAL_EDIT_SUGGESTION',decision:'SUGGEST',canEdit:true,confidence:.96,candidateCount:1,operationType:'MOVE',targetDescription:'右下角汤勺和液流',touchesImageEdge:true,sourceRegion:{x:910,y:965,width:176,height:483},destinationRegion:{x:470,y:850,width:260,height:460},editRegions:[{x:890,y:940,width:196,height:508},{x:430,y:810,width:340,height:540}],suggestedInstruction:'将右下角汤勺和液流移动到锅的左侧，把勺中老抽减少为半勺，保持液流落入锅内并自然修复原位置；不要修改文字和其他内容。',reason:'目标唯一，但原说明需要明确落点与原位置修复。'}:null;const row={id:data.batchId?randomUUID():editId,version:1,status:needsSuggestion?'FAILED':data.draft?'DRAFT':'PREVIEW_READY',operation:data.operation,source_asset_id:data.sourceAssetId,target_page:data.targetPage,config:{instruction:data.instruction,confirmation:data.confirmation,batchId:data.batchId,batchSize:data.batchSize},...(needsSuggestion?{validation:suggestion,error:'已生成更适合图片编辑的描述，请确认采用后再调用图片编辑模型'}:data.draft?{}:{result:{asset_id:data.sourceAssetId+10+submissions.length,image_run_id:randomUUID(),validation:{passed:true}}})};edits=data.batchId?[row,...edits]:[row];response=row;}
        else if(req.method==='POST'){actions.push({url:req.url,data});const targetId=req.url.split('/').at(-2);edits=edits.map(e=>e.id===targetId?{...e,status:req.url.endsWith('/accept')?'ACCEPTED':req.url.endsWith('/apply-suggestion')||req.url.endsWith('/retry')?'QUEUED':'CANCELLED',version:e.version+1,...(req.url.endsWith('/apply-suggestion')?{config:{...e.config,instruction:localEditAlternatives(e).find(option=>option.id===data.suggestionId).instruction}}:{})}:e);response=edits.find(e=>e.id===targetId);}
        res.setHeader('content-type','application/json');res.end(JSON.stringify({data:req.method==='GET'?edits:response}));return;
      }
      res.setHeader('content-type','text/html');res.end('<html><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><style>[data-slot="dialog-content"]{translate:-50% -50%}</style><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    browser=await chromium.launch({headless:true,channel:process.env.IMAGE_EDIT_BROWSER_CHANNEL??'msedge'});
    const page=await browser.newPage({viewport:{width:1010,height:878}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button',{name:'修改图片',exact:true}).click();
    const dialog=page.getByRole('dialog');
    await dialog.evaluate(element=>Promise.all(element.getAnimations().map(animation=>animation.finished)));
    const livePreview=page.getByRole('img',{name:'实时修改预览'}),sourceImage=livePreview.locator('img');
    const previewRegion=page.getByRole('region',{name:'图片预览'}),workspace=previewRegion.locator('..');
    const [dialogBox,previewBox,settingsBox,dialogStyle,overlayStyle,bodyOverflow,panelOverflow]=await Promise.all([
      dialog.boundingBox(),
      previewRegion.boundingBox(),
      page.getByRole('region',{name:'图片修改设置'}).boundingBox(),
      dialog.evaluate(element=>({display:getComputedStyle(element).display,overflow:getComputedStyle(element).overflow,zIndex:getComputedStyle(element).zIndex,position:getComputedStyle(element).position,left:getComputedStyle(element).left,top:getComputedStyle(element).top,translate:getComputedStyle(element).translate,transform:getComputedStyle(element).transform})),
      page.locator('[data-slot="dialog-overlay"]').evaluate(element=>({position:getComputedStyle(element).position,zIndex:getComputedStyle(element).zIndex})),
      workspace.locator('..').evaluate(element=>getComputedStyle(element).overflow),
      page.getByRole('region',{name:'本次编辑'}).evaluate(element=>getComputedStyle(element).overflowY),
    ]);
    assert.ok(dialogBox&&dialogBox.width<=1120&&dialogBox.height<=900&&dialogBox.x>=0&&dialogBox.y>=0&&dialogBox.x+dialogBox.width<=1010&&dialogBox.y+dialogBox.height<=878,JSON.stringify({dialogBox,dialogStyle}));
    assert.ok(previewBox&&settingsBox&&previewBox.x+previewBox.width<settingsBox.x);
    assert.equal(dialogStyle.display,'grid');assert.equal(dialogStyle.overflow,'hidden');assert.equal(dialogStyle.zIndex,'141');assert.equal(dialogStyle.translate,'-50% -50%');assert.equal(dialogStyle.transform,'none');
    assert.deepEqual(overlayStyle,{position:'fixed',zIndex:'140'});
    assert.equal(bodyOverflow,'hidden');assert.equal(panelOverflow,'auto');
    const [sourceNode,sourceBox,previewGutter]=await Promise.all([
      sourceImage.elementHandle(),sourceImage.boundingBox(),
      livePreview.locator('..').evaluate(element=>getComputedStyle(element).scrollbarGutter),
    ]);
    assert.match(previewGutter,/stable/u);
    assert.equal(await page.getByLabel('人工生成标识文字',{exact:true}).inputValue(),'该人物形象由AI生成');
    assert.equal(await page.getByLabel('最近常用标识文字').getByText('成功提交后会在这里保留最近使用的 5 条。',{exact:true}).count(),1);
    await page.getByLabel('人工生成标识文字',{exact:true}).fill('人工生成');
    assert.equal(await livePreview.locator('svg text').textContent(),'人工生成');
    assert.ok(sourceNode&&await sourceImage.evaluate((element,previous)=>element===previous,sourceNode));
    assert.deepEqual(await sourceImage.boundingBox(),sourceBox);
    assert.equal(await page.getByLabel('文本类型').count(),0);
    assert.equal(await page.getByLabel('字号').count(),0);
    assert.equal(await page.getByRole('button',{name:'图片模型融合',exact:true}).getAttribute('aria-pressed'),'true');
    await page.getByRole('button',{name:'程序叠加（SVG + Sharp）',exact:true}).click();
    assert.equal(await page.getByText('逐像素确认标识区域外没有变化',{exact:false}).count(),1);
    assert.equal(await page.getByText('无需费用确认',{exact:false}).count(),1);
    assert.equal(await page.getByRole('button',{name:'保存草稿',exact:true}).isDisabled(),false);
    assert.equal(await page.getByRole('button',{name:'生成程序标识预览',exact:true}).isDisabled(),false);
    await page.getByRole('button',{name:'保存草稿',exact:true}).click();
    const recentDisclosure=page.getByLabel('最近常用标识文字').getByRole('button',{name:'人工生成',exact:true});
    await recentDisclosure.waitFor();
    assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('xhs.recent-disclosure-texts.v1'))),['人工生成']);
    assert.equal(submitted.operation,'SVG_DISCLOSURE');assert.equal(submitted.overlay.text,'人工生成');assert.equal(submitted.confirmation,undefined);
    submitted=null;
    await page.getByRole('button',{name:'生成程序标识预览',exact:true}).click();
    await page.getByRole('heading',{name:'修改前后滑动对比'}).waitFor();
    assert.equal(submitted.operation,'SVG_DISCLOSURE');assert.equal(submitted.confirmation,undefined);
    await page.getByRole('button',{name:'图片模型融合',exact:true}).click();
    submitted=null;
    assert.equal(await page.getByText('系统会校验文字准确性',{exact:false}).count(),1);
    await page.getByRole('button',{name:'生成模型标识预览',exact:true}).click();
    await page.getByRole('alert').getByText('请先勾选费用确认',{exact:false}).waitFor();
    assert.equal(submitted,null);
    await page.getByRole('tab',{name:'局部修改'}).click();
    assert.equal(await page.getByLabel('选区方式').count(),0);
    assert.equal(await page.getByLabel('选区横坐标').count(),0);
    assert.equal(await page.getByLabel('画笔半径').count(),0);
    await page.getByRole('button',{name:'保存草稿',exact:true}).click();
    await page.getByRole('alert').getByText('请先填写局部修改说明',{exact:false}).waitFor();
    assert.equal(submitted,null);
    const promptBox=await livePreview.boundingBox();assert.ok(promptBox);
    await page.mouse.click(promptBox.x+promptBox.width*.78,promptBox.y+promptBox.height*.22);
    await page.getByRole('status').getByText('已定位：画面右上附近',{exact:true}).waitFor();
    await page.getByRole('button',{name:'改颜色',exact:true}).click();
    await page.getByLabel('图片修改要求').fill('改成鼠尾草绿色，保持其他区域不变');
    await page.getByRole('button',{name:'生成修改预览',exact:true}).click();
    await page.getByRole('alert').getByText('请先勾选费用确认',{exact:false}).waitFor();
    assert.equal(submitted,null);
    const feeCheckbox=page.getByLabel('确认调用图片编辑与视觉验收模型，会产生费用；生成结果需查看并采用后才会替换当前图片。');
    await feeCheckbox.check();
    const feeVisual=page.locator('[data-fee-checkbox]');
    const [feeInputBox,feeBox,feeState]=await Promise.all([feeCheckbox.boundingBox(),feeVisual.boundingBox(),feeCheckbox.evaluate(element=>{const visual=element.nextElementSibling,parent=element.parentElement;return{checked:element.checked,inputOpacity:getComputedStyle(element).opacity,width:getComputedStyle(visual).width,height:getComputedStyle(visual).height,backgroundColor:getComputedStyle(visual).backgroundColor,backgroundImage:getComputedStyle(visual).backgroundImage,outlineWidth:getComputedStyle(visual).outlineWidth,parentDisplay:getComputedStyle(parent).display,parentOutlineWidth:getComputedStyle(parent).outlineWidth};})]);
    assert.ok(feeInputBox&&feeInputBox.width<=1&&feeInputBox.height<=1,JSON.stringify({feeInputBox,feeState}));
    assert.ok(feeBox&&feeBox.width===18&&feeBox.height===18,JSON.stringify({feeBox,feeState}));
    assert.equal(feeState.checked,true);assert.equal(feeState.inputOpacity,'0');assert.equal(feeState.width,'18px');assert.equal(feeState.height,'18px');assert.equal(feeState.backgroundColor,'rgb(217, 52, 70)');assert.match(feeState.backgroundImage,/svg/u);assert.ok(Number.parseFloat(feeState.outlineWidth)<=3);assert.equal(feeState.parentDisplay,'grid');assert.equal(feeState.parentOutlineWidth,'0px');
    await page.getByRole('button',{name:'生成修改预览',exact:true}).click();
    await page.getByRole('heading',{name:'修改前后滑动对比'}).waitFor();
    assert.equal(submitted.operation,'AI_LOCAL');assert.equal(submitted.mask,undefined);assert.match(submitted.instruction,/画面右上附近，改颜色/u);
    assert.equal(submitted.confirmation,'LIVE_IMAGE_COST_ACCEPTED');assert.equal(actions.length,0);
    await page.getByRole('status').getByText('修改请求已提交，可关闭窗口',{exact:false}).waitFor();
    await page.getByRole('button',{name:'关闭提示',exact:true}).click();
    assert.equal(await page.getByRole('status').getByText('修改请求已提交，可关闭窗口',{exact:false}).count(),0);
    assert.equal(await dialog.isVisible(),true,'dismissing feedback keeps the editor open');
    await page.getByRole('tab',{name:/任务记录/u}).click();
    assert.equal(await page.getByRole('button',{name:'采用此版本',exact:true}).isDisabled(),false);
    await page.getByRole('button',{name:'采用此版本',exact:true}).click();
    await page.getByLabel('采用此版本操作原因').waitFor();
    assert.equal(actions.length,0);
    await page.getByLabel('采用此版本操作原因').fill('预览确认');await page.getByRole('button',{name:'确认采用此版本',exact:true}).click();
    await page.getByText('局部修改 · 已采用',{exact:true}).waitFor();assert.equal(actions.length,1);assert.match(actions[0].data.requestId,/^[a-f0-9-]{36}$/);
    await page.getByRole('tab',{name:'本次编辑',exact:true}).click();
    await page.getByLabel('图片修改要求').fill('把画面右下角的一勺老抽变成半勺并移动到左侧');
    await page.getByRole('button',{name:'生成修改预览',exact:true}).click();
    await page.getByRole('tab',{name:/任务记录/u}).click();
    await page.getByText('局部修改 · 待确认建议',{exact:true}).waitFor();
    const suggestions=page.getByRole('region',{name:'局部修改建议'});
    assert.equal(await suggestions.getByRole('radio').count(),3);
    assert.equal(await page.getByRole('button',{name:'采用建议并修改',exact:true}).isDisabled(),true);
    const originalSuggestion=edits[0].config.instruction;
    for(const direction of ['精准限定目标','自然移动与衔接','文字与边缘保护']) {
      await suggestions.getByRole('radio',{name:direction,exact:true}).check();
      assert.ok((await suggestions.getByLabel('所选修改描述').textContent()).startsWith(originalSuggestion));
    }
    await suggestions.getByRole('radio',{name:'自然移动与衔接',exact:true}).check();
    assert.equal(await livePreview.locator('svg rect').count(),2);
    await page.getByRole('button',{name:'采用建议并修改',exact:true}).click();
    await page.getByLabel('采用建议并修改操作原因').fill('采用系统补强的可执行描述');
    await page.getByRole('button',{name:'确认采用建议并修改',exact:true}).click();
    await page.getByText('局部修改 · 排队中',{exact:true}).waitFor();
    const successFeedback=page.getByRole('status').getByText('修复已提交，可关闭窗口；完成或失败后会在“后台任务”中提醒。',{exact:true});
    await successFeedback.waitFor();
    await successFeedback.waitFor({state:'hidden',timeout:3500});
    assert.equal(actions.at(-1).url.endsWith('/apply-suggestion'),true);
    assert.equal(actions.at(-1).data.suggestionId,'natural');
    assert.ok(edits[0].config.instruction.startsWith(originalSuggestion));
    // An older record may contain a clear target but fail the original safety checks.
    const oldFailureInstruction='画面右下附近，去掉框选附近的两件衣服，其他的不用删除';
    edits=[{...edits[0],version:edits[0].version+1,status:'FAILED',result:undefined,attempts:0,
      config:{...edits[0].config,instruction:oldFailureInstruction},
      validation:{stage:'LOCAL_TARGET_LOCALIZATION',decision:'SUGGEST',canEdit:false,confidence:.96,candidateCount:2,
        operationType:'REMOVE',targetDescription:'灰色与浅蓝色两件短袖',checks:{protectedTextExcluded:false},billedImageGeneration:false},
      error:'目标可以确定，需补充背景修复和右下角标签保护要求。'}];
    await page.getByText(oldFailureInstruction,{exact:true}).waitFor({timeout:6000});
    assert.equal(await suggestions.getByRole('radio').count(),3);
    assert.equal(await suggestions.locator('input:checked').count(),0,'a new version requires a fresh choice');
    for(const direction of ['精准移除','自然修补背景','文字与边缘保护']) {
      await suggestions.getByRole('radio',{name:direction,exact:true}).check();
      assert.ok((await suggestions.getByLabel('所选修改描述').textContent()).startsWith(oldFailureInstruction));
    }
    const screenshots=resolve('.codex_artifacts/local-edit-alternatives');
    await mkdir(screenshots,{recursive:true});
    await suggestions.scrollIntoViewIfNeeded();
    await page.screenshot({path:join(screenshots,'desktop.png')});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await suggestions.evaluate(element=>element.scrollWidth>element.clientWidth+1),false,'the choices fit the narrow panel');
    await page.setViewportSize({width:1010,height:878});
    await page.getByRole('button',{name:'采用建议并修改',exact:true}).click();
    assert.equal(await page.getByLabel('采用建议并修改操作原因').inputValue(),'采用「文字与边缘保护」方案');
    await page.getByRole('button',{name:'确认采用建议并修改',exact:true}).click();
    await page.getByText('局部修改 · 排队中',{exact:true}).waitFor();
    assert.equal(actions.at(-1).data.suggestionId,'protected');
    assert.ok(edits[0].config.instruction.startsWith(oldFailureInstruction));
    await page.evaluate(()=>fetch('/inject-rejected',{method:'POST'}));
    await page.getByText('局部修改 · 验收未通过 · 结果已保留',{exact:true}).waitFor({timeout:6000});
    const rejectedCard=page.getByRole('region',{name:'自动验收未通过的结果'});
    await rejectedCard.getByText('图片已生成，但没有完整完成任务',{exact:true}).waitFor();
    assert.equal(await rejectedCard.getByText('再次调用图片模型并产生费用',{exact:false}).count(),1);
    await rejectedCard.getByText('只在锅左侧补生成半勺老抽的汤勺，并让连续液流落入锅内',{exact:true}).waitFor();
    await page.getByRole('button',{name:'基于失败图定向修复（再次收费）',exact:true}).click();
    await page.getByLabel('基于失败图定向修复（再次收费）操作原因').fill('按验收建议只补充缺失内容');
    await page.getByLabel('确认本次定向修复会再次调用图片模型并产生费用').check();
    await page.getByRole('button',{name:'确认基于失败图定向修复（再次收费）',exact:true}).click();
    await page.getByText('局部修改 · 排队中',{exact:true}).waitFor();
    assert.equal(actions.at(-1).url.endsWith('/retry'),true);assert.equal(actions.at(-1).data.useRejectedPreview,true);
    assert.equal(actions.at(-1).data.confirmation,'LIVE_IMAGE_COST_ACCEPTED');
    await page.evaluate(()=>fetch('/inject-rejected',{method:'POST'}));
    await page.getByText('局部修改 · 验收未通过 · 结果已保留',{exact:true}).waitFor({timeout:6000});
    await page.getByRole('button',{name:'在左侧对比',exact:true}).first().click();
    await page.getByRole('alert').getByText('自动验收未通过',{exact:true}).waitFor();
    await page.getByRole('button',{name:'仍采用此结果',exact:true}).click();
    await page.getByLabel('仍采用此结果操作原因').fill('人工检查后可以接受');
    await page.getByRole('button',{name:'确认仍采用此结果',exact:true}).click();
    const rejectedAcceptance=page.getByRole('alertdialog');
    await rejectedAcceptance.getByRole('heading',{name:'仍采用未通过验收的结果？',exact:true}).waitFor();
    await rejectedAcceptance.getByRole('button',{name:'仍然采用',exact:true}).click();
    await page.getByText('局部修改 · 已人工采用 · 自动验收未通过',{exact:true}).waitFor();
    assert.equal(actions.at(-1).data.acceptRejectedResult,true);
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
    // Navigation can load the global select rule after the editor's CSS module.
    // Both options must still be above the editor and receive pointer events.
    const globalSelectRule=rawCss.match(/\.select-content\s*\{[^}]*\}/u)?.[0];
    assert.ok(globalSelectRule);
    await page.addStyleTag({content:globalSelectRule});
    await page.getByRole('combobox',{name:'参考图使用方式',exact:true}).click();
    const referenceMenu=page.getByRole('listbox');
    assert.equal(await referenceMenu.getByRole('option').count(),2);
    const menuZIndex=await referenceMenu.evaluate(element=>Number(getComputedStyle(element).zIndex));
    assert.ok(menuZIndex>Number(dialogStyle.zIndex),`reference options (${menuZIndex}) must be above editor (${dialogStyle.zIndex})`);
    const referenceScreenshots=resolve('.codex_artifacts/reference-mode');
    await mkdir(referenceScreenshots,{recursive:true});
    await page.screenshot({path:join(referenceScreenshots,'desktop-options.png'),animations:'disabled'});
    await page.getByRole('option',{name:'完整产品（严格模式）',exact:true}).click();
    assert.equal(await page.getByRole('combobox',{name:'参考图使用方式',exact:true}).textContent(),'完整产品（严格模式）');
    await page.getByRole('combobox',{name:'参考图使用方式',exact:true}).click();
    await page.getByRole('option',{name:'外观参考（允许手部、裁切或次要产品）',exact:true}).click();
    await page.getByText('只迁移主产品可确认的外观',{exact:false}).waitFor();
    await page.getByRole('combobox',{name:'产品替换范围',exact:true}).click();
    await page.getByRole('option',{name:'替换框内全部同款产品或特写',exact:true}).click();
    await page.getByText('系统会先定位每个匹配目标并生成紧框',{exact:false}).waitFor();
    assert.equal(await page.getByRole('button',{name:'生成修改预览',exact:true}).isDisabled(),false);
    await page.getByRole('button',{name:'生成修改预览',exact:true}).click();
    await page.getByRole('alert').getByText('请填写产品 1 在第 1 页的目标物品说明',{exact:false}).waitFor();
    assert.equal(submitted,null);
    await page.getByLabel('目标物品说明').fill('画面右侧台面上、木托盘后方的米白色拿铁杯');
    await page.getByRole('button',{name:'生成修改预览',exact:true}).click();
    await page.getByRole('alert').getByText('请在左侧第 1 页框选产品 1',{exact:false}).waitFor();
    assert.equal(submitted,null);
    const targetCanvas=page.getByRole('img',{name:'实时修改预览'}),targetBox=await targetCanvas.boundingBox();
    assert.ok(targetBox);
    const targetSource=targetCanvas.locator('img'),targetSourceNode=await targetSource.elementHandle(),targetSourceBox=await targetSource.boundingBox();
    await page.mouse.move(targetBox.x+targetBox.width*.62,targetBox.y+targetBox.height*.42);
    await page.mouse.down();
    await page.mouse.move(targetBox.x+targetBox.width*.88,targetBox.y+targetBox.height*.68,{steps:5});
    await page.mouse.up();
    await page.getByRole('status').getByText('已框选',{exact:false}).waitFor();
    assert.ok(targetSourceNode&&await targetSource.evaluate((element,previous)=>element===previous,targetSourceNode));
    assert.deepEqual(await targetSource.boundingBox(),targetSourceBox);
    assert.equal(await page.getByRole('button',{name:'重新框选',exact:true}).isDisabled(),false);
    await page.getByLabel('确认调用图片编辑与视觉验收模型，会产生费用；生成结果需查看并采用后才会替换当前图片。').check();
    await page.getByRole('button',{name:'生成修改预览',exact:true}).click();
    assert.equal(submitted.operation,'AI_FUSION');assert.deepEqual(submitted.references,[{assetId:9,purpose:'真实产品替换'}]);assert.equal(submitted.mask,undefined);
    assert.equal(submitted.replacements[0].referenceMode,'APPEARANCE');assert.equal(submitted.replacements[0].referenceAssetId,9);
    assert.equal(submitted.replacements[0].targetMode,'ALL_MATCHES');
    assert.equal(submitted.replacements[0].target.description,'画面右侧台面上、木托盘后方的米白色拿铁杯');
    assert.ok(submitted.replacements[0].target.region.width>24&&submitted.replacements[0].target.region.height>24);
    assert.match(submitted.instruction,/木托盘后方/u);
    await page.getByLabel('产品应用图片').getByRole('button').nth(1).click();
    await page.getByLabel('在第 2 页替换这个产品').check();
    await page.getByLabel('产品 1 第 2 页目标物品说明').fill('第 2 页右上角的米白色杯子');
    const pageTwoCanvas=page.getByRole('img',{name:'实时修改预览'}),pageTwoBox=await pageTwoCanvas.boundingBox();
    assert.ok(pageTwoBox);
    await page.mouse.move(pageTwoBox.x+pageTwoBox.width*.62,pageTwoBox.y+pageTwoBox.height*.18);
    await page.mouse.down();await page.mouse.move(pageTwoBox.x+pageTwoBox.width*.86,pageTwoBox.y+pageTwoBox.height*.42,{steps:5});await page.mouse.up();
    await page.getByRole('button',{name:'添加另一个产品',exact:true}).click();
    await page.getByLabel('上传产品 2 参考图').setInputFiles({name:'second-reference.png',mimeType:'image/png',buffer:png});
    await page.getByLabel('产品 2 第 2 页目标物品说明').fill('第 2 页左下角的黑色手表');
    const secondProductCanvas=page.getByRole('img',{name:'实时修改预览'}),secondProductBox=await secondProductCanvas.boundingBox();
    assert.ok(secondProductBox);
    await page.mouse.move(secondProductBox.x+secondProductBox.width*.12,secondProductBox.y+secondProductBox.height*.60);
    await page.mouse.down();await page.mouse.move(secondProductBox.x+secondProductBox.width*.36,secondProductBox.y+secondProductBox.height*.82,{steps:5});await page.mouse.up();
    assert.equal(await secondProductCanvas.locator('svg rect').count(),2);
    const replacementScreenshots=resolve('.codex_artifacts/product-replacement');await mkdir(replacementScreenshots,{recursive:true});
    await page.screenshot({path:join(replacementScreenshots,'multi-page-multi-product.png'),animations:'disabled'});
    const entityBatchStart=submissions.length;
    await page.getByRole('button',{name:'生成 2 张批量替换预览',exact:true}).click();
    await page.getByText('共 2 张产品替换预览已提交',{exact:false}).waitFor();
    const entityBatchSubmissions=submissions.slice(entityBatchStart),entityBatchIds=new Set(entityBatchSubmissions.map(item=>item.batchId));
    assert.equal(entityBatchSubmissions.length,2);assert.equal(entityBatchIds.size,1);
    assert.deepEqual(entityBatchSubmissions.map(item=>item.targetPage),[1,2]);assert.ok(entityBatchSubmissions.every(item=>item.batchSize===2));
    assert.equal(entityBatchSubmissions[0].replacements.length,1);assert.equal(entityBatchSubmissions[1].replacements.length,2);
    assert.equal(entityBatchSubmissions[1].replacements[0].targetMode,'ALL_MATCHES');
    assert.equal(entityBatchSubmissions[1].replacements[1].targetMode,'SINGLE');
    assert.equal(entityBatchSubmissions[1].replacements[0].target.description,'第 2 页右上角的米白色杯子');
    assert.equal(entityBatchSubmissions[1].replacements[1].target.description,'第 2 页左下角的黑色手表');
    await page.getByRole('tab',{name:/任务记录/u}).click();
    await page.getByRole('button',{name:'一次采用全部替换',exact:true}).click();
    const actionsBeforeEntityBatch=actions.length;
    await page.getByLabel('批量替换采用原因').fill('两页产品替换均符合要求');
    await page.getByRole('button',{name:'确认采用',exact:true}).click();
    await page.getByRole('button',{name:'批量替换已采用',exact:true}).waitFor();
    assert.equal(actions.length,actionsBeforeEntityBatch+2);assert.equal(actions.slice(-2).every(item=>item.url.endsWith('/accept')),true);
    await page.getByRole('tab',{name:'添加文字'}).click();
    await page.getByRole('button',{name:'整套 3 张',exact:true}).click();
    await page.getByLabel('确认调用图片编辑与视觉验收模型，会产生费用；生成结果需查看并采用后才会替换当前图片。').check();
    await page.getByRole('button',{name:'生成整套 3 张模型标识预览',exact:true}).click();
    await page.getByRole('tab',{name:/任务记录/u}).click();
    await page.getByRole('button',{name:'一次采用整套标识',exact:true}).waitFor();
    const batchSubmissions=submissions.slice(-3),batchIds=new Set(batchSubmissions.map(item=>item.batchId));
    assert.equal(batchSubmissions.length,3);assert.equal(batchIds.size,1);assert.deepEqual(batchSubmissions.map(item=>item.sourceAssetId),[1,2,3]);assert.deepEqual(batchSubmissions.map(item=>item.targetPage),[1,2,3]);assert.ok(batchSubmissions.every(item=>item.operation==='TEXT'));
    await page.getByRole('button',{name:'一次采用整套标识',exact:true}).click();
    const actionsBeforeBatchAccept=actions.length;
    await page.getByLabel('整套标识采用原因').fill('整套预览确认');
    await page.getByRole('button',{name:'确认采用',exact:true}).click();
    await page.getByRole('button',{name:'整套标识已采用',exact:true}).waitFor();
    assert.equal(actions.length,actionsBeforeBatchAccept+3);assert.equal(actions.slice(-3).every(item=>item.url.endsWith('/accept')),true);
    await page.getByRole('tab',{name:'局部修改'}).click();
    await page.getByRole('button',{name:'保存草稿',exact:true}).click();
    await page.getByRole('tab',{name:/任务记录/u}).click();
    await page.getByText('局部修改 · 草稿',{exact:true}).waitFor();
    const deleteAction=page.getByRole('button',{name:'直接删除此修复',exact:true});
    await deleteAction.waitFor();
    await deleteAction.click();
    await page.getByLabel('直接删除此修复操作原因').fill('草稿不再需要');
    await page.getByRole('button',{name:'确认直接删除此修复',exact:true}).click();
    const deleteConfirmation=page.getByRole('alertdialog');
    await deleteConfirmation.getByRole('heading',{name:'直接删除此修复？',exact:true}).waitFor();
    await deleteConfirmation.getByText('后台仍保留取消记录用于审计。',{exact:false}).waitFor();
    await deleteConfirmation.getByRole('button',{name:'确认直接删除',exact:true}).click();
    await page.getByText('局部修改 · 已取消',{exact:true}).waitFor();
    assert.equal(actions.at(-1).url.endsWith('/cancel'),true);
    await page.getByRole('button',{name:'关闭弹窗',exact:true}).click();
    await dialog.waitFor({state:'hidden'});
    assert.equal(await page.getByRole('button',{name:'修改图片',exact:true}).isVisible(),true);
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();if(server)await new Promise(r=>server.close(r));assert.ok(resolve(root).startsWith(resolve(tmpdir())));await rm(root,{recursive:true,force:true});}
});
