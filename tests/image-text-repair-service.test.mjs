import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { normalizeEdit,createImageEditingService } from '../server/src/image-editing.mjs';
import { imageHash } from '../src/image-edit-pixels.mjs';
import { renderTextRepairReference, renderTextRepairGlyph, TEXT_REPAIR_FONT_SHA256, TEXT_REPAIR_RENDERER_VERSION } from '../src/text-repair-font.mjs';
import { initialTextRepairState, assertTextRepairApprovedCopy, normalizeTextRepairCheckpoint,
  textRepairArtifactMetadata, resetTextRepairReference, upgradeTextRepairStateForStandardFont,
  verifyTextRepairCompletion } from '../server/src/image-text-repair-state.mjs';

const item=(id,correctText,x=100)=>({id,correctText,region:{x,y:100,width:300,height:90}});
const request=items=>({requestId:randomUUID(),sourceImageRunId:randomUUID(),sourceAssetId:1,copyRevisionId:1,
  sha256:'a'.repeat(64),targetPage:1,operation:'AI_TEXT_REPAIR',confirmation:'LIVE_IMAGE_COST_ACCEPTED',textRepairs:items});
const png=(width,height,color)=>sharp({create:{width,height,channels:4,background:color}}).png().toBuffer();
const standardValidation=(text,sourceSha256,extra={})=>({passed:true,method:'STANDARD_FONT',correctText:text,sourceSha256,
  textRendering:{renderer:'STANDARD_FONT',text,fontSha256:TEXT_REPAIR_FONT_SHA256,rendererVersion:TEXT_REPAIR_RENDERER_VERSION},...extra});

test('font upgrade retains old references while invalidating only incompatible patch bindings',()=>{
  const sourceSha256='a'.repeat(64), oldHash='b'.repeat(64), currentHash='c'.repeat(64);
  const state={revision:7,references:[
    {text:'滩',status:'READY',assetId:11,sha256:oldHash,url:'/v1/assets/11',validation:{passed:true,model:'old-model',reason:'旧图片已通过'}},
    {text:'鼬',status:'READY',assetId:12,sha256:currentHash,validation:standardValidation('鼬',sourceSha256)},
  ],locations:[
    {id:'first',correctText:'滩',status:'COMPLETED',assetId:21,rect:{x:125,y:115,width:15,height:20}},
    {id:'second',correctText:'滩',status:'FAILED',assetId:22},
    {id:'third',correctText:'鼬',status:'COMPLETED',assetId:23,referenceSha256:currentHash,
      validation:standardValidation('鼬',sourceSha256,{referenceSha256:currentHash})},
    {id:'fourth',correctText:'鼬',status:'COMPLETED',assetId:24,referenceSha256:currentHash,validation:{passed:true,model:'old-model'}},
  ]};
  const original=structuredClone(state), upgraded=upgradeTextRepairStateForStandardFont(state,sourceSha256);
  assert.equal(upgraded.revision,8);
  assert.deepEqual(upgraded.references[0],{...state.references[0],status:'PENDING'});
  assert.equal(upgraded.references[0].assetId,11);assert.equal(upgraded.references[0].validation.reason,'旧图片已通过');
  assert.equal(upgraded.references[1],state.references[1]);assert.equal(upgraded.locations[2],state.locations[2]);
  for(const index of [0,1,3])assert.deepEqual(upgraded.locations[index],{id:state.locations[index].id,correctText:state.locations[index].correctText,status:'PENDING'});
  assert.deepEqual(state,original);assert.equal(upgradeTextRepairStateForStandardFont(upgraded,sourceSha256),upgraded);
});

test('font upgrade detects incompatible source, method, renderer, version, font and text without changing valid caches',()=>{
  const sourceSha256='a'.repeat(64), referenceHash='b'.repeat(64);
  const state={revision:3,references:[{text:'鳖',status:'READY',assetId:2,sha256:referenceHash,validation:standardValidation('鳖',sourceSha256)}],
    locations:[{id:'first',correctText:'鳖',status:'COMPLETED',assetId:3,referenceSha256:referenceHash,
      validation:standardValidation('鳖',sourceSha256,{referenceSha256:referenceHash})}]};
  assert.equal(upgradeTextRepairStateForStandardFont(state,sourceSha256),state);
  for(const mutate of [entry=>{entry.validation.sourceSha256='f'.repeat(64);},entry=>{entry.validation.method='MODEL';},
    entry=>{entry.validation.textRendering.renderer='MODEL';},entry=>{entry.validation.textRendering.rendererVersion='old';},
    entry=>{entry.validation.textRendering.fontSha256='f'.repeat(64);},entry=>{entry.validation.textRendering.text='错';}]) {
    const changed=structuredClone(state);mutate(changed.references[0]);
    const upgraded=upgradeTextRepairStateForStandardFont(changed,sourceSha256);
    assert.equal(upgraded.references[0].status,'PENDING');assert.equal(upgraded.references[0].assetId,2);
    assert.deepEqual(upgraded.locations[0],{id:'first',correctText:'鳖',status:'PENDING'});
  }
  const wrongBinding=structuredClone(state);wrongBinding.locations[0].validation.referenceSha256='f'.repeat(64);
  const upgraded=upgradeTextRepairStateForStandardFont(wrongBinding,sourceSha256);
  assert.equal(upgraded.references[0],wrongBinding.references[0]);assert.equal(upgraded.locations[0].assetId,undefined);
});

