import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import pg from 'pg';
import sharp from 'sharp';

import { batchReturnCopyQa, getCopyQaBatchReturnPreview, passCopyQaItem, routeManualCopyApproval } from '../src/copy-quality-control.mjs';
import { migrateDatabase } from '../src/database-migrations.mjs';
import { loadDefaultPrompts } from '../src/defaults.mjs';
import { processImageEdit } from '../src/image-edit-renderer.mjs';
import { createImageEditingService } from '../src/image-editing.mjs';
import { startImageEditProcessing } from '../src/image-edit-runner.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { createAgentClient } from '../../src/agent-client.mjs';
import { imageHash } from '../../src/image-edit-pixels.mjs';

const enabled=process.env.RUN_LIVE_WORKFLOW_PAID_E2E==='1';
const configuredMaintenanceUrl=process.env.LIVE_E2E_DATABASE_URL?.trim();

async function startDisposablePostgres() {
  const root=await mkdtemp(join(tmpdir(),'xhs-live-paid-pg-'));
  const data=join(root,'data');
  const bin=process.env.POSTGRES_E2E_BIN??(process.platform==='win32'?'C:/Program Files/PostgreSQL/18/bin':'/usr/lib/postgresql/18/bin');
  const executable=name=>join(bin,name+(process.platform==='win32'?'.exe':''));
  const control=args=>new Promise((accept,reject)=>{
    const child=spawn(executable('pg_ctl'),args,{shell:false,windowsHide:true,stdio:'ignore'});
    child.on('error',reject);
    child.on('exit',code=>code===0?accept():reject(new Error(`pg_ctl ${code}`)));
  });
  const probe=createServer();
  await new Promise(accept=>probe.listen(0,'127.0.0.1',accept));
  const port=probe.address().port;
  await new Promise((accept,reject)=>probe.close(error=>error?reject(error):accept()));
  let started=false;
  try {
    await promisify(execFile)(executable('initdb'),['-D',data,'-A','trust','-U','postgres','--encoding=UTF8','--locale=C','--no-sync'],{windowsHide:true,timeout:60_000});
    await control(['-D',data,'-l',join(root,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port}`,'-w','start']);
    started=true;
    return {url:`postgresql://postgres@127.0.0.1:${port}/postgres`,async stop(){
      if(started){started=false;await control(['-D',data,'-m','fast','-w','stop']);}
      assert.ok(resolve(root).startsWith(resolve(tmpdir())));
      await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
    }};
  } catch(error) {
    if(started)await control(['-D',data,'-m','fast','-w','stop']).catch(()=>{});
    assert.ok(resolve(root).startsWith(resolve(tmpdir())));
    await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
    throw error;
  }
}

