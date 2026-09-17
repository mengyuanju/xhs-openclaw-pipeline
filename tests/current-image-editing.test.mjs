import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { normalizeManualOverlay, manualOverlaySvg, decodeReference, renderMask, renderRegionsMask, mergeWithMask, changedPixelMask, assertOutsideMask } from '../src/image-edit-pixels.mjs';
import { normalizeEdit,replaceImagePage,editStoragePath,createImageEditingService } from '../server/src/image-editing.mjs';
import { disclosurePlacementRegion, parseFusionTargetCheck, parseLocalTargetCheck, processImageEdit } from '../server/src/image-edit-renderer.mjs';

const png=(color='white',width=1086,height=1448)=>sharp({create:{width,height,channels:4,background:color}}).png().toBuffer();
const visionPass=(labels=[])=>({passed:true,model:'fake-vision',layoutMatched:true,ocrConfidence:1,
  ocrMismatches:[],unreadableText:[],recognizedText:{headline:'真实参考',subtitle:'',bullets:[],otherText:labels}});
const localResultPass=()=>({passed:true,reason:'修改完成且未影响无关内容',checks:{requestedChangeCompleted:true,targetCountCorrect:true,
  placementAndRepairNatural:true,protectedTextPreserved:true,unrelatedContentPreserved:true}});
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
  assert.throws(()=>normalizeEdit({...input(),batchId,operation:'AI_LOCAL',instruction:'修改背景'}),/只有人工生成标识支持/u);
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
  const appearance=normalizeEdit({...input(),operation:'AI_FUSION',instruction:'按可见外观替换产品',references:[{assetId:1}],referenceMode:'APPEARANCE',
    target:{description:'右侧台面上的白色杯子',region:{x:700,y:500,width:220,height:240}}});
  assert.equal(appearance.referenceMode,'APPEARANCE');
  assert.throws(()=>normalizeEdit({...input(),operation:'AI_FUSION',instruction:'替换产品',references:[{assetId:1}],referenceMode:'SKIP',
    target:{description:'杯子',region:{x:700,y:500,width:220,height:240}}}),/使用方式无效/u);
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
test('mock mode never calls image models or produces an adoptable AI edit',async()=>{
  let failed=false;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_FULL',config:{}}),context:async()=>({source:{},refs:[],settings:{aiDisclosureEnabled:false},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}}}),readAsset:async()=>png(),fail:async()=>{failed=true;},complete:()=>assert.fail('must not complete')};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-mock-'));
  try{const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',mock:true,validateImage:async()=>visionPass()});assert.equal(result.status,'FAILED');assert.equal(failed,true);}finally{await rm(dir,{recursive:true,force:true});}
});
test('source visual precheck retries once and stores both failures for operator feedback',async()=>{
  let failedError=null,validationCalls=0;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_LOCAL',config:{references:[],instruction:'修改右上角背景',preserve:'保留标题',negative:'不要增加文字'}}),
    context:async()=>({source:{id:1},refs:[],settings:{aiDisclosureEnabled:false},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}}}),
    readAsset:async()=>png(),heartbeat:async()=>true,fail:async(e,error)=>{failedError=error;},complete:()=>assert.fail('must not complete')};
  const validateImage=async()=>{validationCalls++;return{...visionPass(),passed:false,ocrConfidence:0.6,ocrMismatches:['headline']};};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-source-check-'));
  try{const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',validateImage});assert.equal(result.status,'FAILED');assert.equal(validationCalls,2);assert.equal(failedError.validation.stage,'SOURCE');assert.equal(failedError.validation.checks.length,2);}finally{await rm(dir,{recursive:true,force:true});}
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
test('AI local worker localizes the operator prompt and protects every pixel outside the detected target',async()=>{
  const source=await png('red'),generated=await png('blue'),config={imageEditPrompt,references:[],instruction:'把画面右上角的水杯改为蓝色，保持其他区域不变',preserve:'保留标题和所有未点名区域',negative:'不得改写文字',mask:null};
  let completed,calls=0,visionCalls=0;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_LOCAL',config}),context:async()=>({source:{},refs:[],settings:{aiDisclosureEnabled:false},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),readAsset:async()=>source,
    fail:async(e,error)=>assert.fail(error.message),complete:async(e,result)=>{completed=result;return{};}};
  const agentClient={runImageEdit:async({prompt,inputPaths,outputPath})=>{calls++;assert.equal(inputPaths.length,2);assert.match(prompt,/LOCAL_MASK_EDIT/u);assert.match(prompt,/画面右上角的水杯/u);assert.match(prompt,/根据自然语言编辑规划生成/u);assert.match(inputPaths[1],/mask\.png$/u);await writeFile(outputPath,generated);return{model:'fake-prompt-local'};},
    runVision:async({prompt,inputPaths})=>{visionCalls++;
      if(prompt.includes('编辑规划器')){assert.equal(inputPaths.length,1);return{model:'fake-planner',rawText:JSON.stringify({decision:'READY',confidence:0.94,candidateCount:1,operationType:'ADJUST',targetDescription:'右上角水杯',touchesImageEdge:false,missingPartsRequiredForEdit:false,sourceRegion:{x:700,y:180,width:220,height:260},destinationRegion:null,editRegions:[{x:700,y:180,width:220,height:260}],suggestedInstruction:'',warnings:[],reason:'唯一目标',checks:{instructionSpecific:true,exactlyOneTarget:true,wholeVisibleTargetInsideRegion:true,protectedTextExcluded:true,editRegionSafe:true}})};}
      assert.match(prompt,/局部图片编辑验收器/u);assert.equal(inputPaths.length,2);return{model:'fake-result-check',rawText:JSON.stringify(localResultPass())};}};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-prompt-local-fake-'));
  try{const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage:async()=>visionPass()});assert.equal(result.status,'PREVIEW_READY');assert.equal(calls,1);assert.equal(visionCalls,2);assert.ok(Buffer.isBuffer(completed.mask));assert.equal(completed.validation.outsideMask.changedPixels,0);assert.equal(completed.validation.localization.mode,'VISION_PROMPT_REGION_CHECK');assert.deepEqual(completed.validation.localization.region,{x:700,y:180,width:220,height:260});assert.equal(completed.validation.localConsistency.passed,true);}finally{await rm(dir,{recursive:true,force:true});}
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
test('a uniquely identified edge-clipped move returns an adoptable suggestion before image generation',async()=>{
  const planned={decision:'SUGGEST',confidence:0.96,candidateCount:1,operationType:'MOVE',targetDescription:'右下角正在倒老抽的汤勺和可见液流',
    targetIsAiDisclosure:false,touchesImageEdge:true,missingPartsRequiredForEdit:false,
    sourceRegion:{x:910,y:965,width:176,height:483},destinationRegion:{x:470,y:850,width:260,height:460},
    editRegions:[{x:890,y:940,width:196,height:508},{x:430,y:810,width:340,height:540}],
    suggestedInstruction:'将右下角正在倒老抽的汤勺及液流移动到锅的左上方，把勺中老抽减少为半勺，保持连续液流准确落入锅内，并自然修复原位置；不要修改上方文字和其他内容。',
    warnings:['源目标贴住右侧和底部边缘'],reason:'目标唯一且可按可见部分修改，但原说明需要明确新位置与原位置修复。',
    checks:{instructionSpecific:true,exactlyOneTarget:true,wholeVisibleTargetInsideRegion:true,protectedTextExcluded:true,editRegionSafe:true}};
  const parsed=parseLocalTargetCheck(JSON.stringify(planned));
  assert.equal(parsed.canEdit,true);assert.equal(parsed.passed,false);assert.equal(parsed.touchesImageEdge,true);assert.equal(parsed.editRegions.length,2);
  const source=await png('red'),config={imageEditPrompt,references:[],instruction:'半勺老抽对应的配图，减少液体容量，同时调整位置到左侧，保证内容物倒进锅里',preserve:'保留其他区域',negative:'不得改写文字',mask:null};
  let failedError=null,imageCalls=0;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_LOCAL',config}),context:async()=>({source:{},refs:[],settings:{aiDisclosureEnabled:false},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),readAsset:async()=>source,
    fail:async(_edit,error)=>{failedError=error;},complete:()=>assert.fail('must not complete')};
  const agentClient={runImageEdit:async()=>{imageCalls++;},runVision:async()=>({model:'fake-planner',rawText:JSON.stringify(planned)})};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-edge-suggestion-'));
  try{const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage:async()=>visionPass()});assert.equal(result.status,'FAILED');assert.equal(imageCalls,0);assert.equal(failedError.nonBillablePreflightFailure,true);assert.equal(failedError.validation.stage,'LOCAL_EDIT_SUGGESTION');assert.equal(failedError.validation.suggestedInstruction,planned.suggestedInstruction);assert.equal(failedError.validation.billedImageGeneration,false);}finally{await rm(dir,{recursive:true,force:true});}
});
test('an accepted local suggestion reuses its plan, edits multiple regions, and runs result validation',async()=>{
  const source=await png('red'),generated=await png('blue');
  const instruction='将右下角汤勺和液流移动到锅的左上方，把勺中老抽减少为半勺，并自然修复原位置；不要修改文字和其他内容。';
  const config={imageEditPrompt,references:[],instruction,preserve:'保留其他区域',negative:'不得改写文字',mask:null,localPlan:{accepted:true,
    originalInstruction:'把右下角一勺老抽变成半勺并移到左侧',suggestedInstruction:instruction,sourceRegion:{x:910,y:965,width:176,height:483},destinationRegion:{x:470,y:850,width:260,height:460},
    editRegions:[{x:890,y:940,width:196,height:508},{x:430,y:810,width:340,height:540}],operationType:'MOVE',touchesImageEdge:true,
    targetDescription:'右下角汤勺和液流',warnings:['贴边'],reason:'采用模型建议',confidence:0.96,checks:{}}};
  let completed,imageCalls=0,visionCalls=0;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_LOCAL',config}),context:async()=>({source:{},refs:[],settings:{aiDisclosureEnabled:false},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),readAsset:async()=>source,
    fail:async(_edit,error)=>assert.fail(error.message),complete:async(_edit,result)=>{completed=result;return{};}};
  const agentClient={runImageEdit:async({prompt,inputPaths,outputPath})=>{imageCalls++;assert.equal(inputPaths.length,2);assert.match(prompt,/汤勺和液流移动到锅的左上方/u);assert.match(prompt,/一个或多个白色区域/u);await writeFile(outputPath,generated);return{model:'fake-local-edit'};},
    runVision:async({prompt,inputPaths})=>{visionCalls++;assert.doesNotMatch(prompt,/编辑规划器/u);assert.match(prompt,/局部图片编辑验收器/u);assert.equal(inputPaths.length,2);return{model:'fake-result-check',rawText:JSON.stringify(localResultPass())};}};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-accepted-suggestion-'));
  try{const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage:async()=>visionPass()});assert.equal(result.status,'PREVIEW_READY');assert.equal(imageCalls,1);assert.equal(visionCalls,1);assert.equal(completed.validation.localization.adoptedSuggestion,true);assert.equal(completed.validation.localization.editRegions.length,2);assert.equal(completed.validation.localConsistency.passed,true);assert.equal(completed.validation.outsideMask.changedPixels,0);}finally{await rm(dir,{recursive:true,force:true});}
});
test('ambiguous natural-language targets fail before the paid image model',async()=>{
  assert.equal(parseLocalTargetCheck(JSON.stringify({passed:true,confidence:0.7,candidateCount:2,region:{x:100,y:100,width:500,height:500},checks:{instructionSpecific:true,exactlyOneTarget:false,wholeTargetInsideRegion:true,protectedTextExcluded:true}})).passed,false);
  const source=await png('red'),config={imageEditPrompt,references:[],instruction:'把杯子改成蓝色',preserve:'保留其他区域',negative:'不得改写文字',mask:null};
  let failedError=null,imageCalls=0;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_LOCAL',config}),context:async()=>({source:{},refs:[],settings:{aiDisclosureEnabled:false},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),readAsset:async()=>source,
    fail:async(_edit,error)=>{failedError=error;},complete:()=>assert.fail('must not complete')};
  const agentClient={runImageEdit:async()=>{imageCalls++;},runVision:async()=>({model:'fake-vision',rawText:JSON.stringify({passed:false,confidence:0.7,candidateCount:2,targetDescription:'杯子',region:{x:100,y:100,width:500,height:500},reason:'画面里有两个杯子',checks:{instructionSpecific:true,exactlyOneTarget:false,wholeTargetInsideRegion:true,protectedTextExcluded:true}})})};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-prompt-local-ambiguous-'));
  try{const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage:async()=>visionPass()});assert.equal(result.status,'FAILED');assert.equal(imageCalls,0);assert.equal(failedError.nonBillablePreflightFailure,true);assert.equal(failedError.validation.stage,'LOCAL_TARGET_LOCALIZATION');assert.equal(failedError.validation.billedImageGeneration,false);}finally{await rm(dir,{recursive:true,force:true});}
});
test('AI fusion uses one real-product reference and the governed image-edit prompt',async()=>{
  const source=await png('white'),reference=await png('coral',120,120),generated=await png('#eeeeee');
  const config={imageEditPrompt,references:[{assetId:9,purpose:'真实产品替换'}],instruction:'替换右侧台面上的白色杯子',preserve:'保留原场景和文字',negative:'不得改变参考产品关键细节',
    target:{description:'右侧台面上的白色杯子',region:{x:700,y:500,width:220,height:240}}};
  let completed,editCalls=0,visionCalls=0;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_FUSION',config}),context:async()=>({source:{id:1},refs:[{id:9,sha256:'b'.repeat(64)}],settings:{aiDisclosureEnabled:false},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),readAsset:async asset=>asset.id===1?source:reference,
    fail:async(e,error)=>assert.fail(error.message),complete:async(e,result)=>{completed=result;return{};}};
  const agentClient={runImageEdit:async({prompt,inputPaths,outputPath})=>{editCalls++;assert.equal(inputPaths.length,3);assert.match(prompt,/管理员统一图片编辑规则/u);assert.match(prompt,/REAL_PRODUCT_REPLACEMENT/u);assert.match(prompt,/黑白遮罩/u);assert.match(prompt,/右侧台面上的白色杯子/u);await writeFile(outputPath,generated);return{model:'fake-fusion'};},runVision:async({prompt,inputPaths})=>{visionCalls++;
    if(prompt.includes('目标定位校验器')){assert.equal(inputPaths.length,2);return{rawText:JSON.stringify({passed:true,confidence:0.96,candidateCount:1,reason:'框内只有一个目标杯子',checks:{descriptionMatches:true,exactlyOneTarget:true,wholeTargetInsideRegion:true,protectedContentExcluded:true,referenceUsable:true}}),model:'fake-vision'};}
    assert.equal(inputPaths.length,3);assert.match(prompt,/倒数第二张是编辑前源图/u);assert.match(prompt,/partTopology/u);return{rawText:JSON.stringify({passed:true,reason:'产品、位置与部件一致',checks:{referenceIdentity:true,targetLocation:true,singleReplacement:true,partTopology:true,unrelatedContentPreserved:true}}),model:'fake-vision'};}};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-fusion-fake-'));
  try{const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage:async()=>visionPass()});assert.equal(result.status,'PREVIEW_READY');assert.equal(editCalls,1);assert.equal(visionCalls,2);assert.equal(completed.validation.localization.passed,true);assert.equal(completed.validation.localization.candidateCount,1);assert.equal(completed.validation.outsideMask.changedPixels,0);assert.equal(completed.validation.entityConsistency.passed,true);assert.deepEqual(completed.validation.entityConsistency.checks,{referenceIdentity:true,targetLocation:true,singleReplacement:true,partTopology:true,unrelatedContentPreserved:true});assert.equal(completed.validation.prompt.sha256,imageEditPrompt.sha256);}finally{await rm(dir,{recursive:true,force:true});}
});
test('appearance-reference fusion accepts an incomplete but unambiguous primary product',async()=>{
  const source=await png('white'),reference=await png('coral',120,120),generated=await png('#eeeeee');
  const config={imageEditPrompt,referenceMode:'APPEARANCE',references:[{assetId:9,purpose:'真实产品替换'}],instruction:'按主产品可见外观替换右侧杯子',preserve:'保留其他内容',negative:'不要改文字',
    target:{description:'右侧台面上的杯子',region:{x:700,y:500,width:220,height:240}}};
  let completed,imageCalls=0,visionCalls=0;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_FUSION',config}),context:async()=>({source:{id:1},refs:[{id:9,sha256:'b'.repeat(64)}],settings:{aiDisclosureEnabled:false},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),readAsset:async asset=>asset.id===1?source:reference,
    fail:async(_edit,error)=>assert.fail(error.message),complete:async(_edit,result)=>{completed=result;return{};}};
  const agentClient={runImageEdit:async({prompt,outputPath})=>{imageCalls++;assert.match(prompt,/可能有手部、手腕/u);assert.match(prompt,/忽略参考图中的手部/u);await writeFile(outputPath,generated);return{model:'fake-appearance-edit'};},runVision:async({prompt})=>{visionCalls++;
    if(prompt.includes('目标定位校验器'))return{model:'fake-vision',rawText:JSON.stringify({passed:true,confidence:0.94,candidateCount:1,reason:'主产品清楚，但底部被裁切',referenceProductDescription:'参考图中央的珊瑚红杯子',referenceWarnings:['底部被裁切','画面边缘有手部'],checks:{descriptionMatches:true,exactlyOneTarget:true,wholeTargetInsideRegion:true,protectedContentExcluded:true,referenceUsable:false,referenceRecognizable:true,referencePrimaryProductClear:true}})};
    assert.match(prompt,/referenceMode=APPEARANCE/u);return{model:'fake-vision',rawText:JSON.stringify({passed:true,reason:'可见外观和目标位置一致',checks:{referenceIdentity:true,targetLocation:true,singleReplacement:true,partTopology:true,unrelatedContentPreserved:true}})};}};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-fusion-appearance-'));
  try {
    const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage:async()=>visionPass()});
    assert.equal(result.status,'PREVIEW_READY');assert.equal(imageCalls,1);assert.equal(visionCalls,2);
    assert.equal(completed.validation.localization.referenceMode,'APPEARANCE');
    assert.equal(completed.validation.localization.checks.referenceUsable,false);
    assert.deepEqual(completed.validation.localization.referenceWarnings,['底部被裁切','画面边缘有手部']);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('strict fusion still rejects an incomplete reference before the paid image model',()=>{
  const raw=JSON.stringify({passed:false,confidence:0.94,candidateCount:1,reason:'产品被裁切',referenceProductDescription:'中央主产品',
    checks:{descriptionMatches:true,exactlyOneTarget:true,wholeTargetInsideRegion:true,protectedContentExcluded:true,referenceUsable:false,referenceRecognizable:true,referencePrimaryProductClear:true}});
  const strict=parseFusionTargetCheck(raw),appearance=parseFusionTargetCheck(raw,{referenceMode:'APPEARANCE'});
  assert.equal(strict.passed,false);assert.equal(strict.sourcePassed,true);assert.equal(strict.referencePassed,false);
  assert.equal(appearance.passed,false,'model must explicitly approve the selected mode');
});
test('ambiguous fusion targets fail before the paid image model and preserve the attempt',async()=>{
  const source=await png('white'),reference=await png('coral',120,120),config={imageEditPrompt,references:[{assetId:9,purpose:'真实产品替换'}],instruction:'替换杯子',preserve:'保留其他内容',negative:'不要改文字',target:{description:'台面上的杯子',region:{x:100,y:300,width:800,height:500}}};
  let failedError=null,imageCalls=0;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_FUSION',config}),context:async()=>({source:{id:1},refs:[{id:9,sha256:'b'.repeat(64)}],settings:{aiDisclosureEnabled:false},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),readAsset:async asset=>asset.id===1?source:reference,
    fail:async(e,error)=>{failedError=error;},complete:()=>assert.fail('must not complete')};
  const agentClient={runImageEdit:async()=>{imageCalls++;},runVision:async()=>({rawText:JSON.stringify({passed:false,confidence:0.55,candidateCount:3,reason:'框内包含三个杯子',checks:{descriptionMatches:true,exactlyOneTarget:false,wholeTargetInsideRegion:true,protectedContentExcluded:true,referenceUsable:true}}),model:'fake-vision'})};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-fusion-ambiguous-'));
  try{const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage:async()=>visionPass()});assert.equal(result.status,'FAILED');assert.equal(imageCalls,0);assert.equal(failedError.nonBillablePreflightFailure,true);assert.equal(failedError.validation.stage,'TARGET_LOCALIZATION');assert.equal(failedError.validation.candidateCount,3);assert.equal(failedError.validation.billedImageGeneration,false);}finally{await rm(dir,{recursive:true,force:true});}
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