test('text repairs use a dedicated billable operation, generated references and strict request identity',()=>{
  const config=normalizeEdit(request([item('first','滩'),item('second','鼬',500)]));
  assert.equal(config.instruction,'修正已框选文字：滩、鼬');
  assert.deepEqual(config.references,[]);assert.equal(config.mask,null);
  assert.throws(()=>normalizeEdit({...request([item('first','滩')]),confirmation:null}),/确认/u);
  assert.throws(()=>normalizeEdit({...request([item('first','滩')]),references:[{assetId:2}]}),/仅实体/u);
  assert.throws(()=>normalizeEdit({...request([item('first','滩')]),operation:'AI_LOCAL',instruction:'修改文字'}),/只有文字修正/u);
});
test('task edits are limited to the approved page while standalone text uses operator input',()=>{
  const revision={content:{imagePlan:[{headline:'海滩',bullets:['看当天的天气和海滩开放信息']},{headline:'猫鼬'}]}};
  const config=normalizeEdit(request([item('first','滩')]));
  assert.doesNotThrow(()=>assertTextRepairApprovedCopy({},revision,{result:{}},config));
  assert.throws(()=>assertTextRepairApprovedCopy({},revision,{result:{}},{...config,textRepairs:[item('first','鼬')]}),/当前页/u);
  assert.throws(()=>assertTextRepairApprovedCopy({},revision,{result:{}},{...config,textRepairs:[{...item('first','滩'),contextText:'海滩当天已开放'}]}),/已批准/u);
  assert.doesNotThrow(()=>assertTextRepairApprovedCopy({task_kind:'STANDALONE_IMAGE_EDIT'},revision,{result:{}},{...config,textRepairs:[item('first','撬')]}));
});
test('lease checkpoint content cannot cross a request location, text or actual region',async()=>{
  const config=normalizeEdit(request([item('first','滩'),item('second','鼬',500)]));
  const state=initialTextRepairState(config.textRepairs);
  const bytes=await png(15,20,'black');
  const candidate={kind:'LOCATION',id:'first',rect:{x:125,y:115,width:15,height:20},bytes,
    validation:{passed:true,sourceSha256:config.sha256,correctText:'滩',referenceSha256:'b'.repeat(64)}};
  assert.throws(()=>normalizeTextRepairCheckpoint(candidate,config,state),/尚未/u);
  state.references[0]={text:'滩',status:'READY',assetId:2,sha256:'b'.repeat(64),validation:{passed:true}};
  assert.throws(()=>normalizeTextRepairCheckpoint({...candidate,text:'鼬'},config,state),/不匹配/u);
  assert.throws(()=>normalizeTextRepairCheckpoint({...candidate,id:'foreign'},config,state),/不属于/u);
  assert.throws(()=>normalizeTextRepairCheckpoint({...candidate,rect:{x:0,y:0,width:15,height:20}},config,state),/超出/u);
  assert.throws(()=>normalizeTextRepairCheckpoint({...candidate,validation:{...candidate.validation,sourceSha256:'c'.repeat(64)}},config,state),/冻结/u);
  assert.throws(()=>normalizeTextRepairCheckpoint({...candidate,validation:{...candidate.validation,referenceSha256:'c'.repeat(64)}},config,state),/其他版本/u);
  const checked=normalizeTextRepairCheckpoint(candidate,config,state);
  await assert.rejects(textRepairArtifactMetadata({...checked,bytes:await png(16,20,'black')},state),/尺寸/u);
  const metadata=await textRepairArtifactMetadata(checked,state);
  assert.equal(metadata.sha256,imageHash(bytes));
  assert.throws(()=>normalizeTextRepairCheckpoint({kind:'STATUS',text:'滩',status:'COMPLETED'},config,state),/状态/u);
});
test('regenerating one reference retains its passed review and clears only related locations',()=>{
  const state=initialTextRepairState([item('first','滩'),item('second','滩',450),item('third','鼬',750)]);
  for(const reference of state.references)Object.assign(reference,{status:'READY',assetId:2,sha256:'b'.repeat(64),
    width:1024,height:1024,byteSize:1000,validation:{passed:true,reason:'',sourceSha256:'a'.repeat(64),correctText:reference.text}});
  for(const location of state.locations)Object.assign(location,{status:'COMPLETED',assetId:3});
  const next=resetTextRepairReference(state,'滩');
  assert.deepEqual(next.references[0],{...state.references[0],status:'PENDING'});
  assert.equal(next.references[0].validation.passed,true);assert.equal(next.references[0].validation.reason,'');
  assert.equal(next.references[1],state.references[1]);assert.equal(next.revision,state.revision+1);
  assert.equal(next.locations[0].status,'PENDING');assert.equal(next.locations[1].status,'PENDING');
  assert.equal(next.locations[0].assetId,undefined);assert.equal(next.locations[1].assetId,undefined);
  assert.equal(next.locations[2].status,'COMPLETED');assert.equal(next.locations[2].assetId,3);
  assert.equal(state.locations[0].status,'COMPLETED');assert.equal(state.references[0].status,'READY');
});
test('regenerating a failed reference retains the latest picture and exact failure feedback without growing history',()=>{
  const reference={text:'鼬',status:'FAILED',assetId:8,url:'/v1/assets/8',sha256:'b'.repeat(64),
    width:1024,height:1024,byteSize:1500,message:'参考字形未通过检查',validation:{passed:false,confidence:0.84,
      recognizedText:'鼬（左侧部件字形不完整）',checks:{correctGlyphs:false,readable:true,noExtraText:true},
      reason:'左侧鼠部件缺少规范笔画',sourceSha256:'a'.repeat(64),correctText:'鼬'}};
  const state={revision:4,references:[reference],locations:[{id:'first',correctText:'鼬',status:'FAILED'}]};
  const next=resetTextRepairReference(state,'鼬');
  assert.deepEqual(next.references,[{...reference,status:'PENDING'}]);
  const repeated=resetTextRepairReference(next,'鼬');
  assert.deepEqual(repeated.references,next.references);assert.equal(repeated.references.length,1);
  assert.equal(repeated.revision,6);assert.equal(reference.status,'FAILED');
  assert.throws(()=>resetTextRepairReference(state,'鳖'),/当前修正项/u);
});
test('central completion independently enforces frozen patch bytes, actual glyph bounds and every successful location',async()=>{
  const config=normalizeEdit(request([item('first','滩'),item('second','滩',500)]));
  const source=await png(1086,1448,'white'),patch=await png(12,18,'black');
  const state=initialTextRepairState(config.textRepairs);
  state.references[0]={text:'滩',status:'READY',assetId:2,sha256:'b'.repeat(64),validation:{passed:true}};
  state.locations=state.locations.map((entry,index)=>({...entry,status:'COMPLETED',assetId:index+3,sha256:imageHash(patch),
    referenceSha256:'b'.repeat(64),rect:{x:index?530:130,y:120,width:12,height:18},validation:{passed:true}}));
  const result=await sharp(source).composite(state.locations.map(entry=>({input:patch,left:entry.rect.x,top:entry.rect.y}))).png().toBuffer();
  const verify=(candidate,progress=state)=>verifyTextRepairCompletion({config,state:progress,source,result:candidate,readAsset:async()=>patch});
  const verified=await verify(result);assert.equal(verified.outside.changedPixels,0);assert.equal(verified.regions.length,2);
  const outsideDrift=await sharp(result).composite([{input:await png(1,1,'red'),left:10,top:10}]).png().toBuffer();
  await assert.rejects(verify(outsideDrift),/遮罩外/u);
  const fakeInside=await sharp(result).composite([{input:await png(1,1,'red'),left:130,top:120}]).png().toBuffer();
  await assert.rejects(verify(fakeInside),/冻结/u);
  await assert.rejects(verify(result,{...state,locations:state.locations.map((entry,index)=>index?{...entry,status:'FAILED'}:entry)}),/未通过/u);
  await assert.rejects(verify(result,{...state,references:[{...state.references[0],sha256:'c'.repeat(64)}]}),/未通过/u);
});