test('paid live workflow: priority, whole-person QA return/recheck, and all current-image AI edit modes', {
  skip:!enabled,
  timeout:20*60_000,
}, async t=>{
  const isolatedPostgres=configuredMaintenanceUrl?null:await startDisposablePostgres();
  const maintenanceUrl=configuredMaintenanceUrl??isolatedPostgres.url;
  const adminUrl=new URL(maintenanceUrl);
  assert.ok(['127.0.0.1','localhost'].includes(adminUrl.hostname),'live E2E database must be local');
  const database=`live_e2e_${randomUUID().replaceAll('-','')}`;
  const administrator=new pg.Pool({connectionString:adminUrl.href});
  let repository,storageRoot,databaseCreated=false;
  try {
    await administrator.query(`CREATE DATABASE ${database}`);
    databaseCreated=true;
    adminUrl.pathname=`/${database}`;
    storageRoot=await mkdtemp(resolve(tmpdir(),'xhs-live-paid-e2e-'));
    repository=new PostgresControlPlaneRepository({connectionString:adminUrl.href});
    await repository.initialize();
    await migrateDatabase(repository.pool);
    for (const prompt of await loadDefaultPrompts()) {
      const version=await repository.createPromptVersion(prompt);
      await repository.publishPromptVersion(version.id);
    }
    const pool=repository.pool;
    const adminRow=await repository.getUserByUsername('admin');
    const admin={userId:Number(adminRow.id),username:adminRow.username,role:'ADMIN',credentialVersion:adminRow.credentialVersion};
    await repository.registerNode({nodeId:'live-paid',name:'Live paid E2E',imageWorkerEnabled:true,
      copyConcurrency:1,imageConcurrency:1});
    const accounts=(await pool.query(`INSERT INTO app_users(
        username,display_name,role,password_hash,status,must_change_password,
        credential_version,copy_review_enabled,copy_qc_enabled
      ) VALUES
        ('live-producer','Live producer','USER','unused','ACTIVE',false,1,true,false),
        ('live-inspector','Live inspector','USER','unused','ACTIVE',false,1,true,true)
      RETURNING id,username,role,credential_version`)).rows;
    const actor=username=>{const row=accounts.find(entry=>entry.username===username);return{userId:Number(row.id),username:row.username,role:row.role,credentialVersion:row.credential_version};};
    const producer=actor('live-producer'),inspector=actor('live-inspector');
    await pool.query(`UPDATE workflow_quality_settings SET copy_sampling_enabled=true,
      copy_sampling_rate_bps=10000,blind_review_enabled=true,reviewer_batch_return_enabled=true`);
    const clientBatchCode=randomUUID().replaceAll('-','');
    const batch=(await pool.query(`INSERT INTO production_batches(
        public_id,client_batch_code,query_package_name,created_by_username,request_id,request_fingerprint
      ) VALUES($1,$2,'live paid e2e','admin',$3,$4) RETURNING *`,
    [randomUUID(),clientBatchCode,randomUUID(),'e'.repeat(64)])).rows[0];
    const taskId=Date.now();
    assert.ok(Number.isSafeInteger(taskId));
    await pool.query(`INSERT INTO tasks(
        id,query,input,state,created_by_node_id,copy_executor_node_id,production_batch_id,
        assigned_to_user_id,assignment_source,assigned_at,source_client_batch_code
      ) VALUES($1,'真实付费端到端测试','{}','COPY_RUNNING','live-paid','live-paid',$2,
        'live-producer','MANUAL',now(),$3)`,[taskId,batch.id,clientBatchCode]);
    const content={copy:{title:'低成本也能保持',body:'低成本也能保持',tags:[]},imagePlan:[{kind:'hero',headline:'低成本也能保持',subtitle:'',bullets:[],labels:[]}]};
    const firstRevision=(await pool.query(`INSERT INTO copy_revisions(task_id,revision,content,approved_at)
      VALUES($1,1,$2,now()) RETURNING *`,[taskId,content])).rows[0];
    await pool.query(`UPDATE tasks SET state='COPY_REVIEW_PENDING',current_stage='COPY_REVIEW_PENDING',
      current_copy_revision_id=$2 WHERE id=$1`,[taskId,firstRevision.id]);
    await pool.query(`INSERT INTO production_batch_items(production_batch_id,task_id,query_snapshot)
      VALUES($1,$2,'真实付费端到端测试')`,[batch.id,taskId]);

    const priorityScope=await repository.getPriorityScope({taskIds:[taskId]},{actor:admin});
    await repository.setTaskPriority({taskIds:[taskId],mode:'HIGHEST',reason:'真实端到端新增功能验证',
      expectedVersions:{[taskId]:priorityScope.items[0].priorityVersion}},{actor:admin});
    const transaction=async action=>{const client=await pool.connect();try{await client.query('BEGIN');const value=await action(client);await client.query('COMMIT');return value;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
    let task=(await pool.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];
    await transaction(client=>routeManualCopyApproval(client,{task,revision:firstRevision,actor:producer,
      assessment:null,reviewSessionId:randomUUID(),aiDisclosureEnabled:true}));
    task=(await pool.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];
    assert.equal(task.state,'COPY_QC_PENDING');
    assert.equal(task.priority_mode,'HIGHEST');
    assert.equal(await repository.claimImage('live-paid'),null,'priority must not bypass pending copy QA');

    const freeze=(await pool.query('SELECT * FROM copy_sampling_freezes WHERE production_batch_id=$1',[batch.id])).rows[0];
    assert.equal(freeze.population_count,1);
    assert.equal(freeze.sample_count,1);
    const preview=await getCopyQaBatchReturnPreview(pool,freeze.public_id,inspector);
    await batchReturnCopyQa(pool,{requestId:randomUUID(),freezePublicId:freeze.public_id,
      triggerSamplingItemId:preview.triggerCandidates[0],itemIds:preview.items.map(item=>item.id),
      confirmedCount:preview.items.length,note:'真实端到端整批打回验证'},inspector);
    task=(await pool.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];
    assert.equal(task.state,'COPY_REVIEW_PENDING');
    assert.equal(task.mandatory_copy_qc,true);
    assert.equal(task.rework_count,1);

    const editedRevision=(await pool.query(`INSERT INTO copy_revisions(
        task_id,revision,parent_revision_id,content,approved_at,revision_origin
      ) VALUES($1,3,$2,$3,now(),'COPY_EDIT') RETURNING *`,[taskId,task.current_copy_revision_id,content])).rows[0];
    await transaction(client=>routeManualCopyApproval(client,{task,revision:editedRevision,actor:producer,
      assessment:null,reviewSessionId:randomUUID(),aiDisclosureEnabled:true}));
    const recheck=(await pool.query(`SELECT * FROM copy_sampling_items
      WHERE task_id=$1 AND sample_kind='MANDATORY_RECHECK' AND status='PENDING'`,[taskId])).rows[0];
    assert.equal(recheck.assigned_review_account_id,null);
    await passCopyQaItem(pool,recheck.public_id,{requestId:randomUUID(),
      expectedCopyRevisionId:Number(recheck.copy_revision_id)},inspector);
    task=(await pool.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];
    assert.equal(task.state,'IMAGE_QUEUED');
    assert.equal(Number(task.copy_qc_released_revision_id),Number(editedRevision.id));

    const sourceSvg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1086" height="1448">
      <rect width="1086" height="1448" fill="#f7f3ea"/>
      <text x="543" y="330" text-anchor="middle" font-family="Microsoft YaHei,sans-serif"
        font-size="96" font-weight="700" fill="#111827">低成本也能保持</text>
      <ellipse cx="260" cy="1210" rx="150" ry="34" fill="#d7d0c4"/>
      <rect x="135" y="850" width="250" height="335" rx="55" fill="#7b9db5"/>
      <ellipse cx="260" cy="850" rx="125" ry="36" fill="#9ab7ca"/>
      <ellipse cx="260" cy="850" rx="94" ry="22" fill="#342b27"/>
      <path d="M385 925 C510 895 525 1110 387 1090" fill="none" stroke="#7b9db5" stroke-width="52"/>
    </svg>`);
    const sourceBytes=await sharp(sourceSvg).png().toBuffer();
    const sourcePath=resolve(storageRoot,'source.png');
    await writeFile(sourcePath,sourceBytes);
    const sourceRunId=randomUUID();
    await pool.query(`INSERT INTO image_runs(id,task_id,copy_revision_id,status,image_production_chain_id,finished_at)
      VALUES($1,$2,$3,'COMPLETED',$1,now())`,[sourceRunId,taskId,editedRevision.id]);
    const sourceAsset=(await pool.query(`INSERT INTO assets(
        task_id,image_run_id,media_type,byte_size,sha256,storage_path,image_production_chain_id,
        artifact_key,origin_image_run_id,asset_role,active
      ) VALUES($1,$2,'image/png',$3,$4,$5,$2,$6,$2,'DELIVERY',true) RETURNING *`,
    [taskId,sourceRunId,sourceBytes.length,imageHash(sourceBytes),sourcePath,randomUUID()])).rows[0];
    await pool.query('UPDATE image_runs SET result=$2 WHERE id=$1',[sourceRunId,{images:[{assetId:Number(sourceAsset.id),deliveryAssetId:Number(sourceAsset.id),pageIndex:1}]}]);
    await pool.query(`UPDATE tasks SET state='MANUAL_ARCHIVE',current_stage='MANUAL_ARCHIVE',
      current_image_run_id=$2,current_execution_id=NULL WHERE id=$1`,[taskId,sourceRunId]);
    await pool.query(`UPDATE global_settings SET value=value || $1::jsonb WHERE key='production'`,
      [{aiDisclosureEnabled:true,aiDisclosureText:'AI生成',imageEditRepairMaxAttempts:1}]);

    const service=createImageEditingService({pool,storageRoot});
    const settings=(await pool.query("SELECT value FROM global_settings WHERE key='production'")).rows[0].value;
    const liveClient=createAgentClient({modelApi:settings.modelApi});
    let imageGenerationCalls=0,visionValidationCalls=0;
    const measuredClient={provider:liveClient.provider,
      runImageEdit:async input=>{imageGenerationCalls++;return liveClient.runImageEdit(input);},
      runVision:async input=>{visionValidationCalls++;return liveClient.runVision(input);}};
    const skipText=process.env.LIVE_E2E_SKIP_TEXT==='1';
    let edit=null,completed=null,resultAsset=sourceAsset,resultBytes=sourceBytes;
    let textCalls={imageGenerationCalls:0,visionValidationCalls:0};
    if(!skipText) {
    edit=await service.create(taskId,{requestId:randomUUID(),sourceImageRunId:sourceRunId,
      sourceAssetId:Number(sourceAsset.id),copyRevisionId:Number(editedRevision.id),sha256:sourceAsset.sha256,
      targetPage:1,operation:'TEXT',instruction:'使用清晰的现代无衬线字体，作为合规标识自然融入画面',
      preserve:'保留标题“低成本也能保持”和全部构图元素',negative:'不要增加任何其他文字',
      confirmation:'LIVE_IMAGE_COST_ACCEPTED',overlay:{text:'AI生成',textType:'AI_DISCLOSURE',
        disclosureType:'AI_GENERATED',position:'bottom-right',size:52,margin:64,
        color:'#ffffff',background:'#111827',opacity:1}},admin);
    const rendered=await processImageEdit({service,storageRoot,workerId:'live-paid-worker',
      agentClient:measuredClient,maxGenerationAttempts:1});
    if(rendered.status!=='PREVIEW_READY') {
      const failedEdit=await service.get(edit.id);
      t.diagnostic(JSON.stringify({rendered,validation:failedEdit.validation,imageGenerationCalls,visionValidationCalls}));
    }
    assert.equal(rendered.status,'PREVIEW_READY',rendered.error);
    completed=await service.get(edit.id);
    assert.equal(completed.result.validation.passed,true);
    assert.equal(completed.result.validation.text.targetOccurrences,1);
    assert.equal(completed.result.validation.text.placement.passed,true);
    assert.equal(completed.result.validation.text.placement.style.textColor,'#ffffff');
    assert.equal(completed.result.validation.text.placement.style.backgroundColor,'#111827');
    assert.equal(completed.result.validation.outsideMask.changedPixels,0);
    assert.equal(completed.result.validation.generationAttempts,1);
    assert.ok(completed.result.validation.model);
    assert.equal(imageGenerationCalls,1);
    resultAsset=await service.asset(Number(completed.result.asset_id),taskId);
    resultBytes=await service.readAsset(resultAsset);
    assert.notEqual(resultAsset.sha256,sourceAsset.sha256);
    await service.action(edit.id,'accept',{version:completed.version,requestId:randomUUID(),reason:'真实测试校验通过并采用'},admin);
    task=(await pool.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];
    assert.equal(task.state,'MANUAL_ARCHIVE');
    assert.equal(task.current_image_run_id,completed.result.image_run_id);
    textCalls={imageGenerationCalls,visionValidationCalls};
    }
    task=(await pool.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];
    const testedPriorityMode=task.priority_mode;

    const realSourcePath=process.env.LIVE_E2E_MULTI_OBJECT_SOURCE?.trim();
    const realReferencePath=process.env.LIVE_E2E_PRODUCT_REFERENCE?.trim();
    if(Boolean(realSourcePath)!==Boolean(realReferencePath))throw new Error('真实多物品测试必须同时设置 LIVE_E2E_MULTI_OBJECT_SOURCE 和 LIVE_E2E_PRODUCT_REFERENCE');
    let syntheticModes=null;
    if(!realSourcePath) {
    const referenceSvg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
      <rect width="512" height="512" fill="#f7f3ea"/>
      <ellipse cx="250" cy="421" rx="145" ry="30" fill="#d7d0c4"/>
      <rect x="126" y="126" width="220" height="275" rx="46" fill="#e65f4f"/>
      <ellipse cx="236" cy="126" rx="110" ry="31" fill="#f47a68"/>
      <ellipse cx="236" cy="126" rx="83" ry="20" fill="#45231f"/>
      <path d="M346 188 C455 171 464 344 348 334" fill="none" stroke="#e65f4f" stroke-width="44"/>
      <path d="M167 166 C151 236 155 313 177 353" fill="none" stroke="#ffaaa0" stroke-width="18" stroke-linecap="round" opacity="0.8"/>
    </svg>`);
    const referenceBytes=await sharp(referenceSvg).png().toBuffer();
    const reference=await service.upload(taskId,{base64:referenceBytes.toString('base64'),mediaType:'image/png',
      purpose:'珊瑚红陶瓷马克杯实体参考',source:'端到端测试自有矢量夹具'},admin);
    const entityEdit=await service.create(taskId,{requestId:randomUUID(),sourceImageRunId:task.current_image_run_id,
      sourceAssetId:Number(resultAsset.id),copyRevisionId:Number(editedRevision.id),sha256:resultAsset.sha256,
      targetPage:1,operation:'AI_FUSION',instruction:'用参考附件中的珊瑚红陶瓷马克杯替换画面左下方唯一的蓝色陶瓷马克杯，保留圆柱杯身、C 形杯把、珊瑚红颜色和浅色高光',
      preserve:'逐字保留标题“低成本也能保持”和右下角“AI生成”标识，保持原有简洁留白构图',
      negative:'不要增加文字、商标、第二个杯子或其他物体，不要改变原标题和AI标识',
      target:{description:'画面左下方唯一的蓝色陶瓷马克杯',region:{x:85,y:790,width:500,height:470}},
      confirmation:'LIVE_IMAGE_COST_ACCEPTED',references:[{assetId:reference.id,purpose:'必须保持形状和颜色的实体参考'}]},admin);
    const entityStart={imageGenerationCalls,visionValidationCalls};
    const entityRendered=await processImageEdit({service,storageRoot,workerId:'live-entity-worker',agentClient:measuredClient,maxGenerationAttempts:1});
    if(entityRendered.status!=='PREVIEW_READY') {
      const failedEdit=await service.get(entityEdit.id);
      t.diagnostic(JSON.stringify({stage:'entityFusion',entityRendered,validation:failedEdit.validation,imageGenerationCalls,visionValidationCalls}));
    }
    assert.equal(entityRendered.status,'PREVIEW_READY',entityRendered.error);
    const entityCompleted=await service.get(entityEdit.id);
    assert.equal(entityCompleted.result.validation.passed,true);
    assert.equal(entityCompleted.result.validation.entityConsistency.mode,'AI_REFERENCE_CHECK');
    assert.equal(entityCompleted.result.validation.entityConsistency.passed,true);
    assert.equal(entityCompleted.result.validation.localization.mode,'VISION_TARGET_REGION_CHECK');
    assert.equal(entityCompleted.result.validation.localization.candidateCount,1);
    assert.equal(entityCompleted.result.validation.outsideMask.changedPixels,0);
    const entityAsset=await service.asset(Number(entityCompleted.result.asset_id),taskId);
    const entityBytes=await service.readAsset(entityAsset);
    assert.notEqual(entityAsset.sha256,resultAsset.sha256);
    await service.action(entityEdit.id,'accept',{version:entityCompleted.version,requestId:randomUUID(),reason:'真实实体融合测试校验通过并采用'},admin);
    task=(await pool.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];
    assert.equal(task.current_image_run_id,entityCompleted.result.image_run_id);
    const entityCalls={imageGenerationCalls:imageGenerationCalls-entityStart.imageGenerationCalls,
      visionValidationCalls:visionValidationCalls-entityStart.visionValidationCalls};

    const promptEdit=await service.create(taskId,{requestId:randomUUID(),sourceImageRunId:task.current_image_run_id,
      sourceAssetId:Number(entityAsset.id),copyRevisionId:Number(editedRevision.id),sha256:entityAsset.sha256,
      targetPage:1,operation:'AI_LOCAL',instruction:'只把画面中央、标题下方且左下角马克杯上方的米白色空白背景调整为非常浅的鼠尾草绿色柔和渐变，不添加或删除任何物体与文字',
      preserve:'逐字保留标题“低成本也能保持”、右下角“AI生成”标识和左下角珊瑚红马克杯',
      negative:'不要增加文字、图标、边框、人物或新的物体，不要修改说明之外的区域',
      confirmation:'LIVE_IMAGE_COST_ACCEPTED'},admin);
    const promptStart={imageGenerationCalls,visionValidationCalls};
    const completedByRunner=Promise.withResolvers();
    const stopImageEdits=startImageEditProcessing({service,storageRoot},{intervalMs:100,workerId:'live-prompt-worker',
      processEdit:async input=>{const result=await processImageEdit({...input,agentClient:measuredClient,maxGenerationAttempts:1});if(result.status!=='idle')completedByRunner.resolve(result);return result;},log:{log(){},error(){}}});
    const promptRendered=await completedByRunner.promise;
    await stopImageEdits();
    if(promptRendered.status!=='PREVIEW_READY') {
      const failedEdit=await service.get(promptEdit.id);
      t.diagnostic(JSON.stringify({stage:'promptLocal',promptRendered,validation:failedEdit.validation,imageGenerationCalls,visionValidationCalls}));
    }
    assert.equal(promptRendered.status,'PREVIEW_READY',promptRendered.error);
    const promptCompleted=await service.get(promptEdit.id);
    assert.equal(promptCompleted.result.validation.passed,true);
    assert.equal(promptCompleted.result.validation.outsideMask.changedPixels,0);
    assert.equal(promptCompleted.result.validation.localization.mode,'VISION_PROMPT_REGION_CHECK');
    const promptAsset=await service.asset(Number(promptCompleted.result.asset_id),taskId);
    const promptBytes=await service.readAsset(promptAsset);
    assert.notEqual(promptAsset.sha256,entityAsset.sha256);
    await service.action(promptEdit.id,'accept',{version:promptCompleted.version,requestId:randomUUID(),reason:'真实提示词局部修改测试校验通过并采用'},admin);
    task=(await pool.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];
    assert.equal(task.current_image_run_id,promptCompleted.result.image_run_id);
    const promptCalls={imageGenerationCalls:imageGenerationCalls-promptStart.imageGenerationCalls,
      visionValidationCalls:visionValidationCalls-promptStart.visionValidationCalls};
    syntheticModes={referenceBytes,entityBytes,promptBytes,
      entity:{editId:entityEdit.id,model:entityCompleted.result.validation.model,calls:entityCalls,
        entityConsistency:entityCompleted.result.validation.entityConsistency,accepted:true},
      prompt:{editId:promptEdit.id,model:promptCompleted.result.validation.model,calls:promptCalls,
        localization:promptCompleted.result.validation.localization,outsideMask:promptCompleted.result.validation.outsideMask,accepted:true}};
    }

    let realMultiObject=null;
    if(realSourcePath&&realReferencePath) {
      const realSourceBytes=await sharp(await readFile(realSourcePath),{limitInputPixels:16_000_000})
        .resize(1086,1448,{fit:'fill'}).png().toBuffer();
      const realReferenceOriginal=await readFile(realReferencePath);
      const realContent={copy:{title:'三档预算怎么选',body:'真实多物品图片编辑测试',tags:[]},imagePlan:[{
        kind:'comparison',headline:'三档预算怎么选',subtitle:'先解决台面动线，再升级收纳家具',
        bullets:['500元内：免打孔推车或置物架','500~1500元：货架柜或组合台面','1500~6000元：成品餐边柜'],labels:[],
      }]};
      const realTaskId=taskId+1;
      await pool.query(`INSERT INTO tasks(
          id,query,input,state,current_stage,created_by_node_id,copy_executor_node_id,production_batch_id,
          assigned_to_user_id,assignment_source,assigned_at,source_client_batch_code
        ) VALUES($1,'真实多物品图片编辑测试','{}','COPY_RUNNING','COPY_RUNNING','live-paid','live-paid',$2,
          'live-producer','MANUAL',now(),$3)`,[realTaskId,batch.id,clientBatchCode]);
      const realRevision=(await pool.query(`INSERT INTO copy_revisions(
          task_id,revision,parent_revision_id,content,approved_at,revision_origin
        ) VALUES($1,1,NULL,$2,now(),'COPY_EDIT') RETURNING *`,[realTaskId,realContent])).rows[0];
      const realRunId=randomUUID(),realSourceFile=resolve(storageRoot,'real-multi-object-source.png');
      await writeFile(realSourceFile,realSourceBytes);
      await pool.query(`INSERT INTO image_runs(id,task_id,copy_revision_id,status,image_production_chain_id,finished_at)
        VALUES($1,$2,$3,'COMPLETED',$1,now())`,[realRunId,realTaskId,realRevision.id]);
      const realSourceAsset=(await pool.query(`INSERT INTO assets(
          task_id,image_run_id,media_type,byte_size,sha256,storage_path,image_production_chain_id,
          artifact_key,origin_image_run_id,asset_role,active
        ) VALUES($1,$2,'image/png',$3,$4,$5,$2,$6,$2,'DELIVERY',true) RETURNING *`,
      [realTaskId,realRunId,realSourceBytes.length,imageHash(realSourceBytes),realSourceFile,randomUUID()])).rows[0];
      await pool.query('UPDATE image_runs SET result=$2 WHERE id=$1',[realRunId,{images:[{assetId:Number(realSourceAsset.id),deliveryAssetId:Number(realSourceAsset.id),pageIndex:1}]}]);
      const switched=(await pool.query(`UPDATE tasks SET state='MANUAL_ARCHIVE',current_stage='MANUAL_ARCHIVE',
        current_copy_revision_id=$2,current_image_run_id=$3,current_execution_id=NULL,
        mandatory_copy_qc=false,mandatory_copy_qc_origin=NULL,copy_qc_released_revision_id=$2,
        image_qc_legacy_accepted=true,image_reviewed_at=NULL,image_reviewed_by_user_id=NULL
        WHERE id=$1 RETURNING state,current_stage,current_copy_revision_id,current_image_run_id,mandatory_copy_qc`,
      [realTaskId,realRevision.id,realRunId])).rows[0];
      assert.equal(switched.state,'MANUAL_ARCHIVE');
      assert.equal(switched.current_stage,'MANUAL_ARCHIVE');
      assert.equal(Number(switched.current_copy_revision_id),Number(realRevision.id));
      assert.equal(switched.current_image_run_id,realRunId);
      assert.equal(switched.mandatory_copy_qc,false);
      const realReference=await service.upload(realTaskId,{base64:realReferenceOriginal.toString('base64'),mediaType:'image/jpeg',
        purpose:'真实红色陶瓷马克杯实体参考',source:'真实多物品付费端到端测试参考图'},admin);
      const realEntity=await service.create(realTaskId,{requestId:randomUUID(),sourceImageRunId:realRunId,
        sourceAssetId:Number(realSourceAsset.id),copyRevisionId:Number(realRevision.id),sha256:realSourceAsset.sha256,
        targetPage:1,operation:'AI_FUSION',
        instruction:'只把画面最下方前景木桌上、靠近中央且带右侧杯把的唯一大号米白色马克杯替换成参考图中的红色陶瓷马克杯；严格按参考图真实可见的杯身比例、圆柱轮廓、红色亮面釉质、白色内壁与单个 C 形杯把生成；不要修改上方三个预算栏中的任何杯子',
        preserve:'逐字保留全部标题、预算说明文字和三栏构图，保持所有上方杯子、咖啡设备、柜体、推车、植物、木桌和光影不变',
        negative:'不得修改框选外任何像素；不得替换上方其他杯子或物品；不得新增文字、额外杯子、额外把手或其他物体',
        target:{description:'画面最下方前景木桌上、靠近中央、位于木杯垫上且带右侧杯把的唯一大号米白色马克杯',
          region:{x:420,y:1280,width:235,height:168}},
        confirmation:'LIVE_IMAGE_COST_ACCEPTED',references:[{assetId:realReference.id,purpose:'最高优先级按参考照片保持真实红杯可见的杯身比例、红色亮面釉质、圆柱轮廓、白色内壁和单个 C 形杯把'}]},admin);
      const realEntityStart={imageGenerationCalls,visionValidationCalls};
      const realEntityRendered=await processImageEdit({service,storageRoot,workerId:'live-real-multi-object-worker',agentClient:measuredClient,maxGenerationAttempts:1});
      if(realEntityRendered.status!=='PREVIEW_READY') {
        const failedEdit=await service.get(realEntity.id);
        t.diagnostic(JSON.stringify({stage:'realMultiObjectFusion',realEntityRendered,validation:failedEdit.validation,imageGenerationCalls,visionValidationCalls}));
      }
      assert.equal(realEntityRendered.status,'PREVIEW_READY',realEntityRendered.error);
      const realEntityCompleted=await service.get(realEntity.id);
      assert.equal(realEntityCompleted.result.validation.localization.passed,true);
      assert.equal(realEntityCompleted.result.validation.localization.candidateCount,1);
      assert.equal(realEntityCompleted.result.validation.entityConsistency.passed,true);
      assert.equal(realEntityCompleted.result.validation.outsideMask.changedPixels,0);
      const realEntityAsset=await service.asset(Number(realEntityCompleted.result.asset_id),realTaskId);
      const realEntityBytes=await service.readAsset(realEntityAsset);
      await service.action(realEntity.id,'accept',{version:realEntityCompleted.version,requestId:randomUUID(),reason:'真实多物品目标框选替换校验通过并采用'},admin);
      const realEntityCalls={imageGenerationCalls:imageGenerationCalls-realEntityStart.imageGenerationCalls,
        visionValidationCalls:visionValidationCalls-realEntityStart.visionValidationCalls};

      task=(await pool.query('SELECT * FROM tasks WHERE id=$1',[realTaskId])).rows[0];
      const realPromptEdit=await service.create(realTaskId,{requestId:randomUUID(),sourceImageRunId:task.current_image_run_id,
        sourceAssetId:Number(realEntityAsset.id),copyRevisionId:Number(realRevision.id),sha256:realEntityAsset.sha256,
        targetPage:1,operation:'AI_LOCAL',instruction:'只把画面中间预算栏上层台面右侧、带木色手柄和细长壶嘴的黑色手冲壶改为非常浅的鼠尾草绿色，保持壶盖、壶嘴、手柄、周围器具和所有文字不变',
        preserve:'逐字保留全部标题和三栏预算说明文字，保持前景红杯、上方全部杯子、咖啡机、磨豆机、玻璃壶、柜体、推车、植物和光影不变',
        negative:'不得新增、删除或移动任何物品，不得修改文字、其他杯子、其他容器或背景',
        confirmation:'LIVE_IMAGE_COST_ACCEPTED'},admin);
      const realPromptStart={imageGenerationCalls,visionValidationCalls};
      const realPromptRendered=await processImageEdit({service,storageRoot,workerId:'live-real-prompt-worker',agentClient:measuredClient,maxGenerationAttempts:1});
      if(realPromptRendered.status!=='PREVIEW_READY') {
        const failedEdit=await service.get(realPromptEdit.id);
        t.diagnostic(JSON.stringify({stage:'realNaturalLanguageEdit',realPromptRendered,validation:failedEdit.validation,imageGenerationCalls,visionValidationCalls}));
      }
      assert.equal(realPromptRendered.status,'PREVIEW_READY',realPromptRendered.error);
      const realPromptCompleted=await service.get(realPromptEdit.id);
      assert.equal(realPromptCompleted.result.validation.localization.mode,'VISION_PROMPT_REGION_CHECK');
      assert.equal(realPromptCompleted.result.validation.localization.candidateCount,1);
      assert.equal(realPromptCompleted.result.validation.outsideMask.changedPixels,0);
      const realPromptAsset=await service.asset(Number(realPromptCompleted.result.asset_id),realTaskId);
      const realPromptBytes=await service.readAsset(realPromptAsset);
      await service.action(realPromptEdit.id,'accept',{version:realPromptCompleted.version,requestId:randomUUID(),reason:'真实多物品自然语言修改校验通过并采用'},admin);
      realMultiObject={taskId:realTaskId,sourceBytes:realSourceBytes,referenceBytes:realReferenceOriginal,entityBytes:realEntityBytes,promptBytes:realPromptBytes,
        entity:{editId:realEntity.id,model:realEntityCompleted.result.validation.model,localization:realEntityCompleted.result.validation.localization,
          entityConsistency:realEntityCompleted.result.validation.entityConsistency,outsideMask:realEntityCompleted.result.validation.outsideMask,
          calls:realEntityCalls},
        prompt:{editId:realPromptEdit.id,model:realPromptCompleted.result.validation.model,localization:realPromptCompleted.result.validation.localization,
          outsideMask:realPromptCompleted.result.validation.outsideMask,
          calls:{imageGenerationCalls:imageGenerationCalls-realPromptStart.imageGenerationCalls,
            visionValidationCalls:visionValidationCalls-realPromptStart.visionValidationCalls}}};
    }

    const outputDir=resolve(process.cwd(),'output','live-e2e',String(taskId),'attempt-1');
    await mkdir(outputDir,{recursive:true});
    await Promise.all([
      writeFile(resolve(outputDir,'source.png'),sourceBytes,{flag:'wx'}),
      writeFile(resolve(outputDir,'text-edited.png'),resultBytes,{flag:'wx'}),
      ...(syntheticModes?[
        writeFile(resolve(outputDir,'entity-reference.png'),syntheticModes.referenceBytes,{flag:'wx'}),
        writeFile(resolve(outputDir,'entity-edited.png'),syntheticModes.entityBytes,{flag:'wx'}),
        writeFile(resolve(outputDir,'prompt-local-edited.png'),syntheticModes.promptBytes,{flag:'wx'}),
      ]:[]),
      ...(realMultiObject?[
        writeFile(resolve(outputDir,'real-multi-object-source.png'),realMultiObject.sourceBytes,{flag:'wx'}),
        writeFile(resolve(outputDir,'real-product-reference.jpg'),realMultiObject.referenceBytes,{flag:'wx'}),
        writeFile(resolve(outputDir,'real-multi-object-entity-edited.png'),realMultiObject.entityBytes,{flag:'wx'}),
        writeFile(resolve(outputDir,'real-multi-object-prompt-edited.png'),realMultiObject.promptBytes,{flag:'wx'}),
      ]:[]),
      writeFile(resolve(outputDir,'report.json'),JSON.stringify({taskId,priorityMode:testedPriorityMode,
        sampling:{rateBps:freeze.rate_bps,population:freeze.population_count,sample:freeze.sample_count,
          batchReturned:true,batchReturnScope:'WHOLE_REVIEWER_FREEZE',mandatoryRecheckPassed:true,imageGateBlockedBeforeRecheck:true},
        imageEdits:{...(!skipText?{text:{editId:edit.id,model:completed.result.validation.model,calls:textCalls,
          recognizedText:completed.result.validation.text.recognizedText,targetOccurrences:completed.result.validation.text.targetOccurrences,
          placementPassed:completed.result.validation.text.placement.passed,accepted:true}}:{text:{skipped:true,calls:textCalls}}),
        ...(syntheticModes?{entityFusion:syntheticModes.entity,promptLocal:syntheticModes.prompt}:{}),
        ...(realMultiObject?{realMultiObject:{taskId:realMultiObject.taskId,entity:{...realMultiObject.entity,accepted:true},prompt:{...realMultiObject.prompt,accepted:true}}}:{})},
        totals:{imageGenerationCalls,visionValidationCalls},published:false},null,2),{flag:'wx'}),
    ]);
    t.diagnostic(JSON.stringify({outputDir,taskId,model:completed?.result.validation.model??realMultiObject?.entity.model??null,
      imageGenerationCalls,visionValidationCalls,stages:['wholeBatchReturn','mandatoryRecheck',...(!skipText?['text']:[]),
        ...(syntheticModes?['entityFusion','promptLocal']:[]),...(realMultiObject?['realMultiObjectFusion','realNaturalLanguageEdit']:[])],published:false}));
  } finally {
    await repository?.close();
    if(storageRoot)await rm(storageRoot,{recursive:true,force:true});
    if(databaseCreated)await administrator.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await administrator.end();
    await isolatedPostgres?.stop();
  }
});
