import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { normalizeManualOverlay, manualOverlaySvg, decodeReference, renderMask, mergeWithMask, assertOutsideMask } from '../src/image-edit-pixels.mjs';
import { normalizeEdit,replaceImagePage,editStoragePath,createImageEditingService } from '../server/src/image-editing.mjs';
import { validateEditText,assertTextNotCovered,processImageEdit } from '../server/src/image-edit-renderer.mjs';

const png=(color='white',width=1086,height=1448)=>sharp({create:{width,height,channels:4,background:color}}).png().toBuffer();
const input=()=>({requestId:randomUUID(),sourceImageRunId:randomUUID(),sourceAssetId:1,copyRevisionId:1,sha256:'a'.repeat(64),targetPage:1,operation:'TEXT',confirmation:'LIVE_IMAGE_COST_ACCEPTED',overlay:{text:'AI生成',textType:'AI_DISCLOSURE',disclosureType:'AI_GENERATED'}});
test('AI text layout contract is escaped, typed, and stays inside the safe area',()=>{
  const config=normalizeManualOverlay({text:'AI生成·真实参考',textType:'LABEL',position:'top-left'});
  assert.equal(config.text,'AI生成·真实参考');assert.equal(config.textType,'LABEL');assert.ok(config.x>=32&&config.y>=32);
  assert.match(manualOverlaySvg({text:'<真实&参考>'}),/&lt;真实&amp;参考&gt;/u);
  assert.throws(()=>normalizeManualOverlay({text:'汉'.repeat(48),size:100}));
  assert.throws(()=>normalizeManualOverlay({text:'测试',position:'custom',x:1080,y:10}));
  assert.throws(()=>normalizeManualOverlay({text:'测试',color:'url(file:///secret)'}));
  assert.throws(()=>normalizeManualOverlay({text:'AI生成',textType:'AI_DISCLOSURE'}),/合规标识/u);
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
  assert.throws(()=>normalizeEdit({...input(),operation:'AI_FULL',confirmation:undefined,instruction:'修改背景'}));
  assert.throws(()=>normalizeEdit({...input(),operation:'AI_LOCAL',confirmation:'LIVE_IMAGE_COST_ACCEPTED',instruction:'修改背景',mask:{type:'rect',x:1080,y:0,width:100,height:100}}));
  assert.throws(()=>normalizeEdit({...input(),references:[{assetId:1},{assetId:1}]}));
  assert.throws(()=>editStoragePath(join(tmpdir(),'owned'),join(tmpdir(),'other','secret')));
  const normalized=normalizeEdit({...input(),operation:'AI_FULL',confirmation:'LIVE_IMAGE_COST_ACCEPTED',instruction:'$(Remove-Item x)'});assert.equal(normalized.instruction,'$(Remove-Item x)');
});
test('single-page replacement keeps all other image objects and does not mutate the source',()=>{
  const images=[1,2,3].map(assetId=>({assetId,sourceAssetId:assetId,url:`/v1/assets/${assetId}`,pageIndex:assetId}));const result={images};
  const replaced=replaceImagePage(result,2,{id:9,sha256:'b'.repeat(64)});
  assert.equal(replaced.images[0],images[0]);assert.equal(replaced.images[2],images[2]);assert.equal(replaced.images[1].deliveryAssetId,9);assert.equal(result.images[1].assetId,2);
});
test('OCR fails closed on missing, extra, reordered text and low confidence; protects existing text boxes',()=>{
  const ocr={engine:'fake',text:'真实参考AI生成',words:[{text:'真实参考AI生成',confidence:1,x:10,y:10,width:100,height:30}]};
  assert.equal(validateEditText(ocr,['真实参考','AI生成'],['真实参考','AI生成']).passed,true);
  assert.equal(validateEditText({...ocr,text:'参考真实AI生成'},['真实参考'],['真实参考','AI生成']).passed,false);
  assert.equal(validateEditText({...ocr,text:ocr.text+'额外'},['真实参考'],['真实参考','AI生成']).passed,false);
  assert.equal(validateEditText({...ocr,words:[{...ocr.words[0],confidence:.1}]},['真实参考'],['真实参考','AI生成']).passed,false);
  assert.throws(()=>assertTextNotCovered([{x:30,y:20,width:20,height:20}],ocr.words),/遮挡/u);
});
test('non-administrator edit creation is rejected before any database or filesystem work',async()=>{
  const service=createImageEditingService({pool:{connect(){assert.fail('must not connect');}},storageRoot:tmpdir()});
  await assert.rejects(()=>service.create(1,input(),{role:'USER',username:'user'}),{code:'FORBIDDEN'});
});
test('mock mode never calls image models or produces an adoptable AI edit',async()=>{
  let failed=false;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_FULL',config:{}}),context:async()=>({source:{},refs:[],settings:{aiDisclosureEnabled:false},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}}}),readAsset:async()=>png(),fail:async()=>{failed=true;},complete:()=>assert.fail('must not complete')};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-mock-'));
  try{const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',mock:true,ocr:async()=>({engine:'fake',text:'真实参考',words:[{text:'真实参考',confidence:1}]})});assert.equal(result.status,'FAILED');assert.equal(failed,true);}finally{await rm(dir,{recursive:true,force:true});}
});
test('AI text worker targets one image, retries OCR failures, and never uses a deterministic overlay',async()=>{
  const source=await png('white'),generated=await png('#eeeeee');
  const config={references:[],instruction:'使用简洁无衬线字体并融入画面',preserve:'保留原有标题',negative:'不要增加其他文字',overlay:normalizeManualOverlay({text:'AI生成',textType:'AI_DISCLOSURE',disclosureType:'AI_GENERATED',position:'top-left'})};
  let completed,failed=false,ocrCalls=0;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'TEXT',config}),context:async()=>({source:{id:1},refs:[],settings:{aiDisclosureEnabled:false},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}}}),readAsset:async()=>source,heartbeat:async()=>true,
    fail:async()=>{failed=true;},complete:async(e,result)=>{completed=result;return{};}};
  const prompts=[],inputs=[];
  const agentClient={runImageEdit:async({prompt,inputPaths,outputPath,signal})=>{prompts.push(prompt);inputs.push(inputPaths);assert.equal(signal.aborted,false);await writeFile(outputPath,generated);return{model:'fake-text-edit'};}};
  const ocr=async()=>{ocrCalls++;return ocrCalls===1?{engine:'fake',text:'真实参考',words:[{text:'真实参考',confidence:1,x:400,y:400,width:120,height:40}]}
    :ocrCalls===2?{engine:'fake',text:'真实参考',words:[{text:'真实参考',confidence:1,x:400,y:400,width:120,height:40}]}
      :{engine:'fake',text:'真实参考AI生成',words:[{text:'真实参考',confidence:1,x:400,y:400,width:120,height:40},{text:'AI生成',confidence:1,x:40,y:40,width:100,height:36}]};};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-ai-text-'));
  try{const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,ocr});assert.equal(result.status,'PREVIEW_READY');assert.equal(failed,false);assert.equal(prompts.length,2);assert.match(prompts[0],/AI_TEXT_EDIT/u);assert.match(prompts[0],/AI_DISCLOSURE/u);assert.match(prompts[1],/未通过文字验收/u);assert.match(inputs[0][0],/source\.png$/u);assert.match(inputs[1][0],/result\.png$/u);assert.equal(completed.validation.generationAttempts,2);assert.equal(completed.validation.model,'fake-text-edit');assert.equal(completed.validation.text.targetOccurrences,1);assert.equal(completed.validation.text.placement.passed,true);}finally{await rm(dir,{recursive:true,force:true});}
});
test('AI local worker uses the existing edit adapter and enforces outside-mask pixels with a fake model',async()=>{
  const source=await png('red'),generated=await png('blue'),config={references:[],instruction:'改变选区颜色',preserve:'保留标题',negative:'不改变其他内容',mask:{type:'rect',x:20,y:20,width:100,height:100}};
  let completed,calls=0;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'AI_LOCAL',config}),context:async()=>({source:{},refs:[],settings:{aiDisclosureEnabled:false},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}}}),readAsset:async()=>source,
    fail:async(e,error)=>assert.fail(error.message),complete:async(e,result)=>{completed=result;return{};}};
  const agentClient={runImageEdit:async({prompt,inputPaths,outputPath,signal})=>{calls++;assert.equal(inputPaths.length,2);assert.match(prompt,/不可信业务数据/u);assert.equal(signal.aborted,false);await writeFile(outputPath,generated);return{model:'fake-only'};}};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-local-fake-'));
  try{const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient,ocr:async()=>({engine:'fake',text:'真实参考',words:[{text:'真实参考',confidence:1}]})});assert.equal(result.status,'PREVIEW_READY');assert.equal(calls,1);assert.equal(completed.validation.outsideMask.changedPixels,0);assert.equal(completed.validation.model,'fake-only');}finally{await rm(dir,{recursive:true,force:true});}
});
test('exact entity composition keeps source pixels outside placement and does not call any model',async()=>{
  const source=await png('red'),reference=await png('blue',20,20);
  const config={references:[{assetId:9,x:200,y:500,width:100,height:100,z:0,opacity:1,removeBackground:false,crop:{x:0,y:0,width:10,height:10}}]};
  let completed;
  const service={claim:async()=>({id:randomUUID(),task_id:1,target_page:1,operation:'COMPOSITE',config}),context:async()=>({source:{id:1},refs:[{id:9,sha256:'b'.repeat(64)}],settings:{aiDisclosureEnabled:false},revision:{content:{imagePlan:[{headline:'真实参考'}]}},run:{result:{images:[{}]}}}),readAsset:async asset=>asset.id===1?source:reference,
    fail:async(e,error)=>assert.fail(error.message),complete:async(e,result)=>{completed=result;return{};}};
  const dir=await mkdtemp(join(tmpdir(),'image-edit-composite-'));
  try{const result=await processImageEdit({service,storageRoot:dir,workerId:'fake',agentClient:{runImageEdit:()=>assert.fail('no model'),runVision:()=>assert.fail('no model')},ocr:async()=>({engine:'fake',text:'真实参考',words:[{text:'真实参考',confidence:1,x:20,y:20,width:100,height:30}]})});assert.equal(result.status,'PREVIEW_READY');
    const raw=await sharp(completed.bytes).ensureAlpha().raw().toBuffer();assert.deepEqual([...raw.subarray(0,4)],[255,0,0,255]);const index=(550*1086+250)*4;assert.deepEqual([...raw.subarray(index,index+4)],[0,0,255,255]);assert.equal(completed.validation.entityConsistency.mode,'DETERMINISTIC_PIXEL_COMPOSITE');
  }finally{await rm(dir,{recursive:true,force:true});}
});