test('a fake repository exercises persistent streamed references, replay and lease rejection without model calls',async()=>{
  const storageRoot=await mkdtemp(join(tmpdir(),'text-repair-service-'));
  const config=normalizeEdit(request([item('first','滩')]));
  let row={id:randomUUID(),task_id:1,source_image_run_id:config.sourceImageRunId,source_asset_id:1,
    source_sha256:config.sha256,copy_revision_id:1,target_page:1,operation:config.operation,config,
    status:'RUNNING',version:1,lease_token:randomUUID(),lease_expires_at:new Date(Date.now()+60_000).toISOString(),
    text_repair_state:initialTextRepairState(config.textRepairs)};
  const assets=[{id:1,task_id:1,sha256:config.sha256}];
  const run={id:config.sourceImageRunId,task_id:1,copy_revision_id:1,status:'COMPLETED',image_production_chain_id:config.sourceImageRunId,
    result:{images:[{assetId:1}]}};
  const query=async(sql,values=[])=>{
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return {rows:[]};
    if(sql.startsWith('SELECT * FROM image_edit_requests')||sql.includes('FROM image_edit_requests e LEFT JOIN')) {
      return {rows:[structuredClone({...row,created_by_account_id:1})]};
    }
    if(sql.startsWith('SELECT * FROM tasks'))return {rows:[{id:1,state:'MANUAL_ARCHIVE',current_copy_revision_id:1,current_image_run_id:config.sourceImageRunId}]};
    if(sql.startsWith('SELECT * FROM copy_revisions'))return {rows:[{id:1,approved_at:'2026-01-01',content:{imagePlan:[{headline:'海滩'}]}}]};
    if(sql.startsWith('SELECT * FROM image_runs'))return {rows:[run]};
    if(sql.startsWith('SELECT a.* FROM image_edit_reference_assets')||sql.startsWith('SELECT asset_id,sha256 FROM image_edit_reference_assets'))return {rows:[]};
    if(sql.startsWith('SELECT value FROM global_settings'))return {rows:[]};
    if(sql.startsWith('SELECT * FROM assets WHERE task_id='))return {rows:assets.filter(asset=>asset.task_id===Number(values[0])&&values[1].includes(asset.id)&&!asset.content_cleared_at)};
    if(sql.startsWith('SELECT * FROM assets'))return {rows:assets.filter(asset=>asset.id===Number(values[0]))};
    if(sql.startsWith('INSERT INTO assets')) {
      const asset={id:assets.length+1,task_id:values[0],image_run_id:values[1],byte_size:values[2],sha256:values[3],
        storage_path:values[4],original_name:values[5],asset_role:values[9],edit_metadata:values[10]};
      assets.push(asset);return {rows:[asset]};
    }
    if(sql.startsWith('UPDATE image_edit_requests SET text_repair_state')) {
      row={...row,text_repair_state:structuredClone(values[1]),version:row.version+1};return {rows:[],rowCount:1};
    }
    throw new Error(`Unexpected fake repository query: ${sql}`);
  };
  const pool={query,connect:async()=>({query,release(){}})};
  const service=createImageEditingService({pool,storageRoot});
  const edit=structuredClone(row);
  try {
    await assert.rejects(service.textRepairCheckpoint({...edit,lease_token:randomUUID()},{kind:'STATUS',text:'滩',status:'GENERATING'}),{code:'IMAGE_EDIT_CONFLICT'});
    await service.textRepairCheckpoint(edit,{kind:'STATUS',text:'滩',status:'GENERATING'});
    const bytes=await png(120,120,'white');
    const input={kind:'REFERENCE',text:'滩',bytes,validation:{passed:true,correctText:'滩',sourceSha256:config.sha256}};
    const entry=await service.textRepairCheckpoint(edit,input);
    const current=await service.get(edit.id),version=current.version;
    assert.equal(current.textRepairState.references[0].status,'READY');
    assert.equal(current.textRepairState.references[0].assetId,entry.assetId);
    assert.equal(JSON.stringify(current.textRepairState).includes(storageRoot),false);
    assert.deepEqual(await readFile(entry.asset.storage_path),bytes);
    assert.equal((await service.textRepairCheckpoint(edit,input)).assetId,entry.assetId);
    assert.equal((await service.get(edit.id)).version,version);
    await assert.rejects(service.textRepairCheckpoint(edit,{...input,bytes:await png(120,120,'black')}),{code:'IMAGE_EDIT_CONFLICT'});
    assert.equal(assets.length,2);
    row={...row,config:{...row.config,imageEditPrompt:{content:'frozen edit rules'}},
      text_repair_state:resetTextRepairReference(row.text_repair_state,'滩')};
    const pending=(await service.context(row)).textRepairState.references[0];
    assert.equal(pending.status,'PENDING');assert.equal(pending.assetId,entry.assetId);
    assert.deepEqual(pending.validation,input.validation);assert.deepEqual(await service.readAsset(pending.asset),bytes);
    const referenceAsset=assets.find(asset=>asset.id===entry.assetId),originalHash=referenceAsset.sha256;
    referenceAsset.sha256='f'.repeat(64);
    await assert.rejects(service.context(row),/文字修正资产已变化/u);
    referenceAsset.sha256=originalHash;referenceAsset.edit_metadata.editId=randomUUID();
    await assert.rejects(service.context(row),/文字修正资产已变化/u);
    referenceAsset.edit_metadata.editId=row.id;
    await writeFile(pending.asset.storage_path,await png(120,120,'black'));
    await assert.rejects(service.readAsset(pending.asset),/完整性/u);
    row={...row,lease_expires_at:new Date(Date.now()-1).toISOString()};
    await assert.rejects(service.textRepairCheckpoint(edit,input),{code:'IMAGE_EDIT_CONFLICT'});
  } finally {await rm(storageRoot,{recursive:true,force:true});}
});

