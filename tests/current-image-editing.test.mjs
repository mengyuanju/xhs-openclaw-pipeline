import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { normalizeManualOverlay, manualOverlaySvg, decodeReference, renderMask, mergeWithMask, assertOutsideMask } from '../src/image-edit-pixels.mjs';
import { normalizeEdit,replaceImagePage,editStoragePath,createImageEditingService } from '../server/src/image-editing.mjs';
import { processImageEdit } from '../server/src/image-edit-renderer.mjs';

const png=(color='white',width=1086,height=1448)=>sharp({create:{width,height,channels:4,background:color}}).png().toBuffer();
const visionPass=(labels=[])=>({passed:true,model:'fake-vision',layoutMatched:true,ocrConfidence:1,
  ocrMismatches:[],unreadableText:[],recognizedText:{headline:'真实参考',subtitle:'',bullets:[],otherText:labels}});
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
test('edit inputs reject commands, paths, unconfirmed AI, duplicate references and oversized selections',()=>{
  assert.throws(()=>normalizeEdit({...input(),path:'../../secret'}));
  assert.throws(()=>normalizeEdit({...input(),confirmation:undefined}),/确认/u);
  const unconfirmedDraft=normalizeEdit({...input(),confirmation:undefined,draft:true});
  assert.equal(unconfirmedDraft.draft,true);assert.equal(unconfirmedDraft.confirmation,null);
  assert.throws(()=>normalizeEdit({...input(),operation:'AI_FULL',confirmation:undefined,instruction:'修改背景'}));
  assert.throws(()=>normalizeEdit({...input(),operation:'AI_LOCAL',confirmation:'LIVE_IMAGE_COST_ACCEPTED',instruction:'修改背景',mask:{type:'rect',x:1080,y:0,width:100,height:100}}));
  assert.throws(()=>normalizeEdit({...input(),references:[{assetId:1},{assetId:1}]}));
  assert.throws(()=>normalizeEdit({...input(),operation:'AI_FUSION',instruction:'替换产品',references:[{assetId:1},{assetId:2}]}),/只能上传 1 张/u);
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
test('AI text worker targets one image, retries visual validation failures, and never uses a deterministic overlay',async()=>{
  const source=await png('white'),generated=await png('#eeeeee');
  const config={imageEditPrompt,references:[],instruction:'将人工生成标识显示为“人工创作”并放在右下角',preserve:'保留原有标题',negative:'不要增加其他文字',overlay:normalizeManualOverlay({text:'人工创作',textType:'AI_DISCLOSURE',disclosureType:'AI_GENERATED',position:'bottom-right'})};
  let completed,failed=false,generationCalls=0;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'TEXT',config}),context:async()=>({source:{id:1},refs:[],settings:{aiDisclosureEnabled:true,aiDisclosureText:'AI生成'},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}],imageEditValidation:{disclosure:{added:{type:'AI_GENERATED',text:'AI生成'}}}}},imageEditPrompt}),readAsset:async()=>source,heartbeat:async()=>true,
    fail:async()=>{failed=true;},complete:async(e,result)=>{completed=result;return{};}};
  const prompts=[],inputs=[];
  const agentClient={runImageEdit:async({prompt,inputPaths,outputPath,signal})=>{generationCalls++;prompts.push(prompt);inputs.push(inputPaths);assert.equal(signal.aborted,false);await writeFile(outputPath,generated);return{model:'fake-text-edit'};}};
  const validateImage=async()=>generationCalls===0?visionPass(['AI生成']):generationCalls===1
    ?{...visionPass(),passed:false,layoutMatched:false,ocrMismatches:['otherText'],repairInstruction:'补充 AI 生成标识'}
    :visionPass(['人工创作']);
  const dir=await mkdtemp(join(tmpdir(),'image-edit-ai-text-'));
  try{const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage});assert.equal(result.status,'PREVIEW_READY');assert.equal(failed,false);assert.equal(prompts.length,2);assert.match(prompts[0],/<trusted_business_rules kind="IMAGE_EDIT_SYSTEM">/u);assert.match(prompts[0],/管理员统一图片编辑规则/u);assert.match(prompts[0],/AI_DISCLOSURE_LABEL/u);assert.match(prompts[1],/未通过文字验收/u);assert.match(inputs[0][0],/source\.png$/u);assert.match(inputs[1][0],/result\.png$/u);assert.equal(completed.validation.generationAttempts,2);assert.equal(completed.validation.model,'fake-text-edit');assert.equal(completed.validation.text.engine,'existing-vision-alignment');assert.equal(completed.validation.text.targetOccurrences,1);assert.equal(completed.validation.text.placement.passed,true);assert.deepEqual(completed.validation.requiredText,['真实参考','人工创作']);assert.deepEqual(completed.validation.disclosure.added,{type:'AI_GENERATED',text:'人工创作'});assert.equal(completed.validation.prompt.versionId,17);}finally{await rm(dir,{recursive:true,force:true});}
});
test('AI text worker honors the frozen administrator repair limit',async()=>{
  const source=await png('white'),generated=await png('#eeeeee');
  const config={imageEditPrompt,imageEditRepairMaxAttempts:0,references:[],instruction:'添加合规标识',preserve:'保留原有标题',negative:'不要增加其他文字',overlay:normalizeManualOverlay({text:'AI生成',textType:'AI_DISCLOSURE',disclosureType:'AI_GENERATED',position:'bottom-right'})};
  let failedError=null,generationCalls=0,validationCalls=0;const validationRequests=[];
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'TEXT',config}),context:async()=>({source:{id:1},refs:[],settings:{aiDisclosureEnabled:true,aiDisclosureText:'AI生成',imageEditRepairMaxAttempts:2},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),readAsset:async()=>source,heartbeat:async()=>true,
    fail:async(e,error)=>{failedError=error;},complete:()=>assert.fail('must not complete')};
  const agentClient={runImageEdit:async({outputPath})=>{generationCalls++;await writeFile(outputPath,generated);return{model:'fake-text-edit'};}};
  const validateImage=async input=>{validationCalls++;validationRequests.push(input);return validationCalls===1?visionPass():{...visionPass(),passed:false,layoutMatched:false,ocrMismatches:['otherText'],repairInstruction:'补充 AI 生成标识'};};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-repair-limit-'));
  try{const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage});assert.equal(result.status,'FAILED');assert.equal(generationCalls,1);assert.equal(validationCalls,2);assert.deepEqual(validationRequests[0].requiredText,['真实参考']);assert.deepEqual(validationRequests[1].requiredText,['真实参考','AI生成']);assert.equal(failedError.validation.generationAttempts,1);assert.equal(failedError.validation.repairMaxAttempts,0);}finally{await rm(dir,{recursive:true,force:true});}
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
test('AI local worker locates the edit from the operator prompt without creating a mask',async()=>{
  const source=await png('red'),generated=await png('blue'),config={imageEditPrompt,references:[],instruction:'把画面右上角的水杯改为蓝色，保持其他区域不变',preserve:'保留标题和所有未点名区域',negative:'不得改写文字',mask:null};
  let completed,calls=0;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_LOCAL',config}),context:async()=>({source:{},refs:[],settings:{aiDisclosureEnabled:false},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),readAsset:async()=>source,
    fail:async(e,error)=>assert.fail(error.message),complete:async(e,result)=>{completed=result;return{};}};
  const agentClient={runImageEdit:async({prompt,inputPaths,outputPath})=>{calls++;assert.equal(inputPaths.length,1);assert.match(prompt,/LOCAL_PROMPT_EDIT/u);assert.match(prompt,/画面右上角的水杯/u);assert.doesNotMatch(prompt,/最后一个附件是黑白遮罩/u);await writeFile(outputPath,generated);return{model:'fake-prompt-local'};}};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-prompt-local-fake-'));
  try{const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage:async()=>visionPass()});assert.equal(result.status,'PREVIEW_READY');assert.equal(calls,1);assert.equal(completed.mask,null);assert.equal(completed.validation.outsideMask,null);assert.deepEqual(completed.validation.localization,{mode:'PROMPT',instruction:config.instruction});}finally{await rm(dir,{recursive:true,force:true});}
});
test('AI fusion uses one real-product reference and the governed image-edit prompt',async()=>{
  const source=await png('white'),reference=await png('coral',120,120),generated=await png('#eeeeee');
  const config={imageEditPrompt,references:[{assetId:9,purpose:'真实产品替换'}],instruction:'使用上传的真实产品参考图替换原图中的对应产品',preserve:'保留原场景和文字',negative:'不得改变参考产品关键细节'};
  let completed,editCalls=0,visionCalls=0;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_FUSION',config}),context:async()=>({source:{id:1},refs:[{id:9,sha256:'b'.repeat(64)}],settings:{aiDisclosureEnabled:false},task:{query:'测试选题',input:{}},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}},imageEditPrompt}),readAsset:async asset=>asset.id===1?source:reference,
    fail:async(e,error)=>assert.fail(error.message),complete:async(e,result)=>{completed=result;return{};}};
  const agentClient={runImageEdit:async({prompt,inputPaths,outputPath})=>{editCalls++;assert.equal(inputPaths.length,2);assert.match(prompt,/管理员统一图片编辑规则/u);assert.match(prompt,/REAL_PRODUCT_REPLACEMENT/u);await writeFile(outputPath,generated);return{model:'fake-fusion'};},runVision:async({prompt,inputPaths})=>{visionCalls++;assert.equal(inputPaths.length,3);assert.match(prompt,/倒数第二张是编辑前源图/u);assert.match(prompt,/partTopology/u);return{rawText:JSON.stringify({passed:true,reason:'产品、位置与部件一致',checks:{referenceIdentity:true,targetLocation:true,singleReplacement:true,partTopology:true,unrelatedContentPreserved:true}}),model:'fake-vision'};}};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-fusion-fake-'));
  try{const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,validateImage:async()=>visionPass()});assert.equal(result.status,'PREVIEW_READY');assert.equal(editCalls,1);assert.equal(visionCalls,1);assert.equal(completed.validation.entityConsistency.passed,true);assert.deepEqual(completed.validation.entityConsistency.checks,{referenceIdentity:true,targetLocation:true,singleReplacement:true,partTopology:true,unrelatedContentPreserved:true});assert.equal(completed.validation.prompt.sha256,imageEditPrompt.sha256);}finally{await rm(dir,{recursive:true,force:true});}
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
