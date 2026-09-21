import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { normalizeManualOverlay, manualOverlaySvg, decodeReference, renderMask, renderRegionsMask, mergeWithMask, changedPixelMask, assertOutsideMask } from '../src/image-edit-pixels.mjs';
import { normalizeEdit,replaceImagePage,editStoragePath,createImageEditingService,resolveImageEditRetry } from '../server/src/image-editing.mjs';
import { disclosurePlacementRegion, parseFusionTargetCheck, processImageEdit } from '../server/src/image-edit-renderer.mjs';

const png=(color='white',width=1086,height=1448)=>sharp({create:{width,height,channels:4,background:color}}).png().toBuffer();
const visionPass=(labels=[])=>({passed:true,model:'fake-vision',layoutMatched:true,ocrConfidence:1,
  ocrMismatches:[],unreadableText:[],recognizedText:{headline:'真实参考',subtitle:'',bullets:[],otherText:labels}});
const localResultPass=()=>({passed:true,reason:'修改完成且未影响无关内容',checks:{requestedChangeCompleted:true,targetCountCorrect:true,
  placementAndRepairNatural:true,movedTargetFullyVisible:true,compositionBalanced:true,protectedTextPreserved:true,unrelatedContentPreserved:true}});
const imageEditPromptContent='管理员统一图片编辑规则：执行 {{reviewInstruction}}，保留所有未要求修改的内容。';
const imageEditPrompt={kind:'IMAGE_EDIT_SYSTEM',name:'图片编辑',versionId:17,version:4,content:imageEditPromptContent,sha256:createHash('sha256').update(imageEditPromptContent).digest('hex'),capturedAt:'2026-09-15T00:00:00.000Z'};
const input=()=>({requestId:randomUUID(),sourceImageRunId:randomUUID(),sourceAssetId:1,copyRevisionId:1,sha256:'a'.repeat(64),targetPage:1,operation:'TEXT',confirmation:'LIVE_IMAGE_COST_ACCEPTED',overlay:{text:'AI生成',textType:'AI_DISCLOSURE',disclosureType:'AI_GENERATED'}});
test('AI text layout contract is escaped, typed, and stays inside the safe area',()=>{
  const config=normalizeManualOverlay({text:'AI生成·真实参考',textType:'LABEL',position:'top-left'});
  assert.equal(config.text,'AI生成·真实参考');assert.equal(config.textType,'LABEL');assert.ok(config.x>=32&&config.y>=32);
  assert.match(manualOverlaySvg({text:'<真实&参考>'}),/&lt;真实&amp;参考&gt;/u);
  assert.throws(()=>normalizeManualOverlay({text:'汉'.repeat(48),size:100}));
  assert.throws(()=>normalizeManualOverlay({text:'测试',position:'custom',x:1080,y:10}));
  assert.throws(()=>normalizeManualOverlay({text:'测试',color:'url(file:///secret)'}));
  assert.throws(()=>normalizeManualOverlay({text:'AI生成',textType:'AI_DISCLOSURE'}),/合规标识/u);
  assert.throws(()=>normalizeManualOverlay({text:'人工 生成',textType:'AI_DISCLOSURE',disclosureType:'AI_GENERATED'}),/人工生成标识/u);
  assert.throws(()=>normalizeManualOverlay({text:'人工生成标识文字已经明显过长',textType:'AI_DISCLOSURE',disclosureType:'AI_GENERATED'}),/人工生成标识/u);
  const request=normalizeEdit({...input(),overlay:{text:'人工生成',position:'top-left',size:88,color:'#ff0000'}});
  assert.deepEqual({textType:request.overlay.textType,disclosureType:request.overlay.disclosureType,position:request.overlay.position,size:request.overlay.size,color:request.overlay.color},
    {textType:'AI_DISCLOSURE',disclosureType:'AI_GENERATED',position:'bottom-right',size:32,color:'#ffffff'});
  assert.deepEqual(disclosurePlacementRegion(request.overlay),{x:902,y:1352,width:152,height:64});
  assert.equal(Object.hasOwn(request,'batchId'),false);
  const batchId=randomUUID();
  assert.equal(normalizeEdit({...input(),batchId}).batchId,batchId);
  const programmatic=normalizeEdit({...input(),operation:'SVG_DISCLOSURE',confirmation:undefined,batchId});
  assert.equal(programmatic.operation,'SVG_DISCLOSURE');assert.equal(programmatic.confirmation,null);
  assert.equal(programmatic.overlay.text,'AI生成');assert.equal(programmatic.batchId,batchId);
  assert.throws(()=>normalizeEdit({...input(),batchId,operation:'AI_LOCAL',instruction:'修改背景'}),/只有人工生成标识或真实产品替换支持/u);
});
test('reference decoding rejects MIME spoofing, SVG, truncation and excess bytes; strips metadata',async()=>{
  const source=await sharp(await png('red',30,40)).withMetadata({orientation:6}).jpeg().toBuffer();
  const decoded=await decodeReference(source,'image/jpeg');
  const m=await sharp(decoded.bytes).metadata();assert.equal(m.format,'png');assert.equal(m.exif,undefined);assert.equal(decoded.width,40);assert.equal(decoded.height,30);
  await assert.rejects(()=>decodeReference(source,'image/png'));
  await assert.rejects(()=>decodeReference(Buffer.from('<svg/>'),'image/png'));
  await assert.rejects(()=>decodeReference(source.subarray(0,24),'image/jpeg'));
  await assert.rejects(()=>decodeReference(Buffer.alloc(5*1024*1024+1),'image/png'));
  const animated=await sharp([await png('red',20,20),await png('blue',20,20)],{join:{animated:true}}).webp().toBuffer();
  assert.equal((await sharp(animated,{animated:true}).metadata()).pages,2);
  await assert.rejects(()=>decodeReference(animated,'image/webp'),/动画/u);
});
for(const mask of [{type:'rect',x:20,y:30,width:100,height:110},{type:'brush',radius:20,points:[{x:20,y:20},{x:200,y:200}]}])test(`local ${mask.type} masks preserve every outside RGBA pixel`,async()=>{
  const source=await png('red'), generated=await png('blue'),bytes=await renderMask(mask),merged=await mergeWithMask(source,generated,bytes);
  assert.deepEqual(await assertOutsideMask(source,merged,bytes),{passed:true,changedPixels:0,threshold:0});
  await assert.rejects(()=>assertOutsideMask(source,generated,bytes),/遮罩外/u);
});
test('planned multi-region masks cover source and destination while preserving the gap',async()=>{
  const source=await png('red'),generated=await png('blue');
  const mask=await renderRegionsMask([{x:20,y:30,width:100,height:110},{x:800,y:900,width:180,height:220}]);
  const merged=await mergeWithMask(source,generated,mask),raw=await sharp(merged).ensureAlpha().raw().toBuffer();
  const inside=(50*1086+50)*4,gap=(500*1086+500)*4,destination=(950*1086+850)*4;
  assert.deepEqual([...raw.subarray(inside,inside+4)],[0,0,255,255]);
  assert.deepEqual([...raw.subarray(gap,gap+4)],[255,0,0,255]);
  assert.deepEqual([...raw.subarray(destination,destination+4)],[0,0,255,255]);
  assert.deepEqual(await assertOutsideMask(source,merged,mask),{passed:true,changedPixels:0,threshold:0});
});
test('text change masks discard low-contrast model drift around the generated label',async()=>{
  const source=await png('#f7f3ea');
  const generated=await sharp(source).composite([{input:Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1086" height="1448">
    <rect x="774" y="1276" width="280" height="140" fill="#ffffff"/>
    <rect x="860" y="1320" width="190" height="80" rx="12" fill="#111827"/>
  </svg>`)}]).png().toBuffer();
  const allowed=await renderMask({type:'rect',x:774,y:1276,width:280,height:140});
  const refined=await changedPixelMask(source,generated,allowed);
  const result=await mergeWithMask(source,generated,refined);
  const raw=await sharp(result).ensureAlpha().raw().toBuffer();
  const background=(1280*1086+800)*4,label=(1360*1086+900)*4;
  assert.deepEqual([...raw.subarray(background,background+4)],[247,243,234,255]);
  assert.deepEqual([...raw.subarray(label,label+4)],[17,24,39,255]);
  assert.equal((await assertOutsideMask(source,result,refined)).changedPixels,0);
});
test('edit inputs reject commands, paths, unconfirmed AI, duplicate references and oversized selections',()=>{
  assert.throws(()=>normalizeEdit({...input(),path:'../../secret'}));
  assert.throws(()=>normalizeEdit({...input(),confirmation:undefined}),/确认/u);
  const unconfirmedDraft=normalizeEdit({...input(),confirmation:undefined,draft:true});
  assert.equal(unconfirmedDraft.draft,true);assert.equal(unconfirmedDraft.confirmation,null);
  assert.throws(()=>normalizeEdit({...input(),operation:'AI_FULL',confirmation:undefined,instruction:'修改背景'}));
  assert.throws(()=>normalizeEdit({...input(),operation:'AI_LOCAL',confirmation:'LIVE_IMAGE_COST_ACCEPTED',instruction:'修改背景',mask:{type:'rect',x:1080,y:0,width:100,height:100}}));
  assert.throws(()=>normalizeEdit({...input(),references:[{assetId:1},{assetId:1}]}));
  assert.throws(()=>normalizeEdit({...input(),operation:'AI_FUSION',instruction:'替换产品',references:[{assetId:1},{assetId:2}]}),/只能上传 1 张/u);
  assert.throws(()=>normalizeEdit({...input(),operation:'AI_FUSION',instruction:'替换产品',references:[{assetId:1}]}),/目标描述和框选区域/u);
  const fusion=normalizeEdit({...input(),operation:'AI_FUSION',instruction:'替换右侧杯子',references:[{assetId:1}],
    target:{description:'右侧台面上的白色杯子',region:{x:700,y:500,width:220,height:240}}});
  assert.deepEqual(fusion.target,{description:'右侧台面上的白色杯子',region:{x:700,y:500,width:220,height:240}});
  assert.equal(fusion.referenceMode,'STRICT');
  assert.equal(fusion.targetMode,'SINGLE');
  const appearance=normalizeEdit({...input(),operation:'AI_FUSION',instruction:'按可见外观替换产品',references:[{assetId:1}],referenceMode:'APPEARANCE',
    target:{description:'右侧台面上的白色杯子',region:{x:700,y:500,width:220,height:240}}});
  assert.equal(appearance.referenceMode,'APPEARANCE');
  const batchId=randomUUID();
  const multiple=normalizeEdit({...input(),batchId,batchSize:2,operation:'AI_FUSION',instruction:'同时替换杯子和手表',
    references:[{assetId:1,purpose:'杯子'},{assetId:2,purpose:'手表'}],replacements:[
      {referenceAssetId:1,referenceMode:'STRICT',target:{description:'右侧杯子',region:{x:700,y:500,width:220,height:240}}},
      {referenceAssetId:2,referenceMode:'APPEARANCE',targetMode:'ALL_MATCHES',target:{description:'左侧手表',region:{x:100,y:700,width:180,height:160}}},
    ]});
  assert.equal(multiple.batchId,batchId);assert.equal(multiple.batchSize,2);assert.equal(multiple.replacements.length,2);
  assert.equal(multiple.replacements[1].referenceMode,'APPEARANCE');assert.equal(multiple.replacements[1].referenceAssetId,2);
  assert.equal(multiple.replacements[0].targetMode,'SINGLE');assert.equal(multiple.replacements[1].targetMode,'ALL_MATCHES');
  assert.throws(()=>normalizeEdit({...input(),operation:'AI_FUSION',instruction:'替换产品',references:[{assetId:1}],
    replacements:[{referenceAssetId:2,target:{description:'杯子',region:{x:700,y:500,width:220,height:240}}}]}),/未绑定/u);
  assert.throws(()=>normalizeEdit({...input(),operation:'AI_FUSION',instruction:'替换产品',references:[{assetId:1}],referenceMode:'SKIP',
    target:{description:'杯子',region:{x:700,y:500,width:220,height:240}}}),/使用方式无效/u);
  assert.throws(()=>normalizeEdit({...input(),operation:'AI_FUSION',instruction:'替换产品',references:[{assetId:1}],targetMode:'SKIP',
    target:{description:'杯子',region:{x:700,y:500,width:220,height:240}}}),/匹配方式无效/u);
  assert.throws(()=>editStoragePath(join(tmpdir(),'owned'),join(tmpdir(),'other','secret')));
  const normalized=normalizeEdit({...input(),operation:'AI_FULL',confirmation:'LIVE_IMAGE_COST_ACCEPTED',instruction:'$(Remove-Item x)'});assert.equal(normalized.instruction,'$(Remove-Item x)');
  const promptLocal=normalizeEdit({...input(),operation:'AI_LOCAL',confirmation:'LIVE_IMAGE_COST_ACCEPTED',instruction:'把画面右上角的水杯改为蓝色'});
  assert.equal(promptLocal.mask,null);assert.match(promptLocal.instruction,/右上角/u);
});
test('single-page replacement keeps all other image objects and does not mutate the source',()=>{
  const images=[1,2,3].map(assetId=>({assetId,sourceAssetId:assetId,url:`/v1/assets/${assetId}`,pageIndex:assetId}));const result={images};
  const replaced=replaceImagePage(result,2,{id:9,sha256:'b'.repeat(64)});
  assert.equal(replaced.images[0],images[0]);assert.equal(replaced.images[2],images[2]);assert.equal(replaced.images[1].deliveryAssetId,9);assert.equal(result.images[1].assetId,2);
});
test('reviewers cannot create image edits before any database or filesystem work',async()=>{
  const service=createImageEditingService({pool:{connect(){assert.fail('must not connect');}},storageRoot:tmpdir()});
  await assert.rejects(()=>service.create(1,input(),{role:'REVIEWER',username:'reviewer'}),{code:'FORBIDDEN'});
});
test('safe rejected-preview repair survives the ordinary three-attempt cap and stale clients cannot silently restart from source',()=>{
  const instruction='把右下角汤勺移动到锅左侧，并让半勺老抽连续倒入锅内';
  const sourceRegion={x:866,y:1164,width:220,height:284},destinationRegion={x:686,y:1164,width:220,height:284};
  const localization={operationType:'MOVE',targetDescription:'右下角白色老抽勺及液流',sourceAction:'清除旧勺并修复背景',
    destinationAction:'在左侧重建白色勺子',quantity:'半勺老抽',relationship:'液流连续落入锅内',sourceRegion,destinationRegion,
    contactRegion:{x:716,y:1240,width:92,height:208},editRegions:[sourceRegion,destinationRegion],checks:{},warnings:[]};
  const localConsistency={repairableFromRejected:true,failureCodes:['DESTINATION_OBJECT_MISSING','POUR_CONTACT_MISSING'],
    repairInstruction:'只在左侧补生成白色老抽勺和连续入锅液流',repairRegions:[destinationRegion],
    checks:{protectedTextPreserved:true,unrelatedContentPreserved:true},reason:'目标勺和液流缺失'};
  const edit={operation:'AI_LOCAL',attempts:3,error:'验收未通过',config:{instruction,imageEditRepairMaxAttempts:2}};
  const result={asset_id:719,validation:{stage:'LOCAL_EDIT_RESULT',integrity:{sha256:'b'.repeat(64)},localization,localConsistency}};
  assert.throws(()=>resolveImageEditRetry(edit,result),/可以定向修复/u);
  const resolved=resolveImageEditRetry(edit,result,{useRejectedPreview:true});
  assert.equal(resolved.targetedRepair,true);assert.equal(resolved.localRepair.attempt,1);
  assert.equal(resolved.localRepair.baseAssetId,719);assert.deepEqual(resolved.localRepair.repairRegions,[destinationRegion]);
  const unsafe={...result,validation:{...result.validation,localConsistency:{...localConsistency,repairableFromRejected:false}}};
  assert.throws(()=>resolveImageEditRetry(edit,unsafe),/三次执行上限/u);
});
test('direct rejected previews can be repaired without geometry only while text and unrelated content remain intact',()=>{
  const edit={operation:'AI_LOCAL',attempts:1,config:{instruction:'删除细蓝线',imageEditRepairMaxAttempts:2}};
  const result={asset_id:719,validation:{stage:'LOCAL_EDIT_RESULT',integrity:{sha256:'b'.repeat(64)},
    localization:{mode:'DIRECT_PROMPT_EDIT',operationType:'FROM_INSTRUCTION',editRegions:[]},
    localConsistency:{repairableFromRejected:true,failureCodes:['SOURCE_NOT_CLEARED'],repairInstruction:'清除剩余蓝线并修补背景',
      repairRegions:[],checks:{protectedTextPreserved:true,unrelatedContentPreserved:true}}}};
  const retry=resolveImageEditRetry(edit,result,{useRejectedPreview:true});
  assert.equal(retry.targetedRepair,true);assert.equal(retry.localRepair.baseAssetId,719);
  assert.equal(retry.localRepair.plan.mode,'DIRECT_PROMPT_EDIT');assert.deepEqual(retry.localRepair.repairRegions,[]);
  for(const check of ['protectedTextPreserved','unrelatedContentPreserved']) {
    const damaged=structuredClone(result);damaged.validation.localConsistency.checks[check]=false;
    assert.throws(()=>resolveImageEditRetry(edit,damaged,{useRejectedPreview:true}),/不能安全局部补救/u);
  }
});
test('mock mode never calls image models or produces an adoptable AI edit',async()=>{
  let failed=false;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_FULL',config:{}}),context:async()=>({source:{},refs:[],settings:{aiDisclosureEnabled:false},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}}}),readAsset:async()=>png(),fail:async()=>{failed=true;},complete:()=>assert.fail('must not complete')};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-mock-'));
  try{const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',mock:true,validateImage:async()=>visionPass()});assert.equal(result.status,'FAILED');assert.equal(failed,true);}finally{await rm(dir,{recursive:true,force:true});}
});
test('source visual precheck retries once, warns, and still calls the image model',async()=>{
  const source=await png('white'),generated=await png('#eeeeee');
  let completed=null,validationCalls=0,imageCalls=0;
  const config={imageEditPrompt,references:[],instruction:'修改右上角背景',preserve:'保留标题',negative:'不要增加文字'};
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_LOCAL',config}),
    context:async()=>({source:{id:1},refs:[],settings:{aiDisclosureEnabled:false},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),
    readAsset:async()=>source,heartbeat:async()=>true,fail:async(_edit,error)=>assert.fail(error.message),complete:async(_edit,result)=>{completed=result;return{};}};
  const agentClient={runImageEdit:async({outputPath})=>{imageCalls++;await writeFile(outputPath,generated);return{model:'fake-edit'};},
    runVision:async()=>({model:'fake-review',rawText:JSON.stringify(localResultPass())})};
  const validateImage=async()=>{validationCalls++;return validationCalls<=2
    ?{...visionPass(),passed:false,ocrConfidence:0.6,ocrMismatches:['headline'],repairInstruction:'源图标题识别不确定'}
    :visionPass();};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-source-check-'));
  try{const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage});assert.equal(result.status,'PREVIEW_READY');assert.equal(imageCalls,1);assert.equal(validationCalls,3);assert.equal(completed.validation.sourcePreflight.passed,false);assert.equal(completed.validation.sourcePreflight.blocking,false);assert.equal(completed.validation.sourcePreflight.checks.length,2);assert.deepEqual(completed.validation.sourcePreflight.warnings,['源图标题识别不确定']);}finally{await rm(dir,{recursive:true,force:true});}
});
test('a source vision transport failure is explicit and does not consume a paid image attempt',async()=>{
  let failedError=null;
  const config={imageEditPrompt,references:[],instruction:'添加合规标识',preserve:'保留原有标题',negative:'不要增加其他文字',overlay:normalizeManualOverlay({text:'AI生成',textType:'AI_DISCLOSURE',disclosureType:'AI_GENERATED',position:'bottom-right'})};
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'TEXT',config}),context:async()=>({source:{id:1},refs:[],settings:{aiDisclosureEnabled:true,aiDisclosureText:'AI生成'},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),readAsset:async()=>png(),heartbeat:async()=>true,
    fail:async(e,error)=>{failedError=error;},complete:()=>assert.fail('must not complete')};
  const agentClient={runVision:async()=>{throw Object.assign(new Error('shared caller configuration differs'),{code:'CODEX_CONCURRENCY_MISMATCH'});},runImageEdit:()=>assert.fail('image model must not start')};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-source-service-'));
  try {
    const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient});
    assert.equal(result.status,'FAILED');
    assert.match(result.error,/CODEX_CONCURRENCY_MISMATCH/u);
    assert.equal(failedError.nonBillablePreflightFailure,true);
    assert.deepEqual(failedError.validation,{stage:'SOURCE_SERVICE',passed:false,retryable:true,
      code:'ALIGNMENT_SERVICE_FAILED',serviceCode:'CODEX_CONCURRENCY_MISMATCH',billedImageGeneration:false});
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('AI text worker makes one full-frame edit without a mask or pixel-stitching pass and never retries automatically',async()=>{
  const source=await png('white');
  const generated=await sharp(await png('#dbeafe')).composite([{input:Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1086" height="1448">
    <rect x="790" y="1330" width="250" height="70" rx="12" fill="#111827"/>
  </svg>`)}]).png().toBuffer();
  const config={imageEditPrompt,references:[],instruction:'将人工生成标识显示为“人工创作”并放在右下角',preserve:'保留原有标题',negative:'不要增加其他文字',overlay:normalizeManualOverlay({text:'人工创作',textType:'AI_DISCLOSURE',disclosureType:'AI_GENERATED',position:'bottom-right'})};
  let completed,failed=false,generationCalls=0;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'TEXT',config}),context:async()=>({source:{id:1},refs:[],settings:{aiDisclosureEnabled:true,aiDisclosureText:'AI生成'},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),readAsset:async()=>source,heartbeat:async()=>true,
    fail:async()=>{failed=true;},complete:async(e,result)=>{const raw=await sharp(result.bytes).ensureAlpha().raw().toBuffer();assert.deepEqual([...raw.subarray(0,4)],[219,234,254,255],'full-frame model output must be accepted without local pixel stitching');completed=result;return{};}};
  const prompts=[],inputs=[];
  const agentClient={runImageEdit:async({prompt,inputPaths,outputPath,signal})=>{generationCalls++;prompts.push(prompt);inputs.push(inputPaths);assert.equal(signal.aborted,false);await writeFile(outputPath,generated);return{model:'fake-text-edit'};}};
  const validateImage=async()=>generationCalls===0
    ?{...visionPass(),passed:false,styleMatched:false,layoutMatched:false,failureClass:'STYLE_LAYOUT',contradictions:['源图布局仍可调整']}
    :{...visionPass(['人工创作']),passed:false,styleMatched:false,layoutMatched:false,failureClass:'STYLE_LAYOUT',
      contradictions:['视觉字号略小于约32px'],repairInstruction:'放大并左移标识',
      modelAssessment:{failureClass:'STYLE_LAYOUT'},programAssessment:{passed:false,failureClass:'STYLE_LAYOUT'}};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-ai-text-'));
  try {
    const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage});
    assert.equal(result.status,'PREVIEW_READY');assert.equal(failed,false);assert.equal(prompts.length,1);
    assert.match(prompts[0],/<trusted_business_rules kind="IMAGE_EDIT_SYSTEM">/u);assert.match(prompts[0],/管理员统一图片编辑规则/u);
    assert.match(prompts[0],/AI_DISCLOSURE_LABEL/u);assert.match(prompts[0],/不使用蒙版/u);assert.match(prompts[0],/只编辑唯一附件一次/u);
    assert.equal(inputs[0].length,1);assert.match(inputs[0][0],/source\.png$/u);
    assert.equal(completed.validation.generationAttempts,1);assert.equal(completed.validation.repairMaxAttempts,0);
    assert.equal(completed.validation.model,'fake-text-edit');assert.equal(completed.validation.text.engine,'model-generated-disclosure-with-vision-ocr');
    assert.equal(completed.validation.text.targetOccurrences,1);assert.equal(completed.validation.text.placement.passed,true);
    assert.equal(completed.validation.text.placement.mode,'MODEL_GENERATED_DISCLOSURE');assert.equal(completed.validation.text.placement.style.backgroundColor,'#111827');
    assert.equal(completed.validation.text.visualAdvisory.passed,false);assert.equal(completed.validation.text.passed,true);
    assert.equal(completed.validation.outsideMask.mode,'MODEL_FULL_FRAME_NO_MASK');assert.equal(completed.validation.outsideMask.requested,false);assert.equal(completed.validation.outsideMask.programmaticPixelMerge,false);
    assert.deepEqual(completed.validation.requiredText,['真实参考','人工创作']);assert.deepEqual(completed.validation.disclosure.added,{type:'AI_GENERATED',text:'人工创作'});
    assert.equal(completed.validation.prompt.versionId,17);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('SVG disclosure worker uses the canonical badge and Sharp without calling image or vision models',async()=>{
  const source=await png('white');
  const config=normalizeEdit({...input(),operation:'SVG_DISCLOSURE',confirmation:undefined,overlay:{text:'AI生成'}});
  let completed,failed=false;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'SVG_DISCLOSURE',config}),
    context:async()=>({source:{id:1},refs:[],settings:{},revision:{content:{imagePlan:[{headline:'真实参考'}]}},
      run:{result:{images:[{aiDisclosureStyle:{color:'#6f7d5f'}}]}}}),readAsset:async()=>source,heartbeat:async()=>true,
    fail:async()=>{failed=true;},complete:async(e,result)=>{completed=result;return{};}};
  const noModel={runImageEdit:()=>assert.fail('must not call image model'),runVision:()=>assert.fail('must not call vision model')};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-svg-disclosure-'));
  try {
    const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient:noModel,
      validateImage:async()=>assert.fail('must not validate with a model'),mock:true});
    assert.equal(result.status,'PREVIEW_READY');assert.equal(failed,false);assert.ok(Buffer.isBuffer(completed.mask));
    assert.equal(completed.validation.passed,true);assert.equal(completed.validation.billedImageGeneration,false);
    assert.equal(completed.validation.model,null);assert.equal(completed.validation.generationAttempts,0);
    assert.equal(completed.validation.text.engine,'sharp-svg-disclosure');
    assert.equal(completed.validation.text.placement.mode,'PROGRAMMATIC_SVG_DISCLOSURE');
    assert.equal(completed.validation.renderer.engine,'sharp-svg');
    assert.equal(completed.validation.renderer.style.color,'#6F7D5F');
    assert.deepEqual(completed.validation.disclosure.added,{type:'AI_GENERATED',text:'AI生成'});
    assert.deepEqual(completed.validation.requiredText,['真实参考','AI生成']);
    assert.equal(completed.validation.outsideMask.changedPixels,0);
    assert.equal(completed.bytes.equals(source),false);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('AI text worker never makes a second edit when the only result fails text validation',async()=>{
  const source=await png('white');
  const generated=await sharp(source).composite([{input:Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1086" height="1448">
    <rect x="860" y="1320" width="190" height="80" rx="12" fill="#111827"/>
  </svg>`)}]).png().toBuffer();
  const config={imageEditPrompt,imageEditRepairMaxAttempts:2,references:[],instruction:'添加合规标识',preserve:'保留原有标题',negative:'不要增加其他文字',overlay:normalizeManualOverlay({text:'AI生成',textType:'AI_DISCLOSURE',disclosureType:'AI_GENERATED',position:'bottom-right'})};
  let failedError=null,generationCalls=0,validationCalls=0;const validationRequests=[];
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'TEXT',config}),context:async()=>({source:{id:1},refs:[],settings:{aiDisclosureEnabled:true,aiDisclosureText:'AI生成',imageEditRepairMaxAttempts:2},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),readAsset:async()=>source,heartbeat:async()=>true,
    fail:async(e,error)=>{failedError=error;},complete:()=>assert.fail('must not complete')};
  const agentClient={runImageEdit:async({outputPath})=>{generationCalls++;await writeFile(outputPath,generated);return{model:'fake-text-edit'};}};
  const validateImage=async input=>{validationCalls++;validationRequests.push(input);return validationCalls===1?visionPass():{...visionPass(),passed:false,layoutMatched:false,ocrMismatches:['otherText'],repairInstruction:'补充 AI 生成标识'};};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-repair-limit-'));
  try{const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage});assert.equal(result.status,'FAILED');assert.equal(generationCalls,1);assert.equal(validationCalls,2);assert.deepEqual(validationRequests[0].requiredText,['真实参考']);assert.deepEqual(validationRequests[1].requiredText,['真实参考','AI生成']);assert.equal(failedError.validation.generationAttempts,1);assert.equal(failedError.validation.repairMaxAttempts,0);}finally{await rm(dir,{recursive:true,force:true});}
});
test('image edit processing rejects callers that request a second generation attempt',async()=>{
  await assert.rejects(()=>processImageEdit({service:{},storageRoot:tmpdir(),workerId:'fake',maxGenerationAttempts:2}),/仅允许单次生成/u);
});
test('AI local worker uses the existing edit adapter and enforces outside-mask pixels with a fake model',async()=>{
  const source=await png('red'),generated=await png('blue'),config={imageEditPrompt,references:[],instruction:'改变选区颜色',preserve:'保留标题',negative:'不改变其他内容',mask:{type:'rect',x:20,y:20,width:100,height:100}};
  let completed,calls=0;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_LOCAL',config}),context:async()=>({source:{},refs:[],settings:{aiDisclosureEnabled:false},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),readAsset:async()=>source,
    fail:async(e,error)=>assert.fail(error.message),complete:async(e,result)=>{completed=result;return{};}};
  const agentClient={runImageEdit:async({prompt,inputPaths,outputPath,signal})=>{calls++;assert.equal(inputPaths.length,2);assert.match(prompt,/<trusted_business_rules kind="IMAGE_EDIT_SYSTEM">/u);assert.match(prompt,/<untrusted_image_edit_request>/u);assert.match(prompt,/改变选区颜色/u);assert.equal(signal.aborted,false);await writeFile(outputPath,generated);return{model:'fake-only'};}};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-local-fake-'));
  try{const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage:async()=>visionPass()});assert.equal(result.status,'PREVIEW_READY');assert.equal(calls,1);assert.equal(completed.validation.outsideMask.changedPixels,0);assert.equal(completed.validation.model,'fake-only');}finally{await rm(dir,{recursive:true,force:true});}
});
test('direct local editing sends the original image and instruction once, then reviews semantics and text',async()=>{
  const source=await png('red'),generated=await png('blue');
  const instruction='删除画面中央偏下的整条细蓝色水平线（约635×6像素），自然修补并保持其他内容和文字不变';
  const config={imageEditPrompt,references:[],instruction,preserve:'保留标题和所有未点名区域',negative:'不得改写文字',mask:null};
  let completed;const calls=[];
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_LOCAL',config}),
    context:async()=>({source:{},refs:[],settings:{},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),
    readAsset:async()=>source,fail:(_edit,error)=>assert.fail(error.message),complete:async(_edit,result)=>{completed=result;return{};}};
  const agentClient={runImageEdit:async({prompt,inputPaths,outputPath})=>{
    calls.push('image');assert.equal(inputPaths.length,1);assert.deepEqual(await readFile(inputPaths[0]),source);
    assert.match(prompt,/LOCAL_PROMPT_EDIT/u);assert.ok(prompt.includes(instruction));assert.doesNotMatch(prompt,/"editPlan"|"mask":/u);
    await writeFile(outputPath,generated);return{model:'fake-direct-edit'};
  },runVision:async({prompt,inputPaths})=>{
    calls.push('result-review');assert.doesNotMatch(prompt,/编辑规划器/u);assert.equal(inputPaths.length,2);
    return{model:'fake-result-review',rawText:JSON.stringify(localResultPass())};
  }};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-direct-'));
  try{
    const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,
      validateImage:async({attempt})=>{calls.push(attempt===0?'source-check':'result-text');return visionPass();}});
    assert.equal(result.status,'PREVIEW_READY');assert.deepEqual(calls,['source-check','image','result-review','result-text']);
    assert.equal(completed.mask,null);assert.equal(completed.validation.localization.mode,'DIRECT_PROMPT_EDIT');
    assert.equal(completed.validation.localization.preflightPerformed,false);
    assert.equal(completed.validation.outsideMask.programmaticPixelMerge,false);
    assert.deepEqual(await sharp(completed.bytes).raw().toBuffer(),await sharp(generated).raw().toBuffer());
    assert.equal(completed.validation.generationAttempts,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('AI local removal of an adopted disclosure drops it from OCR requirements and page lineage',async()=>{
  const disclosureText='该人物形象由AI生成';
  const source=await png('red'),generated=await png('blue');
  const config={imageEditPrompt,references:[],instruction:'去掉右下角的ai标识',
    preserve:'保留原图全部已批准文字、所有未在说明中点名的区域、人物、构图、色调和人工生成标识',
    negative:'不得修改说明之外的区域；不得新增、删除或改写已有文字',mask:null};
  let completed,promptText='',validationCalls=0;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_LOCAL',config}),context:async()=>({source:{},refs:[],settings:{aiDisclosureEnabled:true,aiDisclosureText:disclosureText},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{imageEditRequiredText:['真实参考',disclosureText],imageEditDisclosure:{type:'AI_GENERATED',text:disclosureText}}]}},imageEditPrompt}),readAsset:async()=>source,
    fail:async(_edit,error)=>assert.fail(error.message),complete:async(_edit,result)=>{completed=result;return{};}};
  const agentClient={runVision:async({prompt})=>prompt.includes('编辑规划器')?({model:'fake-vision',rawText:JSON.stringify({passed:true,confidence:0.99,candidateCount:1,
    targetDescription:`右下角写有“${disclosureText}”的白色圆角标识牌整体`,
    region:{x:807,y:1359,width:250,height:63},reason:'目标唯一且不包含其他文字',checks:{instructionSpecific:true,exactlyOneTarget:true,wholeTargetInsideRegion:true,protectedTextExcluded:true}})}):({model:'fake-result-check',rawText:JSON.stringify(localResultPass())}),
    runImageEdit:async({prompt,outputPath})=>{promptText=prompt;await writeFile(outputPath,generated);return{model:'fake-local-edit'};}};
  const validationRequests=[];
  const validateImage=async input=>{validationCalls++;validationRequests.push(input);return validationCalls===1?visionPass([disclosureText]):visionPass();};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-remove-disclosure-'));
  try {
    const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage});
    assert.equal(result.status,'PREVIEW_READY');
    assert.deepEqual(validationRequests[0].requiredText,['真实参考',disclosureText]);
    assert.deepEqual(validationRequests[1].requiredText,['真实参考']);
    assert.match(promptText,/removeDisclosure 字段指定的人工生成标识/u);
    assert.match(promptText,/除 removeDisclosure 指定标识外，保留所有未点名区域/u);
    assert.doesNotMatch(promptText,/保留原图全部已批准文字、所有未在说明中点名的区域、人物、构图、色调和人工生成标识/u);
    assert.deepEqual(completed.validation.requiredText,['真实参考']);
    assert.equal(completed.validation.disclosure.required,'');
    assert.equal(completed.validation.disclosure.added,null);
    assert.deepEqual(completed.validation.disclosure.removed,{type:'AI_GENERATED',text:disclosureText});
    assert.equal(completed.validation.localization.removedInheritedDisclosure,true);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('queued historical plans, including invalid thin regions, do not block or rewrite a direct edit',async()=>{
  const source=await png('red'),generated=await png('blue');
  const instruction='删除中央635×6像素的蓝线；把右下角贴边的汤勺移到左侧并自然修补背景，保护文字';
  const config={imageEditPrompt,references:[],instruction,mask:null,localPlan:{accepted:true,
    suggestedInstruction:'过时且与当前说明不一致的建议',sourceRegion:{x:30,y:896,width:635,height:6},editRegions:[],
    operationType:'MOVE',destinationAction:'擅自向左180像素'}};
  config.imageEditPrompt={...imageEditPrompt,runtime:{settings:null,prompts:{IMAGE_EDIT_SYSTEM:imageEditPrompt,
    INTERNAL_EDIT_LOCAL_TEXT:{content:'旧规则要求蒙版'},INTERNAL_EDIT_LOCAL_REVIEW:{content:'旧规则要求规划坐标'}}}};
  let completed;let imageCalls=0,reviewCalls=0;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_LOCAL',config}),
    context:async()=>({source:{},refs:[],settings:{},task:{query:'测试',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),
    readAsset:async()=>source,fail:(_edit,error)=>assert.fail(error.message),complete:async(_edit,result)=>{completed=result;return{};}};
  const agentClient={runImageEdit:async({prompt,inputPaths,outputPath})=>{
    imageCalls++;assert.equal(inputPaths.length,1);assert.ok(prompt.includes(instruction));
    assert.doesNotMatch(prompt,/180像素|过时且|旧规则|"editPlan"|direct-move-guide|local-role-guide/u);
    await writeFile(outputPath,generated);return{model:'fake-direct-edit'};
  },runVision:async({prompt})=>{reviewCalls++;assert.equal(imageCalls,1);assert.doesNotMatch(prompt,/编辑规划器|180像素|旧规则/u);
    return{model:'fake-result-review',rawText:JSON.stringify(localResultPass())};}};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-legacy-plan-'));
  try{const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage:async()=>visionPass()});
    assert.equal(result.status,'PREVIEW_READY');assert.equal(imageCalls,1);assert.equal(reviewCalls,1);
    assert.equal(completed.mask,null);assert.equal(completed.validation.localConsistency.passed,true);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('a generated image that fails result validation is returned as a rejected preview',async()=>{
  const source=await png('red'),generated=await png('blue');
  const instruction='把右下角汤勺移动到锅的左侧，并保持液流倒入锅内';
  const config={imageEditPrompt,imageEditRepairMaxAttempts:2,references:[],instruction,preserve:'保留其他区域',negative:'不得改写文字',mask:null,localPlan:{accepted:true,
    originalInstruction:instruction,suggestedInstruction:instruction,sourceRegion:{x:850,y:980,width:236,height:468},destinationRegion:{x:470,y:850,width:260,height:460},
    editRegions:[{x:830,y:960,width:256,height:488},{x:450,y:830,width:300,height:500}],operationType:'MOVE',touchesImageEdge:true,
    targetDescription:'右下角汤勺和液流',warnings:['贴边'],reason:'采用模型建议',confidence:0.96,checks:{}}};
  let rejected=null;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_LOCAL',config}),context:async()=>({source:{},refs:[],settings:{aiDisclosureEnabled:false},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),readAsset:async()=>source,
    fail:async(_edit,error,preview)=>{rejected={error,preview};},complete:()=>assert.fail('must not complete')};
  const agentClient={runImageEdit:async({outputPath})=>{await writeFile(outputPath,generated);return{model:'fake-local-edit'};},
    runVision:async()=>({model:'fake-result-check',rawText:JSON.stringify({passed:false,reason:'原目标被删除，但没有在目标位置重新出现',
      failureCodes:['DESTINATION_OBJECT_MISSING','POUR_CONTACT_MISSING'],repairInstruction:'只在锅左侧补生成汤勺和入锅液流',
      repairRegions:[{x:450,y:830,width:300,height:500}],
      checks:{requestedChangeCompleted:false,targetCountCorrect:false,placementAndRepairNatural:false,movedTargetFullyVisible:true,compositionBalanced:true,protectedTextPreserved:true,unrelatedContentPreserved:true}})})};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-rejected-preview-'));
  try {
    const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage:async()=>visionPass()});
    assert.equal(result.status,'FAILED');assert.ok(Buffer.isBuffer(rejected.preview.bytes));assert.ok(rejected.preview.bytes.length>0);
    assert.equal(rejected.error.validation.billedImageGeneration,true);assert.equal(rejected.error.validation.localConsistency.passed,false);
    assert.deepEqual(rejected.error.validation.localConsistency.failureCodes,['DESTINATION_OBJECT_MISSING','POUR_CONTACT_MISSING']);
    assert.equal(rejected.error.validation.localConsistency.repairableFromRejected,true);
    assert.deepEqual(rejected.error.validation.localConsistency.repairRegions,[]);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('a move result cannot pass when the rebuilt target is clipped or hidden by a text label',async()=>{
  const source=await png('red'),generated=await png('blue');
  const instruction='把右下角汤勺移到左侧并完整显示，让半勺老抽倒入锅内';
  const destinationRegion={x:470,y:850,width:260,height:460},destinationEditRegion={x:450,y:830,width:300,height:500};
  const config={imageEditPrompt,imageEditRepairMaxAttempts:2,references:[],instruction,preserve:'保留其他区域',negative:'不得改写文字',mask:null,localPlan:{accepted:true,
    originalInstruction:instruction,suggestedInstruction:instruction,sourceRegion:{x:850,y:980,width:236,height:468},destinationRegion,
    editRegions:[{x:830,y:960,width:256,height:488},destinationEditRegion],operationType:'MOVE',touchesImageEdge:true,
    targetDescription:'右下角汤勺和液流',warnings:['贴边'],reason:'采用模型建议',confidence:0.96,checks:{}}};
  let rejected=null;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_LOCAL',config}),context:async()=>({source:{},refs:[],settings:{aiDisclosureEnabled:false},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),readAsset:async()=>source,
    fail:async(_edit,error,preview)=>{rejected={error,preview};},complete:()=>assert.fail('must not complete')};
  const agentClient={runImageEdit:async({outputPath})=>{await writeFile(outputPath,generated);return{model:'fake-local-edit'};},
    runVision:async()=>({model:'fake-result-check',rawText:JSON.stringify({passed:true,reason:'勺柄被标签遮住',failureCodes:[],repairInstruction:'补全勺柄并移动到标签左上方，保持整把勺子无遮挡',repairRegions:[destinationRegion],
      checks:{requestedChangeCompleted:true,targetCountCorrect:true,placementAndRepairNatural:true,movedTargetFullyVisible:false,compositionBalanced:true,protectedTextPreserved:true,unrelatedContentPreserved:true}})})};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-incomplete-target-'));
  try {
    const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage:async()=>visionPass()});
    assert.equal(result.status,'FAILED');assert.ok(Buffer.isBuffer(rejected.preview.bytes));
    assert.equal(rejected.error.validation.localConsistency.passed,false);
    assert.equal(rejected.error.validation.localConsistency.checks.movedTargetFullyVisible,false);
    assert.deepEqual(rejected.error.validation.localConsistency.failureCodes,['TARGET_INCOMPLETE_OR_OCCLUDED']);
    assert.equal(rejected.error.validation.localConsistency.repairableFromRejected,true);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('a complete moved spoon still fails when it dominates the visual center',async()=>{
  const source=await png('red'),generated=await png('blue');
  const instruction='把右下角汤勺移到右侧次要视觉区，让半勺老抽倒入锅内';
  const destinationRegion={x:586,y:780,width:260,height:350},destinationEditRegion={x:550,y:740,width:340,height:440};
  const config={imageEditPrompt,imageEditRepairMaxAttempts:2,references:[],instruction,preserve:'保留其他区域',negative:'不得改写文字',mask:null,localPlan:{accepted:true,
    originalInstruction:instruction,suggestedInstruction:instruction,sourceRegion:{x:850,y:980,width:236,height:468},destinationRegion,
    editRegions:[{x:830,y:960,width:256,height:488},destinationEditRegion],operationType:'MOVE',touchesImageEdge:true,
    targetDescription:'右下角与“加半勺老抽翻匀”对应的老抽汤勺和液流',warnings:['贴边'],reason:'采用模型建议',confidence:0.96,checks:{}}};
  let rejected=null;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_LOCAL',config}),context:async()=>({source:{},refs:[],settings:{aiDisclosureEnabled:false},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),readAsset:async()=>source,
    fail:async(_edit,error,preview)=>{rejected={error,preview};},complete:()=>assert.fail('must not complete')};
  const agentClient={runImageEdit:async({outputPath})=>{await writeFile(outputPath,generated);return{model:'fake-local-edit'};},
    runVision:async()=>({model:'fake-result-check',rawText:JSON.stringify({passed:true,reason:'勺子完整但横跨中央主菜，视觉权重过大',failureCodes:[],repairInstruction:'缩小勺子并整体右移到次要视觉区，不要越过画面中线',repairRegions:[destinationRegion],
      checks:{requestedChangeCompleted:true,targetCountCorrect:true,placementAndRepairNatural:true,movedTargetFullyVisible:true,compositionBalanced:false,protectedTextPreserved:true,unrelatedContentPreserved:true}})})};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-unbalanced-composition-'));
  try {
    const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage:async()=>visionPass()});
    assert.equal(result.status,'FAILED');assert.ok(Buffer.isBuffer(rejected.preview.bytes));
    assert.equal(rejected.error.validation.localConsistency.checks.compositionBalanced,false);
    assert.deepEqual(rejected.error.validation.localConsistency.failureCodes,['COMPOSITION_UNBALANCED']);
    assert.equal(rejected.error.validation.localConsistency.repairableFromRejected,true);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('a user-approved move repair uses the rejected preview and original source without mask stitching',async()=>{
  const original=await png('red'),rejected=await png('green'),generated=await png('blue');
  const instruction='把右下角汤勺移动到锅的左侧，并保持半勺老抽倒入锅内';
  const plan={operationType:'MOVE',targetDescription:'右下角与“加半勺老抽翻匀”对应的老抽汤勺和液流',sourceAction:'清除右下角旧勺和液流',
    destinationAction:'在锅左侧重建同一把勺子',quantity:'半勺老抽',relationship:'液流连续落入锅内',
    sourceRegion:{x:850,y:980,width:236,height:468},destinationRegion:{x:470,y:850,width:260,height:460},
    contactRegion:{x:560,y:1180,width:90,height:80},editRegions:[{x:830,y:960,width:256,height:488},{x:450,y:830,width:300,height:500}],
    touchesImageEdge:true,warnings:['贴边'],reason:'原计划',confidence:.96,checks:{}};
  const config={imageEditPrompt,imageEditRepairMaxAttempts:2,references:[],instruction,preserve:'保留其他区域',negative:'不得改写文字',mask:null,
    localRepair:{attempt:1,originalInstruction:instruction,failureCodes:['DESTINATION_OBJECT_MISSING','POUR_CONTACT_MISSING'],
      repairInstruction:'只在锅左侧补生成半勺老抽的汤勺，并让连续液流落入锅内',repairRegions:[{x:450,y:830,width:300,height:500}],plan}};
  let completed,imageInputs,validationInputs;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_LOCAL',config}),
    context:async()=>({source:{id:1},repairSource:{id:2},refs:[],settings:{aiDisclosureEnabled:false},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),
    readAsset:async asset=>asset.id===2?rejected:original,fail:(_edit,error)=>assert.fail(error.message),complete:async(_edit,result)=>{completed=result;return{};}};
  const agentClient={runImageEdit:async({prompt,inputPaths,outputPath})=>{imageInputs=inputPaths;assert.equal(inputPaths.length,2);assert.match(prompt,/上次自动验收未通过的结果/u);assert.match(prompt,/只在锅左侧补生成半勺老抽/u);assert.match(prompt,/直接编辑第一个附件的完整画面/u);assert.match(inputPaths[1],/original-source\.png$/u);assert.doesNotMatch(prompt,/"editPlan"/u);assert.doesNotMatch(inputPaths.join('\n'),/mask\.png/u);await writeFile(outputPath,generated);return{model:'fake-repair'};},
    runVision:async({inputPaths})=>{validationInputs=inputPaths;return{model:'fake-result-check',rawText:JSON.stringify(localResultPass())};}};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-targeted-repair-'));
  try {
    const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage:async()=>visionPass()});
    assert.equal(result.status,'PREVIEW_READY');assert.equal(imageInputs.length,2);assert.equal(validationInputs.length,3);
    assert.equal(completed.validation.repairAttempt,1);assert.equal(completed.validation.repairMaxAttempts,2);
    assert.equal(completed.validation.localization.rejectedPreviewRepair,true);assert.equal(completed.validation.outsideMask.mode,'MODEL_FULL_FRAME_WITH_RESULT_REVIEW');
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('an ambiguous edit is judged after generation and its failed preview remains available',async()=>{
  const source=await png('red'),generated=await png('blue');
  const config={imageEditPrompt,references:[],instruction:'把杯子改成蓝色',mask:null};
  let failedError,preview,imageCalls=0;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_LOCAL',config}),
    context:async()=>({source:{},refs:[],settings:{},task:{query:'测试',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),
    readAsset:async()=>source,fail:(_edit,error,result)=>{failedError=error;preview=result;},complete:()=>assert.fail('must not complete')};
  const agentClient={runImageEdit:async({outputPath})=>{imageCalls++;await writeFile(outputPath,generated);return{model:'fake-edit'};},
    runVision:async({prompt})=>{assert.equal(imageCalls,1);assert.doesNotMatch(prompt,/编辑规划器/u);
      return{model:'fake-review',rawText:JSON.stringify({...localResultPass(),passed:false,reason:'其他杯子也被改色',
        checks:{...localResultPass().checks,unrelatedContentPreserved:false},failureCodes:['UNRELATED_CONTENT_CHANGED']})};}};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-ambiguous-result-'));
  try{const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage:async()=>visionPass()});
    assert.equal(result.status,'FAILED');assert.equal(imageCalls,1);assert.ok(Buffer.isBuffer(preview.bytes));
    assert.equal(failedError.validation.stage,'LOCAL_EDIT_RESULT');assert.equal(failedError.validation.billedImageGeneration,true);
    assert.equal(failedError.validation.localConsistency.repairableFromRejected,false);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('AI fusion uses one real-product reference and the governed image-edit prompt',async()=>{
  const source=await png('white'),reference=await png('coral',120,120),generated=await png('#eeeeee');
  const config={imageEditPrompt,references:[{assetId:9,purpose:'真实产品替换'}],instruction:'替换右侧台面上的白色杯子',preserve:'保留原场景和文字',negative:'不得改变参考产品关键细节',
    target:{description:'右侧台面上的白色杯子',region:{x:700,y:500,width:220,height:240}}};
  let completed,editCalls=0,visionCalls=0;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_FUSION',config}),context:async()=>({source:{id:1},refs:[{id:9,sha256:'b'.repeat(64)}],settings:{aiDisclosureEnabled:false},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),readAsset:async asset=>asset.id===1?source:reference,
    fail:async(e,error)=>assert.fail(error.message),complete:async(e,result)=>{completed=result;return{};}};
  const agentClient={runImageEdit:async({prompt,inputPaths,outputPath})=>{editCalls++;assert.equal(inputPaths.length,2);assert.match(prompt,/管理员统一图片编辑规则/u);assert.match(prompt,/REAL_PRODUCT_REPLACEMENT/u);assert.match(prompt,/不附带黑白遮罩/u);assert.match(prompt,/只是帮助定位目标的大致框/u);assert.match(prompt,/右侧台面上的白色杯子/u);assert.doesNotMatch(inputPaths.join('\n'),/target-mask\.png/u);await writeFile(outputPath,generated);return{model:'fake-fusion'};},runVision:async({prompt,inputPaths})=>{visionCalls++;
    assert.equal(inputPaths.length,3);assert.match(prompt,/倒数第二张是编辑前源图/u);assert.match(prompt,/partTopology/u);return{rawText:JSON.stringify({passed:true,reason:'产品、位置与部件一致',checks:{referenceIdentity:true,targetLocation:true,singleReplacement:true,partTopology:true,unrelatedContentPreserved:true}}),model:'fake-vision'};}};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-fusion-fake-'));
  try{const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage:async()=>visionPass()});assert.equal(result.status,'PREVIEW_READY');assert.equal(editCalls,1);assert.equal(visionCalls,1);assert.equal(completed.validation.localization.passed,true);assert.equal(completed.validation.localization.preflightPerformed,false);assert.equal(completed.validation.localization.candidateCount,1);assert.equal(completed.validation.outsideMask.mode,'MODEL_FULL_FRAME_WITH_RESULT_REVIEW');assert.equal(completed.validation.outsideMask.programmaticPixelMerge,false);assert.equal(completed.validation.entityConsistency.passed,true);assert.deepEqual(completed.validation.entityConsistency.checks,{referenceIdentity:true,targetLocation:true,singleReplacement:true,partTopology:true,unrelatedContentPreserved:true});assert.equal(completed.validation.prompt.sha256,imageEditPrompt.sha256);}finally{await rm(dir,{recursive:true,force:true});}
});
test('one fusion request validates and replaces multiple products atomically',async()=>{
  const source=await png('white'),cup=await png('coral',120,120),watch=await png('navy',120,120),generated=await png('#eeeeee');
  const replacements=[
    {referenceAssetId:9,referenceMode:'STRICT',target:{description:'右侧台面上的杯子',region:{x:700,y:500,width:220,height:240}}},
    {referenceAssetId:10,referenceMode:'APPEARANCE',target:{description:'左侧手腕旁的手表',region:{x:100,y:700,width:180,height:160}}},
  ];
  const config={imageEditPrompt,references:[{assetId:9,purpose:'杯子'},{assetId:10,purpose:'手表'}],replacements,
    target:replacements[0].target,referenceMode:'STRICT',instruction:'同时替换杯子和手表',preserve:'保留其他内容',negative:'不要改文字'};
  let completed,imageCalls=0,preflightCalls=0,reviewCalls=0;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_FUSION',config}),context:async()=>({source:{id:1},refs:[{id:9,sha256:'b'.repeat(64)},{id:10,sha256:'c'.repeat(64)}],settings:{aiDisclosureEnabled:false},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),readAsset:async asset=>asset.id===1?source:asset.id===9?cup:watch,
    fail:async(_edit,error)=>assert.fail(error.message),complete:async(_edit,result)=>{completed=result;return{};}};
  const agentClient={runImageEdit:async({prompt,inputPaths,outputPath})=>{imageCalls++;assert.equal(inputPaths.length,3);assert.match(prompt,/MULTI_REAL_PRODUCT_REPLACEMENT/u);assert.match(prompt,/maskAttached=false/u);assert.match(prompt,/不得遗漏、增加、重复或互换目标/u);assert.doesNotMatch(inputPaths.join('\n'),/target-mask\.png/u);await writeFile(outputPath,generated);return{model:'fake-multi-fusion'};},
    runVision:async({prompt,inputPaths})=>{
      if(prompt.includes('目标定位校验器')){preflightCalls++;assert.equal(inputPaths.length,2);return{model:'fake-vision',rawText:JSON.stringify({passed:true,confidence:.97,candidateCount:1,reason:'目标唯一',referenceProductDescription:preflightCalls===1?'珊瑚色杯子':'深蓝色手表',checks:{descriptionMatches:true,exactlyOneTarget:true,wholeTargetInsideRegion:true,protectedContentExcluded:true,referenceUsable:true,referenceRecognizable:true,referencePrimaryProductClear:true}})};}
      reviewCalls++;assert.equal(inputPaths.length,4);assert.match(prompt,/多产品替换验收器/u);return{model:'fake-vision',rawText:JSON.stringify({passed:true,reason:'两个产品均正确替换',checks:{allReferenceIdentities:true,allTargetLocations:true,replacementCountCorrect:true,partTopology:true,unrelatedContentPreserved:true}})};
    }};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-fusion-multiple-'));
  try {
    const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage:async()=>visionPass()});
    assert.equal(result.status,'PREVIEW_READY');assert.equal(imageCalls,1);assert.equal(preflightCalls,0);assert.equal(reviewCalls,1);
    assert.equal(completed.validation.localization.mode,'MULTI_TARGET_REGION_CHECK');assert.equal(completed.validation.localization.count,2);
    assert.deepEqual(completed.validation.entityConsistency.checks,{allReferenceIdentities:true,allTargetLocations:true,replacementCountCorrect:true,partTopology:true,unrelatedContentPreserved:true});
    assert.equal(completed.validation.outsideMask.mode,'MODEL_FULL_FRAME_WITH_RESULT_REVIEW');
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('appearance-reference fusion accepts an incomplete but unambiguous primary product',async()=>{
  const source=await png('white'),reference=await png('coral',120,120),generated=await png('#eeeeee');
  const config={imageEditPrompt,referenceMode:'APPEARANCE',references:[{assetId:9,purpose:'真实产品替换'}],instruction:'按主产品可见外观替换右侧杯子',preserve:'保留其他内容',negative:'不要改文字',
    target:{description:'右侧台面上的杯子',region:{x:700,y:500,width:220,height:240}}};
  let completed,imageCalls=0,visionCalls=0;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_FUSION',config}),context:async()=>({source:{id:1},refs:[{id:9,sha256:'b'.repeat(64)}],settings:{aiDisclosureEnabled:false},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),readAsset:async asset=>asset.id===1?source:reference,
    fail:async(_edit,error)=>assert.fail(error.message),complete:async(_edit,result)=>{completed=result;return{};}};
  const agentClient={runImageEdit:async({prompt,outputPath})=>{imageCalls++;assert.match(prompt,/可能有手部、手腕/u);assert.match(prompt,/忽略参考图中的手部/u);assert.match(prompt,/该字段为空时/u);await writeFile(outputPath,generated);return{model:'fake-appearance-edit'};},runVision:async({prompt})=>{visionCalls++;
    assert.match(prompt,/referenceMode=APPEARANCE/u);return{model:'fake-vision',rawText:JSON.stringify({passed:true,reason:'可见外观和目标位置一致',checks:{referenceIdentity:true,targetLocation:true,singleReplacement:true,partTopology:true,unrelatedContentPreserved:true}})};}};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-fusion-appearance-'));
  try {
    const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage:async()=>visionPass()});
    assert.equal(result.status,'PREVIEW_READY');assert.equal(imageCalls,1);assert.equal(visionCalls,1);
    assert.equal(completed.validation.localization.referenceMode,'APPEARANCE');
    assert.equal(completed.validation.localization.preflightPerformed,false);
    assert.deepEqual(completed.validation.localization.referenceWarnings,[]);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('all-matches protected-content overlap warns but still replaces every match and preserves the search-area gap',async()=>{
  const source=await png('white'),reference=await png('coral',120,120),generated=await png('#eeeeee');
  const target={description:'框内全部儿童手表及产品特写',region:{x:100,y:250,width:850,height:900}};
  const replacement={referenceAssetId:9,referenceMode:'APPEARANCE',targetMode:'ALL_MATCHES',target};
  const config={imageEditPrompt,referenceMode:'APPEARANCE',targetMode:'ALL_MATCHES',target,
    references:[{assetId:9,purpose:'真实产品替换'}],replacements:[replacement],instruction:'替换框内全部同款手表',
    preserve:'保留其他内容和文字',negative:'不要改文字'};
  const candidateRegions=[{x:140,y:300,width:220,height:240},{x:610,y:760,width:180,height:190}];
  let completed,imageCalls=0,visionCalls=0;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_FUSION',config}),context:async()=>({source:{id:1},refs:[{id:9,sha256:'b'.repeat(64)}],settings:{aiDisclosureEnabled:false},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),readAsset:async asset=>asset.id===1?source:reference,
    fail:async(_edit,error)=>assert.fail(error.message),complete:async(_edit,result)=>{completed=result;return{};}};
  const agentClient={runImageEdit:async({prompt,outputPath})=>{imageCalls++;assert.match(prompt,/REAL_PRODUCT_REPLACEMENT_ALL_MATCHES/u);assert.match(prompt,/candidateCount/u);assert.match(prompt,/全部产品实例/u);await writeFile(outputPath,generated);return{model:'fake-all-matches-edit'};},runVision:async({prompt})=>{visionCalls++;
    if(prompt.includes('目标定位校验器'))return{model:'fake-vision',rawText:JSON.stringify({passed:false,confidence:.98,candidateCount:2,candidateRegions,reason:'一个目标与持握手指重叠',referenceProductDescription:'参考图中央的珊瑚色儿童手表',referenceWarnings:['表带轻微裁切'],checks:{descriptionMatches:true,exactlyOneTarget:false,allMatchingTargetsFound:true,wholeTargetInsideRegion:true,protectedContentExcluded:false,referenceUsable:false,referenceRecognizable:true,referencePrimaryProductClear:true}})};
    assert.match(prompt,/多实例替换验收器/u);return{model:'fake-vision',rawText:JSON.stringify({passed:true,reason:'两个目标均已替换且文字未变',checks:{referenceIdentity:true,allTargetLocations:true,replacementCountCorrect:true,partTopology:true,unrelatedContentPreserved:true}})};}};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-fusion-all-matches-'));
  try {
    const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage:async()=>visionPass()});
    assert.equal(result.status,'PREVIEW_READY');assert.equal(imageCalls,1);assert.equal(visionCalls,2);
    assert.equal(completed.validation.localization.targetMode,'ALL_MATCHES');assert.equal(completed.validation.localization.candidateCount,2);
    assert.equal(completed.validation.localization.passed,false);assert.equal(completed.validation.localization.executionAllowed,true);
    assert.equal(completed.validation.localization.advisory,true);assert.equal(completed.validation.localization.blocking,false);
    assert.deepEqual(completed.validation.localization.warnings,['表带轻微裁切','一个目标与持握手指重叠']);
    assert.deepEqual(completed.validation.localization.candidateRegions,candidateRegions);
    assert.deepEqual(completed.validation.entityConsistency.checks,{referenceIdentity:true,allTargetLocations:true,replacementCountCorrect:true,partTopology:true,unrelatedContentPreserved:true});
    const raw=await sharp(completed.bytes).ensureAlpha().raw().toBuffer();
    const first=(350*1086+200)*4,gap=(600*1086+500)*4,second=(800*1086+650)*4;
    assert.deepEqual([...raw.subarray(first,first+4)],[238,238,238,255]);
    assert.deepEqual([...raw.subarray(gap,gap+4)],[255,255,255,255]);
    assert.deepEqual([...raw.subarray(second,second+4)],[238,238,238,255]);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('all-matches preflight rejects missing or out-of-search candidate regions',()=>{
  const base={passed:true,confidence:.98,candidateCount:2,reason:'两个目标',referenceProductDescription:'中央主产品',referenceWarnings:[],
    checks:{descriptionMatches:true,exactlyOneTarget:false,allMatchingTargetsFound:true,wholeTargetInsideRegion:true,protectedContentExcluded:true,referenceUsable:true,referenceRecognizable:true,referencePrimaryProductClear:true}};
  const options={targetMode:'ALL_MATCHES',targetRegion:{x:100,y:200,width:500,height:600}};
  assert.equal(parseFusionTargetCheck(JSON.stringify({...base,candidateRegions:[{x:120,y:220,width:100,height:120}]}),options).passed,false);
  assert.equal(parseFusionTargetCheck(JSON.stringify({...base,candidateRegions:[{x:120,y:220,width:100,height:120},{x:580,y:700,width:100,height:120}]}),options).passed,false);
});
test('all-matches protected-content overlap is advisory when localization remains usable',()=>{
  const result=parseFusionTargetCheck(JSON.stringify({passed:false,confidence:.98,candidateCount:2,
    candidateRegions:[{x:120,y:220,width:100,height:120},{x:320,y:420,width:100,height:120}],reason:'第二个目标包含持握手指',
    referenceProductDescription:'中央主产品',referenceWarnings:[],checks:{descriptionMatches:true,allMatchingTargetsFound:true,
      wholeTargetInsideRegion:true,protectedContentExcluded:false,referenceUsable:true,referenceRecognizable:true,referencePrimaryProductClear:true}}),
  {targetMode:'ALL_MATCHES',targetRegion:{x:100,y:200,width:500,height:600}});
  assert.equal(result.passed,false);assert.equal(result.sourcePassed,false);assert.equal(result.localizationPassed,true);
  assert.equal(result.executionAllowed,true);assert.equal(result.advisory,true);assert.equal(result.blocking,false);
  assert.deepEqual(result.warnings,['第二个目标包含持握手指']);
});
test('the legacy target-check parser still records strict reference failures',()=>{
  const raw=JSON.stringify({passed:false,confidence:0.94,candidateCount:1,reason:'产品被裁切',referenceProductDescription:'中央主产品',
    checks:{descriptionMatches:true,exactlyOneTarget:true,wholeTargetInsideRegion:true,protectedContentExcluded:true,referenceUsable:false,referenceRecognizable:true,referencePrimaryProductClear:true}});
  const strict=parseFusionTargetCheck(raw),appearance=parseFusionTargetCheck(raw,{referenceMode:'APPEARANCE'});
  assert.equal(strict.passed,false);assert.equal(strict.sourcePassed,true);assert.equal(strict.referencePassed,false);
  assert.equal(appearance.passed,false,'model must explicitly approve the selected mode');
});
test('an incomplete single-target box goes directly to the paid image model',async()=>{
  const source=await png('white'),reference=await png('coral',120,120),generated=await png('#eeeeee'),config={imageEditPrompt,references:[{assetId:9,purpose:'真实产品替换'}],instruction:'替换右侧人物手持的红本',preserve:'保留其他内容',negative:'不要改文字',target:{description:'右侧人物手持的红色证件本',region:{x:760,y:520,width:180,height:210}}};
  let completed=null,imageCalls=0,visionCalls=0;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_FUSION',config}),context:async()=>({source:{id:1},refs:[{id:9,sha256:'b'.repeat(64)}],settings:{aiDisclosureEnabled:false},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),readAsset:async asset=>asset.id===1?source:reference,
    fail:async(_edit,error)=>assert.fail(error.message),complete:async(_edit,result)=>{completed=result;return{};}};
  const agentClient={runImageEdit:async({prompt,inputPaths,outputPath})=>{imageCalls++;assert.equal(inputPaths.length,2);assert.match(prompt,/即使目标的上沿、右侧或其他可见部分超出框外/u);assert.match(prompt,/手部、手指/u);await writeFile(outputPath,generated);return{model:'fake-fusion'};},runVision:async({prompt})=>{visionCalls++;assert.doesNotMatch(prompt,/目标定位校验器/u);return{rawText:JSON.stringify({passed:true,reason:'红本已完整替换且手部未改变',checks:{referenceIdentity:true,targetLocation:true,singleReplacement:true,partTopology:true,unrelatedContentPreserved:true}}),model:'fake-review'};}};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-fusion-ambiguous-'));
  try{const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage:async()=>visionPass()});assert.equal(result.status,'PREVIEW_READY');assert.equal(imageCalls,1);assert.equal(visionCalls,1);assert.equal(completed.validation.localization.preflightPerformed,false);assert.equal(completed.validation.outsideMask.mode,'MODEL_FULL_FRAME_WITH_RESULT_REVIEW');}finally{await rm(dir,{recursive:true,force:true});}
});
test('exact entity composition keeps source pixels outside placement and does not call any model',async()=>{
  const source=await png('red'),reference=await png('blue',20,20);
  const config={references:[{assetId:9,x:200,y:500,width:100,height:100,z:0,opacity:1,removeBackground:false,crop:{x:0,y:0,width:10,height:10}}]};
  let completed;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'COMPOSITE',config}),context:async()=>({source:{id:1},refs:[{id:9,sha256:'b'.repeat(64)}],settings:{aiDisclosureEnabled:false},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}}}),readAsset:async asset=>asset.id===1?source:reference,
    fail:async(e,error)=>assert.fail(error.message),complete:async(e,result)=>{completed=result;return{};}};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-composite-'));
  try{const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient:{runImageEdit:()=>assert.fail('no model'),runVision:()=>assert.fail('no model')},validateImage:async()=>visionPass()});assert.equal(result.status,'PREVIEW_READY');
    const raw=await sharp(completed.bytes).ensureAlpha().raw().toBuffer();assert.deepEqual([...raw.subarray(0,4)],[255,0,0,255]);const index=(550*1086+250)*4;assert.deepEqual([...raw.subarray(index,index+4)],[0,0,255,255]);assert.equal(completed.validation.entityConsistency.mode,'DETERMINISTIC_PIXEL_COMPOSITE');
  }finally{await rm(dir,{recursive:true,force:true});}
});