async function standardFontUpgradeFixture({legacy=true}={}) {
  const storageRoot=await mkdtemp(join(tmpdir(),'text-repair-upgrade-'));
  const sourceBytes=await png(1086,1448,'white');
  const config={...normalizeEdit({...request([item('first','滩'),item('second','鼬',500)]),sha256:imageHash(sourceBytes)}),
    imageEditPrompt:{content:'frozen edit rules'}};
  const editId=randomUUID(),executionId=randomUUID(),cleanupJobs=[],queries=[];
  const assets=[];
  async function addAsset(id,bytes,role,text,locationId=null) {
    const path=join(storageRoot,`${id}.png`);await writeFile(path,bytes);
    const asset={id,task_id:1,sha256:imageHash(bytes),storage_path:path,asset_role:role,
      edit_metadata:{editId,text,locationId}};assets.push(asset);return asset;
  }
  await addAsset(1,sourceBytes,'DELIVERY');
  const oldReference=await addAsset(2,legacy?await png(120,120,'black'):(await renderTextRepairReference({text:'滩'})).png,'TEXT_REFERENCE','滩');
  const oldPatch=await addAsset(3,await png(15,20,'black'),'TEXT_PATCH','滩','first');
  const currentReference=await addAsset(4,(await renderTextRepairReference({text:'鼬'})).png,'TEXT_REFERENCE','鼬');
  const currentPatch=await addAsset(5,await png(15,20,'black'),'TEXT_PATCH','鼬','second');
  const reference=(text,asset,validation)=>({text,status:'READY',assetId:asset.id,sha256:asset.sha256,url:`/v1/assets/${asset.id}`,validation});
  const location=(id,text,asset,ref,x,validation)=>({id,correctText:text,status:'COMPLETED',assetId:asset.id,
    sha256:asset.sha256,referenceSha256:ref.sha256,rect:{x,y:115,width:15,height:20},validation});
  const legacyValidation={passed:true,sourceSha256:config.sha256,correctText:'滩',model:'legacy-model',reason:'旧字图检查已通过'};
  let row={id:editId,execution_id:executionId,task_id:1,source_image_run_id:config.sourceImageRunId,source_asset_id:1,
    source_sha256:config.sha256,copy_revision_id:1,target_page:1,operation:config.operation,config,status:'RUNNING',version:4,
    lease_token:randomUUID(),lease_expires_at:new Date(Date.now()+60_000).toISOString(),text_repair_state:{revision:2,
      references:[reference('滩',oldReference,legacy?legacyValidation:standardValidation('滩',config.sha256)),
        reference('鼬',currentReference,standardValidation('鼬',config.sha256))],
      locations:[location('first','滩',oldPatch,oldReference,125,legacy?{...legacyValidation,referenceSha256:oldReference.sha256}
        :standardValidation('滩',config.sha256,{referenceSha256:oldReference.sha256})),
      location('second','鼬',currentPatch,currentReference,525,standardValidation('鼬',config.sha256,{referenceSha256:currentReference.sha256}))]}};
  const run={id:config.sourceImageRunId,task_id:1,copy_revision_id:1,status:'COMPLETED',image_production_chain_id:config.sourceImageRunId,
    result:{images:[{assetId:1}]}};
  const reply=rows=>({rows,rowCount:rows.length});
  const query=async(sql,values=[])=>{
    queries.push(sql);
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return reply([]);
    if(sql.includes('FROM image_edit_requests e JOIN task_executions'))return reply([{...structuredClone(row),execution_status:'RUNNING'}]);
    if(sql.startsWith('SELECT * FROM image_edit_requests')||sql.includes('FROM image_edit_requests e LEFT JOIN'))return reply([structuredClone(row)]);
    if(sql.startsWith('SELECT * FROM tasks'))return reply([{id:1,state:'MANUAL_ARCHIVE',current_copy_revision_id:1,current_image_run_id:config.sourceImageRunId}]);
    if(sql.startsWith('SELECT id FROM tasks'))return reply([{id:1}]);
    if(sql.startsWith('SELECT * FROM copy_revisions'))return reply([{id:1,approved_at:'2026-01-01',content:{imagePlan:[{headline:'海滩猫鼬'}]}}]);
    if(sql.startsWith('SELECT * FROM image_runs'))return reply([run]);
    if(sql.startsWith('SELECT a.* FROM image_edit_reference_assets')||sql.startsWith('SELECT asset_id,sha256 FROM image_edit_reference_assets'))return reply([]);
    if(sql.startsWith('SELECT value FROM global_settings'))return reply([]);
    if(sql.startsWith('SELECT * FROM assets WHERE task_id='))return reply(assets.filter(asset=>values[1].includes(asset.id)&&!asset.content_cleared_at).map(asset=>structuredClone(asset)));
    if(sql.startsWith('SELECT * FROM assets'))return reply(assets.filter(asset=>asset.id===Number(values[0])&&(!sql.includes('content_cleared_at IS NULL')||!asset.content_cleared_at)).map(asset=>structuredClone(asset)));
    if(sql.includes('FROM assets a JOIN image_edit_requests e'))return reply(assets.filter(asset=>['TEXT_REFERENCE','TEXT_PATCH'].includes(asset.asset_role)&&!asset.content_cleared_at)
      .map(asset=>({...structuredClone(asset),repair_edit_id:row.id,repair_task_id:1,repair_operation:row.operation,text_repair_state:structuredClone(row.text_repair_state),workspace_deleted:false})));
    if(sql.includes('INSERT INTO image_reference_cleanup_jobs')) {if(!cleanupJobs.includes(values[0]))cleanupJobs.push(values[0]);return reply([]);}
    if(sql.includes('UPDATE assets SET content_cleared_at')) {assets.find(asset=>asset.id===values[0]).content_cleared_at=new Date().toISOString();return reply([]);}
    if(sql.includes('FROM image_reference_cleanup_jobs'))return reply([]);
    if(sql.startsWith('INSERT INTO assets')) {
      const asset={id:assets.length+1,task_id:values[0],image_run_id:values[1],byte_size:values[2],sha256:values[3],storage_path:values[4],
        original_name:values[5],asset_role:values[9],edit_metadata:values[10]};assets.push(asset);return reply([structuredClone(asset)]);
    }
    if(sql.startsWith('UPDATE image_edit_requests SET text_repair_state')) {row={...row,text_repair_state:structuredClone(values[1]),version:row.version+1};return reply([]);}
    if(sql.startsWith('UPDATE task_executions SET last_activity_at'))return reply([]);
    throw new Error(`Unexpected upgrade repository query: ${sql}`);
  };
  const pool={query,connect:async()=>({query,release(){}})};
  return {service:createImageEditingService({pool,storageRoot}),config,assets,cleanupJobs,queries,
    get row(){return structuredClone(row);},changeRow(changes){row={...row,...changes};},
    close:()=>rm(storageRoot,{recursive:true,force:true})};
}

test('running legacy retry upgrades once, retains old reference display and accepts new canonical checkpoints',async()=>{
  const f=await standardFontUpgradeFixture();
  try {
    const worker=f.row,original=f.row.text_repair_state;
    const context=await f.service.context(worker),state=context.textRepairState;
    assert.equal(state.references[0].status,'PENDING');assert.equal(state.references[0].assetId,2);
    assert.deepEqual(state.references[0].validation,original.references[0].validation);
    assert.deepEqual(await f.service.readAsset(state.references[0].asset),await png(120,120,'black'));
    assert.deepEqual(state.locations[0],{id:'first',correctText:'滩',status:'PENDING'});
    assert.equal(state.references[1].status,'READY');assert.equal(state.locations[1].assetId,5);
    assert.deepEqual(f.cleanupJobs,[3]);assert.equal(f.assets.find(asset=>asset.id===2).content_cleared_at,undefined);
    assert.ok(f.assets.find(asset=>asset.id===3).content_cleared_at);
    const version=f.row.version;await f.service.context(worker);assert.equal(f.row.version,version);
    const canonical=await renderTextRepairReference({text:'滩'});
    const checkpoint={kind:'REFERENCE',text:'滩',bytes:canonical.png,
      validation:standardValidation('滩',f.config.sha256,{textRendering:canonical.metadata})};
    const stored=await f.service.textRepairCheckpoint(worker,checkpoint);
    assert.equal(stored.status,'READY');assert.notEqual(stored.assetId,2);
    assert.deepEqual(f.cleanupJobs,[3,2]);assert.ok(f.assets.find(asset=>asset.id===2).content_cleared_at);
    assert.equal(f.assets.find(asset=>asset.id===4).content_cleared_at,undefined);
    assert.equal(f.assets.find(asset=>asset.id===5).content_cleared_at,undefined);
    const after=(await f.service.context(worker)).textRepairState;
    assert.equal(after.references[0].assetId,stored.assetId);assert.equal(after.locations[1].assetId,5);
    await assert.rejects(f.service.textRepairCheckpoint(worker,{...checkpoint,bytes:await png(1024,1024,'black')}),{code:'IMAGE_EDIT_CONFLICT'});
  } finally {await f.close();}
});

test('same-version font execution contexts remain unchanged and do not schedule cleanup',async()=>{
  const f=await standardFontUpgradeFixture({legacy:false});
  try {
    const original=f.row;await f.service.context(original);
    await f.service.executorContext(original.execution_id,original.id,original.lease_token);
    assert.deepEqual(f.row,original);assert.deepEqual(f.cleanupJobs,[]);
    assert.equal(f.queries.some(sql=>sql.startsWith('UPDATE image_edit_requests SET text_repair_state')),false);
  } finally {await f.close();}
});

test('a legacy completed patch can upgrade without discarding its current standard-font reference',async()=>{
  const f=await standardFontUpgradeFixture({legacy:false});
  try {
    const worker=f.row,state=worker.text_repair_state;
    delete state.locations[0].validation.method;state.locations[0].validation.model='legacy-model';
    f.changeRow({text_repair_state:state});
    const context=await f.service.executorContext(worker.execution_id,worker.id,worker.lease_token);
    assert.equal(context.textRepairState.references[0].status,'READY');
    assert.equal(context.textRepairState.references[0].assetId,2);
    assert.deepEqual(context.textRepairState.locations[0],{id:'first',correctText:'滩',status:'PENDING'});
    assert.deepEqual(f.cleanupJobs,[3]);
    const glyph=await renderTextRepairGlyph({text:'滩',width:15,height:20});
    const bytes=await sharp(await png(15,20,'white')).composite([{input:glyph.png}]).png().toBuffer();
    const checkpoint={kind:'LOCATION',id:'first',rect:{x:125,y:115,width:15,height:20},bytes,
      validation:standardValidation('滩',f.config.sha256,{textRendering:glyph.metadata,referenceSha256:state.references[0].sha256})};
    const stored=await f.service.executorTextRepairCheckpoint(worker.execution_id,worker.id,worker.lease_token,checkpoint);
    assert.equal(stored.status,'COMPLETED');assert.notEqual(stored.assetId,3);
    assert.equal(f.assets.find(asset=>asset.id===2).content_cleared_at,undefined);
    await assert.rejects(f.service.executorTextRepairCheckpoint(worker.execution_id,worker.id,worker.lease_token,
      {...checkpoint,bytes:await png(15,20,'red')}),{code:'IMAGE_EDIT_CONFLICT'});
  } finally {await f.close();}
});

test('stale, expired or cancelled leases cannot trigger font state upgrades and accepted history stays read-only',async()=>{
  for(const mode of ['wrong-token','expired','cancelled','accepted']) {
    const f=await standardFontUpgradeFixture();
    try {
      const worker=f.row;
      if(mode==='expired')f.changeRow({lease_expires_at:new Date(Date.now()-1000).toISOString()});
      if(mode==='cancelled')f.changeRow({status:'CANCELLED',lease_token:null});
      if(mode==='accepted')f.changeRow({status:'ACCEPTED',lease_token:null});
      const original=f.row,token=mode==='wrong-token'?randomUUID():worker.lease_token;
      await assert.rejects(f.service.context({...worker,lease_token:token}),{code:'IMAGE_EDIT_CONFLICT'});
      await assert.rejects(f.service.executorContext(worker.execution_id,worker.id,token),{code:'IMAGE_EDIT_CONFLICT'});
      const history=await f.service.get(worker.id);
      assert.deepEqual(history.textRepairState,original.text_repair_state);
      assert.deepEqual(f.row,original);assert.deepEqual(f.cleanupJobs,[]);
      assert.equal(f.queries.some(sql=>sql.startsWith('UPDATE image_edit_requests SET text_repair_state')),false);
    } finally {await f.close();}
  }
});

async function failedTextRepairFixture() {
  const storageRoot=await mkdtemp(join(tmpdir(),'text-repair-manual-accept-'));
  const sourceBytes=await png(1086,1448,'white');
  const config=normalizeEdit({...request([item('first','滩')]),sha256:imageHash(sourceBytes)});
  const sourcePath=join(storageRoot,'source.png');await writeFile(sourcePath,sourceBytes);
  const task={id:1,state:'MANUAL_ARCHIVE',current_copy_revision_id:1,current_image_run_id:config.sourceImageRunId};
  let edit={id:randomUUID(),task_id:1,source_image_run_id:config.sourceImageRunId,source_asset_id:1,
    source_sha256:config.sha256,copy_revision_id:1,target_page:1,operation:config.operation,config,
    status:'RUNNING',version:1,claimed_by:'fake-worker',attempts:1,lease_token:randomUUID(),
    lease_expires_at:new Date(Date.now()+60_000).toISOString(),text_repair_state:initialTextRepairState(config.textRepairs)};
  const assets=[{id:1,task_id:1,sha256:config.sha256,storage_path:sourcePath,asset_role:'DELIVERY'}];
  const runs=[{id:config.sourceImageRunId,task_id:1,copy_revision_id:1,status:'COMPLETED',
    image_production_chain_id:config.sourceImageRunId,result:{images:[{assetId:1}]}}];
  const events=[];let result=null;
  const reply=rows=>({rows,rowCount:rows.length});
  const query=async(sql,values=[])=>{
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return reply([]);
    if(sql.includes('FROM image_edit_requests e LEFT JOIN'))return reply([{...structuredClone(edit),result:structuredClone(result),events:structuredClone(events)}]);
    if(sql.startsWith('SELECT * FROM image_edit_requests')||sql.includes('FROM image_edit_requests e WHERE'))return reply([structuredClone(edit)]);
    if(sql.includes('SELECT u.id FROM app_users'))return reply([{id:1}]);
    if(sql.startsWith('SELECT id FROM tasks'))return reply([{id:1}]);
    if(sql.startsWith('SELECT * FROM tasks'))return reply([structuredClone(task)]);
    if(sql.startsWith('SELECT * FROM copy_revisions'))return reply([{id:1,approved_at:'2026-01-01',content:{imagePlan:[{headline:'海滩'}]}}]);
    if(sql.startsWith('SELECT * FROM image_runs'))return reply(runs.filter(run=>run.id===values[0]).map(run=>structuredClone(run)));
    if(sql.startsWith('SELECT * FROM assets'))return reply(assets.filter(asset=>asset.id===Number(values[0])&&asset.task_id===Number(values[1])).map(asset=>structuredClone(asset)));
    if(sql.startsWith('SELECT * FROM image_edit_events'))return reply(events.filter(event=>event.task_id===values[0]&&event.request_id===values[1]));
    if(sql.startsWith('SELECT * FROM image_edit_results'))return reply(result?[structuredClone(result)]:[]);
    if(sql.startsWith('INSERT INTO image_runs')) {
      const run={id:values[0],task_id:values[1],copy_revision_id:values[3],status:'FAILED',
        image_production_chain_id:values[0],result:values[4]};runs.push(run);return reply([structuredClone(run)]);
    }
    if(sql.startsWith('INSERT INTO assets')) {
      const asset={id:assets.length+1,task_id:values[0],image_run_id:values[1],byte_size:values[2],sha256:values[3],
        storage_path:values[4],original_name:values[5],parent_asset_id:values[8],asset_role:values[9],edit_metadata:values[10]};
      assets.push(asset);return reply([structuredClone(asset)]);
    }
    if(sql.startsWith('UPDATE image_runs SET result')) {runs.find(run=>run.id===values[0]).result=structuredClone(values[1]);return reply([]);}
    if(sql.startsWith("UPDATE image_runs SET status='COMPLETED'")) {
      const run=runs.find(run=>run.id===values[0]&&run.task_id===values[1]&&run.status==='FAILED');
      if(!run)return reply([]);run.status='COMPLETED';return reply([{id:run.id}]);
    }
    if(sql.startsWith('INSERT INTO image_run_asset_members'))return reply(assets.filter(asset=>asset.id===values[1]&&asset.task_id===values[2]).map(asset=>({asset_id:asset.id})));
    if(sql.startsWith('INSERT INTO image_edit_results')) {result={request_id:values[0],asset_id:values[1],image_run_id:values[2],validation:structuredClone(values[3]),adopted:false};return reply([]);}
    if(sql.startsWith("UPDATE image_edit_requests SET status='FAILED'")) {
      edit={...edit,status:'FAILED',error:values[1],validation:structuredClone(values[2]),version:edit.version+1,lease_token:null,lease_expires_at:null};return reply([]);
    }
    if(sql.startsWith('UPDATE image_edit_requests SET status=$2')) {
      edit={...edit,status:values[1],config:values[2],version:edit.version+1,error:null};return reply([structuredClone(edit)]);
    }
    if(sql.startsWith("UPDATE assets SET asset_role='DELIVERY'")) {assets.find(asset=>asset.id===values[0]).asset_role='DELIVERY';return reply([]);}
    if(sql.includes('UPDATE delivery_entries'))return reply([]);
    if(sql.startsWith('UPDATE image_edit_results SET adopted')) {result={...result,adopted:true,image_run_id:values[1]};return reply([]);}
    if(sql.startsWith('UPDATE tasks SET')) {task.current_image_run_id=values[1];return reply([]);}
    if(sql.startsWith('INSERT INTO image_edit_events')) {
      events.push({task_id:values[0],edit_id:values[1],action:values[2],actor:values[3],reason:values[4],request_id:values[5],detail:values[6]});return reply([]);
    }
    throw new Error(`Unexpected fake repository query: ${sql}`);
  };
  const pool={query,connect:async()=>({query,release(){}})};
  const service=createImageEditingService({pool,storageRoot});
  const worker=structuredClone(edit);
  const failedBytes=await sharp(sourceBytes).composite([{input:await png(12,18,'black'),left:130,top:120}]).png().toBuffer();
  const failure=Object.assign(new Error('错字结果未通过自动验收'),{validation:{passed:false,stage:'TEXT_REPAIR',billedImageGeneration:false,
    requiredText:['海滩'],textRepair:{locations:[{id:'first',status:'FAILED'}]}}});
  const actor={role:'USER',username:'operator',userId:1,credentialVersion:1};
  const accept=extra=>service.action(edit.id,'accept',{version:edit.version,requestId:randomUUID(),reason:'人工查看后确认采用',...extra},actor);
  return {service,worker,failure,failedBytes,storageRoot,assets,runs,events,task,accept,get edit(){return edit;},get result(){return result;},
    close:()=>rm(storageRoot,{recursive:true,force:true})};
}

test('a failed text repair preview is adopted only by explicit human choice without changing automatic validation',async()=>{
  const fixture=await failedTextRepairFixture();
  try {
    await fixture.service.fail(fixture.worker,fixture.failure,{bytes:fixture.failedBytes});
    assert.equal(fixture.edit.status,'FAILED');
    assert.equal(fixture.result.validation.passed,false);
    assert.equal(fixture.result.validation.billedImageGeneration,false);
    await assert.rejects(fixture.accept(),/明确确认/u);
    await assert.rejects(fixture.accept({acceptRejectedResult:true,reason:''}),/文字/u);
    const adopted=await fixture.accept({acceptRejectedResult:true});
    assert.equal(adopted.status,'ACCEPTED');assert.equal(fixture.result.adopted,true);
    assert.equal(fixture.result.validation.passed,false);assert.equal(adopted.validation.passed,false);
    assert.equal(fixture.assets[1].asset_role,'DELIVERY');
    assert.equal(fixture.runs[1].status,'COMPLETED');assert.equal(fixture.task.current_image_run_id,fixture.runs[1].id);
    const event=fixture.events.find(event=>event.action==='accept');
    assert.deepEqual(event.detail,{acceptedRejectedPreview:true,manualOverride:true,validationPassed:false});
    assert.equal(event.reason,'人工查看后确认采用');
  } finally {await fixture.close();}
});

test('failed text repair preview records retain whether this execution generated a new image',async()=>{
  for(const generated of [false,true]) {
    const fixture=await failedTextRepairFixture();
    try {
      fixture.failure.validation.billedImageGeneration=generated;
      await fixture.service.fail(fixture.worker,fixture.failure,{bytes:fixture.failedBytes});
      assert.equal(fixture.result.validation.billedImageGeneration,generated);
    } finally {await fixture.close();}
  }
});

test('manual acceptance cannot promote missing, tampered, foreign, malformed or stale text repair previews',async t=>{
  const cases=[
    {name:'no generated preview',pattern:/没有可采用/u,prepare:fixture=>fixture.service.fail(fixture.worker,fixture.failure)},
    {name:'stored preview bytes changed',pattern:/完整性/u,mutate:async fixture=>writeFile(fixture.assets[1].storage_path,await png(1086,1448,'red'))},
    {name:'another request preview',pattern:/不属于/u,mutate:fixture=>{fixture.assets[1].edit_metadata.editId=randomUUID();}},
    {name:'wrong asset role',pattern:/不属于/u,mutate:fixture=>{fixture.assets[1].asset_role='TEXT_REFERENCE';}},
    {name:'malformed preview dimensions',pattern:/1086×1448/u,mutate:async fixture=>{
      const bytes=await png(100,100,'white');await writeFile(fixture.assets[1].storage_path,bytes);
      fixture.assets[1].sha256=imageHash(bytes);fixture.result.validation.integrity.sha256=imageHash(bytes);
    }},
    {name:'approved copy changed',pattern:/图片或文案已更新/u,mutate:fixture=>{fixture.task.current_copy_revision_id=2;}},
    {name:'source asset hash changed',pattern:/源图片校验值/u,mutate:fixture=>{fixture.assets[0].sha256='f'.repeat(64);}},
    {name:'stale edit version',pattern:/编辑状态已更新/u,extra:{version:1}},
  ];
  for(const entry of cases)await t.test(entry.name,async()=>{
    const fixture=await failedTextRepairFixture();
    try {
      if(entry.prepare)await entry.prepare(fixture);
      else await fixture.service.fail(fixture.worker,fixture.failure,{bytes:fixture.failedBytes});
      await entry.mutate?.(fixture);
      await assert.rejects(fixture.accept({acceptRejectedResult:true,...entry.extra}),entry.pattern);
      assert.equal(fixture.edit.status,'FAILED');assert.notEqual(fixture.result?.adopted,true);
      assert.equal(fixture.events.some(event=>event.action==='accept'),false);
    } finally {await fixture.close();}
  });
});
