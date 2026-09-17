import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import pg from 'pg';
import { migrateDatabase } from '../src/database-migrations.mjs';
import { createImageEditingService } from '../src/image-editing.mjs';
import { processImageEdit } from '../src/image-edit-renderer.mjs';
import { imageHash } from '../../src/image-edit-pixels.mjs';
import { createReadyDeliveryEntry } from '../src/final-delivery.mjs';
import { createPostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { createControlPlaneClient } from '../../src/control-plane/client.mjs';

test('PostgreSQL manual edit lifecycle, concurrency, immutable membership, retry, restoration and delivery revocation', {skip:process.env.RUN_POSTGRES_E2E!=='1',timeout:120000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'xhs-image-edit-pg-')),data=join(root,'data');
  const bin=process.env.POSTGRES_E2E_BIN??(process.platform==='win32'?'C:/Program Files/PostgreSQL/18/bin':'/usr/lib/postgresql/18/bin');
  const exe=name=>join(bin,name+(process.platform==='win32'?'.exe':''));
  const ctl=args=>new Promise((res,rej)=>{const p=spawn(exe('pg_ctl'),args,{shell:false,windowsHide:true,stdio:'ignore'});p.on('error',rej);p.on('exit',code=>code===0?res():rej(new Error(`pg_ctl ${code}`)));});
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  let pool,started=false;
  try{
    await promisify(execFile)(exe('initdb'),['-D',data,'-A','trust','-U','postgres','--encoding=UTF8','--locale=C','--no-sync'],{windowsHide:true,timeout:60000});
    await ctl(['-D',data,'-l',join(root,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port}`,'-w','start']);started=true;
    pool=new pg.Pool({connectionString:`postgresql://postgres@127.0.0.1:${port}/postgres`});
    await migrateDatabase(pool);
    const imageEditPromptContent='管理员图片编辑规则：{{reviewInstruction}}；保留所有未要求修改的内容。';
    const promptTemplate=(await pool.query("INSERT INTO prompt_templates(kind,name) VALUES('IMAGE_EDIT_SYSTEM','图片编辑') RETURNING id")).rows[0];
    const promptVersion=(await pool.query("INSERT INTO prompt_versions(template_id,version,content,content_sha256,status,published_at) VALUES($1,1,$2,$3,'PUBLISHED',now()) RETURNING id",[promptTemplate.id,imageEditPromptContent,createHash('sha256').update(imageEditPromptContent).digest('hex')])).rows[0];
    const admin=(await pool.query("SELECT id,username,credential_version FROM app_users WHERE role='ADMIN' LIMIT 1")).rows[0];
    const adminActor={userId:Number(admin.id),username:admin.username,role:'ADMIN',credentialVersion:admin.credential_version};
    const worker=(await pool.query("INSERT INTO app_users(username,display_name,role,password_hash,must_change_password) VALUES('image-editor','图片作业员','USER','not-a-credential',false) RETURNING *")).rows[0];
    const outsider=(await pool.query("INSERT INTO app_users(username,display_name,role,password_hash,must_change_password) VALUES('other-editor','其他作业员','USER','not-a-credential',false) RETURNING *")).rows[0];
    const actor={userId:Number(worker.id),username:worker.username,role:'USER',credentialVersion:worker.credential_version};
    const outsiderActor={userId:Number(outsider.id),username:outsider.username,role:'USER',credentialVersion:outsider.credential_version};
    const repository=createPostgresControlPlaneRepository({pool});
    await repository.registerNode({nodeId:'edit-test',name:'edit-test',imageWorkerEnabled:true,
      copyConcurrency:1,imageConcurrency:1,codexPoolId:'edit-test',codexTotalConcurrency:1,codexImageConcurrency:1});
    const task=(await pool.query("INSERT INTO tasks(query,state,created_by_node_id,copy_executor_node_id,assigned_to_user_id,assignment_source,assigned_at,image_qc_legacy_accepted) VALUES('edit fixture','MANUAL_ARCHIVE','edit-test','edit-test',$1,'MANUAL',now(),true) RETURNING *",[actor.username])).rows[0];
    const taskId=Number(task.id),runId=randomUUID();
    const revision=(await pool.query("INSERT INTO copy_revisions(task_id,revision,content,approved_at) VALUES($1,1,$2,now()) RETURNING *",[taskId,{copy:{title:'标题',body:'正文',tags:[]},imagePlan:[1,2,3].map(()=>({kind:'detail',headline:'真实参考'}))}])).rows[0];
    const copyRevisionId=Number(revision.id);
    await pool.query("INSERT INTO image_runs(id,task_id,copy_revision_id,status,image_production_chain_id) VALUES($1,$2,$3,'COMPLETED',$1)",[runId,taskId,copyRevisionId]);
    const png=await sharp({create:{width:1086,height:1448,channels:4,background:'white'}}).png().toBuffer(),sha256=imageHash(png);
    const localPatch=await sharp({create:{width:300,height:300,channels:4,background:'#dce8d4'}}).png().toBuffer();
    const localPng=await sharp(png).composite([{input:localPatch,left:100,top:500}]).png().toBuffer();
    const disclosurePng=await sharp(png).composite([{input:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="280" height="140"><rect width="280" height="140" rx="16" fill="#111827"/></svg>'),left:774,top:1276}]).png().toBuffer();
    const images=[];
    for(let i=0;i<3;i++){
      const path=resolve(root,`source-${i}.png`);await writeFile(path,png);
      const a=(await pool.query("INSERT INTO assets(task_id,image_run_id,media_type,byte_size,sha256,storage_path,image_production_chain_id,artifact_key,origin_image_run_id) VALUES($1,$2,'image/png',$3,$4,$5,$2,$6,$2) RETURNING id",[taskId,runId,png.length,sha256,path,`source-${i}`])).rows[0];
      images.push({assetId:Number(a.id),deliveryAssetId:Number(a.id),pageIndex:i+1});
    }
    await pool.query('UPDATE image_runs SET result=$2 WHERE id=$1',[runId,{images}]);
    await pool.query('UPDATE tasks SET current_copy_revision_id=$2,current_image_run_id=$3,image_qc_legacy_accepted=true WHERE id=$1',[taskId,copyRevisionId,runId]);
    await pool.query("UPDATE global_settings SET value=$1 WHERE key='production'",[{aiDisclosureEnabled:false,imageEditRepairMaxAttempts:1}]);
    const service=createImageEditingService({pool,storageRoot:root});
    let currentRun=runId,currentAsset=images[1].assetId,currentHash=sha256;
    const request=(extra={})=>({requestId:randomUUID(),sourceImageRunId:currentRun,sourceAssetId:currentAsset,copyRevisionId,sha256:currentHash,targetPage:2,operation:'TEXT',confirmation:'LIVE_IMAGE_COST_ACCEPTED',overlay:{text:'AI生成',textType:'AI_DISCLOSURE',disclosureType:'AI_GENERATED',position:'bottom-right'},...extra});
    const validateImage=async({imagePath})=>({passed:true,model:'fake-vision',layoutMatched:true,ocrConfidence:1,
      ocrMismatches:[],unreadableText:[],recognizedText:{headline:'真实参考',subtitle:'',bullets:[],otherText:imagePath.endsWith('result.png')?['AI生成']:[]}});
    const agentClient={runImageEdit:async({outputPath})=>{await writeFile(outputPath,disclosurePng);return{model:'fake-text-edit'};}};
    const action=async(id,name,extra={})=>{const e=await service.get(id);return service.action(id,name,{version:e.version,requestId:randomUUID(),reason:'test',...extra},actor);};
    await t.test('permissions, copy gate and source conflicts fail before queue insertion',async()=>{
      await assert.rejects(()=>service.create(taskId,request(),outsiderActor),{code:'FORBIDDEN'});
      await assert.rejects(()=>service.create(taskId,request(),{...adminActor,role:'REVIEWER'}),{code:'FORBIDDEN'});
      await assert.rejects(()=>service.create(taskId,request(),{...actor,credentialVersion:actor.credentialVersion+1}),{code:'FORBIDDEN'});
      await assert.rejects(()=>service.create(taskId,request({sha256:'b'.repeat(64)}),actor),{code:'IMAGE_EDIT_CONFLICT'});
      await pool.query('UPDATE tasks SET mandatory_copy_qc=true WHERE id=$1',[taskId]);
      await assert.rejects(()=>service.create(taskId,request(),actor),{code:'IMAGE_EDIT_CONFLICT'});
      await pool.query('UPDATE tasks SET mandatory_copy_qc=false WHERE id=$1',[taskId]);
    });
    await t.test('reference uploads store only sanitized reference assets and freeze hashes in drafts',async()=>{
      const uploaded=await service.upload(taskId,{base64:png.toString('base64'),mediaType:'image/png',purpose:'实物',source:'测试自有照片'},actor);
      const asset=await service.asset(uploaded.id,taskId);assert.equal(asset.asset_role,'REFERENCE');assert.equal(asset.active,false);assert.equal(asset.edit_metadata.uploadedBy,actor.username);
      assert.equal((await pool.query('SELECT id FROM image_run_asset_view WHERE id=$1',[uploaded.id])).rows.length,0);
      const draft=await service.create(taskId,request({operation:'COMPOSITE',draft:true,references:[{assetId:uploaded.id,x:200,y:500,width:100,height:100}]}),actor);
      const binding=(await pool.query('SELECT * FROM image_edit_reference_assets WHERE request_id=$1',[draft.id])).rows[0];assert.equal(binding.sha256,uploaded.sha256);
      await action(draft.id,'cancel');
    });
    await t.test('an unconfirmed AI draft saves without cost and requires confirmation when queued',async()=>{
      const draft=await service.create(taskId,request({confirmation:undefined,draft:true}),actor);
      assert.equal(draft.status,'DRAFT');assert.equal(draft.config.confirmation,null);
      await assert.rejects(()=>action(draft.id,'queue'),/确认/u);
      const queued=await action(draft.id,'queue',{confirmation:'LIVE_IMAGE_COST_ACCEPTED'});
      assert.equal(queued.status,'QUEUED');assert.equal(queued.config.confirmation,'LIVE_IMAGE_COST_ACCEPTED');
      await action(draft.id,'cancel');
    });
    await t.test('programmatic disclosure skips cost confirmation and waits for a version 8 image executor',async()=>{
      const programmatic=await service.create(taskId,request({operation:'SVG_DISCLOSURE',confirmation:undefined}),actor);
      assert.equal(programmatic.status,'QUEUED');assert.equal(programmatic.config.confirmation,null);
      assert.equal(programmatic.config.imageEditPrompt,undefined);
      assert.equal(await repository.claimImage('edit-test',1,2,7),null);
      const claim=await repository.claimImage('edit-test',1,2,8);
      assert.equal(claim.imageEdit.id,programmatic.id);
      assert.equal(claim.execution.snapshot.imageEditExecutorVersion,8);
      await action(programmatic.id,'cancel');
    });
    let first;
    await t.test('create is idempotent and withdraws a ready delivery before any execution',async()=>{
      await pool.query('UPDATE tasks SET image_qc_legacy_accepted=true WHERE id=$1',[taskId]);
      await createReadyDeliveryEntry(pool,{taskId,copyRevisionId,imageRunId:currentRun,actor:adminActor});
      const input=request();first=await service.create(taskId,input,actor);
      assert.equal(first.config.imageEditRepairMaxAttempts,1);
      assert.equal(first.config.imageEditPrompt.kind,'IMAGE_EDIT_SYSTEM');
      assert.equal((await service.create(taskId,input,actor)).id,first.id);
      await assert.rejects(()=>service.create(taskId,{...input,overlay:{text:'不同文字'}},actor),{code:'IMAGE_EDIT_CONFLICT'});
      assert.equal((await pool.query('SELECT status FROM delivery_entries WHERE task_id=$1',[taskId])).rows[0].status,'WITHDRAWN');
      await assert.rejects(()=>createReadyDeliveryEntry(pool,{taskId,copyRevisionId,imageRunId:currentRun,actor:adminActor}),{code:'IMAGE_QA_NOT_RELEASED'});
    });
    await t.test('executor image capacity claims a request once; cancellation fences late completion',async()=>{
      await pool.query("UPDATE tasks SET priority_mode='HIGHEST' WHERE id=$1",[taskId]);
      const lowTask=(await pool.query("INSERT INTO tasks(query,state,created_by_node_id,copy_executor_node_id,assigned_to_user_id,assignment_source,assigned_at,priority_mode,image_qc_legacy_accepted) VALUES('low edit fixture','MANUAL_ARCHIVE','edit-test','edit-test',$1,'MANUAL',now(),'DEFER',true) RETURNING *",[actor.username])).rows[0];
      const lowTaskId=Number(lowTask.id),lowRunId=randomUUID();
      const lowRevision=(await pool.query("INSERT INTO copy_revisions(task_id,revision,content,approved_at) VALUES($1,1,$2,now()) RETURNING *",[lowTaskId,{copy:{title:'标题',body:'正文',tags:[]},imagePlan:[1,2,3].map(()=>({kind:'detail',headline:'真实参考'}))}])).rows[0];
      await pool.query("INSERT INTO image_runs(id,task_id,copy_revision_id,status,image_production_chain_id,result) VALUES($1,$2,$3,'COMPLETED',$1,$4)",[lowRunId,lowTaskId,lowRevision.id,{images:[]}]);
      const lowPath=resolve(root,'low-source.png');await writeFile(lowPath,png);
      const lowAsset=(await pool.query("INSERT INTO assets(task_id,image_run_id,media_type,byte_size,sha256,storage_path,image_production_chain_id,artifact_key,origin_image_run_id) VALUES($1,$2,'image/png',$3,$4,$5,$2,'low-source',$2) RETURNING id",[lowTaskId,lowRunId,png.length,sha256,lowPath])).rows[0];
      const lowImages=[1,2,3].map(pageIndex=>({assetId:Number(lowAsset.id),deliveryAssetId:Number(lowAsset.id),pageIndex}));
      await pool.query('UPDATE image_runs SET result=$2 WHERE id=$1',[lowRunId,{images:lowImages}]);
      await pool.query('UPDATE tasks SET current_copy_revision_id=$2,current_image_run_id=$3 WHERE id=$1',[lowTaskId,lowRevision.id,lowRunId]);
      const lowEdit=await service.create(lowTaskId,{requestId:randomUUID(),sourceImageRunId:lowRunId,
        sourceAssetId:Number(lowAsset.id),copyRevisionId:Number(lowRevision.id),sha256,targetPage:2,
        operation:'TEXT',confirmation:'LIVE_IMAGE_COST_ACCEPTED',overlay:{text:'AI生成',textType:'AI_DISCLOSURE',disclosureType:'AI_GENERATED',position:'bottom-right'}},actor);
      const claims=await Promise.all([
        repository.claimImage('edit-test',1,2,7),repository.claimImage('edit-test',1,2,7),
      ]);assert.equal(claims.filter(Boolean).length,1);
      const executorClaim=claims.find(Boolean);
      assert.equal(executorClaim.imageEdit.id,first.id);
      assert.equal(executorClaim.execution.snapshot.imageEditRequestId,first.id);
      assert.equal((await pool.query('SELECT state FROM tasks WHERE id=$1',[taskId])).rows[0].state,'MANUAL_ARCHIVE');
      await action(first.id,'cancel');
      assert.equal((await pool.query('SELECT status FROM task_executions WHERE id=$1',[executorClaim.execution.id])).rows[0].status,'ABANDONED');
      await assert.rejects(()=>service.complete(executorClaim.imageEdit,{bytes:png,validation:{passed:true}}),{code:'IMAGE_EDIT_CONFLICT'});
      await action(lowEdit.id,'cancel');
    });
    await t.test('paid appearance-reference edits wait for a version 7 image executor',async()=>{
      const reference=await service.upload(taskId,{base64:png.toString('base64'),mediaType:'image/png',purpose:'外观参考',source:'测试自有照片'},actor);
      const appearanceEdit=await service.create(taskId,request({operation:'AI_FUSION',referenceMode:'APPEARANCE',
        instruction:'按主产品可见外观替换目标',references:[{assetId:reference.id,purpose:'真实产品替换'}],
        target:{description:'画面中央的产品',region:{x:300,y:400,width:480,height:600}}}),actor);
      assert.equal(await repository.claimImage('edit-test',1,2,6),null);
      const claim=await repository.claimImage('edit-test',1,2,7);
      assert.equal(claim.imageEdit.id,appearanceEdit.id);
      assert.equal(claim.execution.snapshot.imageEditExecutorVersion,7);
      await action(appearanceEdit.id,'cancel');
    });
    await t.test('natural-language local edits wait for a version 7 image executor',async()=>{
      const localEdit=await service.create(taskId,request({operation:'AI_LOCAL',instruction:'把右上角的白色杯子改为蓝色'}),actor);
      assert.equal(await repository.claimImage('edit-test',1,2,6),null);
      const claim=await repository.claimImage('edit-test',1,2,7);
      assert.equal(claim.imageEdit.id,localEdit.id);
      assert.equal(claim.execution.snapshot.imageEditExecutorVersion,7);
      await action(localEdit.id,'cancel');
    });
    await t.test('a rejected generated result remains visible and can be adopted by explicit human choice',async()=>{
      const rejected=await service.create(taskId,request(),actor);
      let checks=0;
      const rejectValidation=async({imagePath})=>{
        checks++;
        if(!imagePath.endsWith('result.png'))return validateImage({imagePath});
        return {passed:false,model:'fake-vision',layoutMatched:false,ocrConfidence:.95,ocrMismatches:['人工生成标识缺失'],
          unreadableText:[],recognizedText:{headline:'真实参考',subtitle:'',bullets:[],otherText:[]}};
      };
      const rendered=await processImageEdit({service,storageRoot:root,workerId:'rejected-preview',agentClient,validateImage:rejectValidation});
      assert.equal(rendered.status,'FAILED');assert.ok(checks>=2);
      const failed=await service.get(rejected.id);
      assert.equal(failed.status,'FAILED');assert.equal(failed.result.validation.passed,false);
      assert.equal((await service.asset(Number(failed.result.asset_id),taskId)).asset_role,'REJECTED_PREVIEW');
      assert.equal((await pool.query('SELECT status FROM image_runs WHERE id=$1',[failed.result.image_run_id])).rows[0].status,'FAILED');
      await assert.rejects(()=>action(rejected.id,'accept'),/明确确认/u);
      await action(rejected.id,'accept',{acceptRejectedResult:true});
      const adopted=await service.get(rejected.id);
      assert.equal(adopted.status,'ACCEPTED');assert.equal(adopted.result.adopted,true);
      assert.equal((await pool.query('SELECT status FROM image_runs WHERE id=$1',[adopted.result.image_run_id])).rows[0].status,'COMPLETED');
      assert.equal((await service.asset(Number(adopted.result.asset_id),taskId)).asset_role,'DELIVERY');
      currentRun=adopted.result.image_run_id;currentAsset=Number(adopted.result.asset_id);currentHash=(await service.asset(currentAsset,taskId)).sha256;
    });
    await t.test('executor rejected-result upload is lease-bound and idempotent',async()=>{
      const rejected=await service.create(taskId,request(),actor);
      const claim=await repository.claimImage('edit-test',1,2,7);
      assert.equal(claim.imageEdit.id,rejected.id);
      const app=createControlPlaneApp({repository,storageRoot:root});
      const server=await new Promise(resolveServer=>{const listening=app.listen(0,'127.0.0.1',()=>resolveServer(listening));});
      try {
        const control=createControlPlaneClient({baseUrl:`http://127.0.0.1:${server.address().port}`});
        const failure=Object.assign(new Error('图片已生成，但目标位置不正确'),{validation:{stage:'LOCAL_EDIT_RESULT',passed:false,billedImageGeneration:true}});
        const firstResult=await control.rejectImageEdit(claim.execution.id,claim.imageEdit,disclosurePng,failure);
        const replayed=await control.rejectImageEdit(claim.execution.id,claim.imageEdit,disclosurePng,failure);
        assert.equal(replayed.assetId,firstResult.assetId);
      } finally { await new Promise(close=>server.close(close));await app.context.disposeControlPlaneResources?.(); }
      const failed=await service.get(rejected.id);
      assert.equal(failed.status,'FAILED');assert.equal(failed.error,'图片已生成，但目标位置不正确');
      assert.equal((await service.asset(Number(failed.result.asset_id),taskId)).asset_role,'REJECTED_PREVIEW');
      await action(rejected.id,'cancel');
    });
    let edited;
    await t.test('executor transfer produces a validated preview without changing current run',async()=>{
      edited=await service.create(taskId,request(),actor);
      const claim=await repository.claimImage('edit-test',1,2,7);
      assert.equal(claim.imageEdit.id,edited.id);
      const app=createControlPlaneApp({repository,storageRoot:root});
      const server=await new Promise(resolveServer=>{const listening=app.listen(0,'127.0.0.1',()=>resolveServer(listening));});
      try{
        const control=createControlPlaneClient({baseUrl:`http://127.0.0.1:${server.address().port}`});
        const remote={claim:async()=>claim.imageEdit,
          heartbeat:()=>control.heartbeatImageEdit(claim.execution.id,claim.imageEdit),
          context:()=>control.imageEditContext(claim.execution.id,claim.imageEdit),
          readAsset:asset=>control.imageEditAsset(claim.execution.id,claim.imageEdit,Number(asset.id)),
          asset:assetId=>control.imageEditAssetMetadata(claim.execution.id,claim.imageEdit,Number(assetId)),
          complete:async(_edit,input)=>{await control.stageImageEditValidation(claim.execution.id,claim.imageEdit,input.validation);return control.completeImageEdit(claim.execution.id,claim.imageEdit,input.bytes);},
          fail:(_edit,error)=>control.failImageEdit(claim.execution.id,claim.imageEdit,error),
        };
        const result=await processImageEdit({service:remote,storageRoot:root,workerId:'edit-test',edit:claim.imageEdit,agentClient,validateImage});assert.equal(result.status,'PREVIEW_READY',result.error);
      }finally{await new Promise(close=>server.close(close));await app.context.disposeControlPlaneResources?.();}
      assert.equal((await pool.query('SELECT current_image_run_id FROM tasks WHERE id=$1',[taskId])).rows[0].current_image_run_id,currentRun);
      const e=await service.get(edited.id),run=(await pool.query('SELECT result FROM image_runs WHERE id=$1',[e.result.image_run_id])).rows[0];
      assert.equal((await pool.query('SELECT status FROM task_executions WHERE id=$1',[claim.execution.id])).rows[0].status,'SUCCEEDED');
      assert.equal((await pool.query('SELECT execution_id FROM image_runs WHERE id=$1',[e.result.image_run_id])).rows[0].execution_id,claim.execution.id);
      assert.deepEqual(run.result.images[0],images[0]);assert.deepEqual(run.result.images[2],images[2]);assert.notEqual(run.result.images[1].assetId,images[1].assetId);
      assert.equal((await service.asset(Number(e.result.asset_id),taskId)).original_name,'02-image.png');
      const members=(await pool.query('SELECT id FROM image_run_asset_view WHERE image_run_id=$1',[e.result.image_run_id])).rows;
      assert.equal(members.length,3);
    });
    await t.test('accept is idempotent, audits once, and returns task to manual review',async()=>{
      const e=await service.get(edited.id),input={version:e.version,requestId:randomUUID(),reason:'确认采用'};
      await service.action(e.id,'accept',input,actor);await service.action(e.id,'accept',input,actor);
      const task=(await pool.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];assert.equal(task.state,'MANUAL_ARCHIVE');assert.equal(task.image_reviewed_at,null);
      currentRun=task.current_image_run_id;currentAsset=Number(e.result.asset_id);currentHash=(await service.asset(currentAsset,taskId)).sha256;
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM image_edit_events WHERE request_id=$1',[input.requestId])).rows[0].count,1);
      await assert.rejects(()=>service.create(taskId,request({sourceImageRunId:runId,sourceAssetId:images[1].assetId,sha256}),actor),{code:'IMAGE_EDIT_CONFLICT'});
    });
    await t.test('a disclosure adopted on one page is not required on another page source',async()=>{
      const baseResult=(await pool.query('SELECT result FROM image_runs WHERE id=$1',[currentRun])).rows[0].result;
      const sourceAssetId=Number(baseResult.images[0].deliveryAssetId??baseResult.images[0].assetId);
      const source=await service.asset(sourceAssetId,taskId);
      const pageOne=await service.create(taskId,request({sourceImageRunId:currentRun,sourceAssetId,
        sha256:source.sha256,targetPage:1}),actor);
      const processed=await processImageEdit({service,storageRoot:root,workerId:'page-scoped-disclosure',agentClient,validateImage});
      assert.equal(processed.status,'PREVIEW_READY',processed.error);
      await action(pageOne.id,'reject');
    });
    await t.test('an AI edit on another page does not infer the production disclosure default',async()=>{
      await pool.query("UPDATE global_settings SET value=$1 WHERE key='production'",[{aiDisclosureEnabled:true,aiDisclosureText:'AI生成',imageEditRepairMaxAttempts:1}]);
      const baseResult=(await pool.query('SELECT result FROM image_runs WHERE id=$1',[currentRun])).rows[0].result;
      const sourceAssetId=Number(baseResult.images[0].deliveryAssetId??baseResult.images[0].assetId);
      const source=await service.asset(sourceAssetId,taskId);
      const localEdit=await service.create(taskId,request({sourceImageRunId:currentRun,sourceAssetId,
        sha256:source.sha256,targetPage:1,operation:'AI_LOCAL',instruction:'只调整背景颜色'}),actor);
      const localClient={
        runVision:async({prompt})=>prompt.includes('编辑规划器')?({model:'fake-localizer',rawText:JSON.stringify({
          passed:true,confidence:0.99,candidateCount:1,targetDescription:'唯一背景区域',
          region:{x:100,y:500,width:300,height:300},reason:'测试目标唯一且不覆盖文字',
          checks:{instructionSpecific:true,exactlyOneTarget:true,wholeTargetInsideRegion:true,protectedTextExcluded:true},
        })}):({model:'fake-result-check',rawText:JSON.stringify({passed:true,reason:'结果正确',checks:{requestedChangeCompleted:true,targetCountCorrect:true,
          placementAndRepairNatural:true,protectedTextPreserved:true,unrelatedContentPreserved:true}})}),
        runImageEdit:async({prompt,outputPath})=>{
        assert.match(prompt,/LOCAL_MASK_EDIT/u);assert.doesNotMatch(prompt,/AI生成/u);
        await writeFile(outputPath,localPng);return{model:'fake-local-edit'};
        },
      };
      const localValidation=async()=>({passed:true,model:'fake-vision',layoutMatched:true,ocrConfidence:1,
        ocrMismatches:[],unreadableText:[],recognizedText:{headline:'真实参考',subtitle:'',bullets:[],otherText:[]}});
      const processed=await processImageEdit({service,storageRoot:root,workerId:'page-scoped-ai-edit',agentClient:localClient,validateImage:localValidation});
      assert.equal(processed.status,'PREVIEW_READY',processed.error);
      assert.equal((await service.get(localEdit.id)).result.validation.disclosure.required,'');
      await action(localEdit.id,'reject');
      await pool.query("UPDATE global_settings SET value=$1 WHERE key='production'",[{aiDisclosureEnabled:false,imageEditRepairMaxAttempts:1}]);
    });
    await t.test('accepting previews for different pages rebases the later preview onto the latest image set',async()=>{
      const baseRun=currentRun;
      const baseResult=(await pool.query('SELECT result FROM image_runs WHERE id=$1',[baseRun])).rows[0].result;
      const pageEdit=async targetPage=>{
        const sourceAssetId=Number(baseResult.images[targetPage-1].deliveryAssetId??baseResult.images[targetPage-1].assetId);
        const source=await service.asset(sourceAssetId,taskId);
        return service.create(taskId,request({sourceImageRunId:baseRun,sourceAssetId,sha256:source.sha256,targetPage}),actor);
      };
      const firstPage=await pageEdit(1),thirdPage=await pageEdit(3);
      for(let index=0;index<2;index++) {
        const result=await processImageEdit({service,storageRoot:root,workerId:`merge-${index}`,agentClient,validateImage});
        assert.equal(result.status,'PREVIEW_READY',result.error);
      }
      const firstPreview=await service.get(firstPage.id),thirdPreview=await service.get(thirdPage.id);
      await action(firstPage.id,'accept');
      const firstAdoptedRun=(await pool.query('SELECT current_image_run_id FROM tasks WHERE id=$1',[taskId])).rows[0].current_image_run_id;
      await action(thirdPage.id,'accept');
      const finalTask=(await pool.query('SELECT current_image_run_id FROM tasks WHERE id=$1',[taskId])).rows[0];
      const finalRun=(await pool.query('SELECT result FROM image_runs WHERE id=$1',[finalTask.current_image_run_id])).rows[0];
      const adoptedThird=await service.get(thirdPage.id);
      assert.equal(Number(finalRun.result.images[0].deliveryAssetId),Number(firstPreview.result.asset_id));
      assert.deepEqual(finalRun.result.images[1],baseResult.images[1]);
      assert.equal(Number(finalRun.result.images[2].deliveryAssetId),Number(thirdPreview.result.asset_id));
      assert.notEqual(adoptedThird.result.image_run_id,thirdPreview.result.image_run_id);
      assert.equal(adoptedThird.result.image_run_id,finalTask.current_image_run_id);
      assert.equal(finalRun.result.processing.parentRunId,firstAdoptedRun);
      assert.equal(finalRun.result.processing.previewRunId,thirdPreview.result.image_run_id);
      currentRun=finalTask.current_image_run_id;
    });
    await t.test('a local-edit suggestion can be adopted once and freezes its executable plan',async()=>{
      const originalInstruction='把画面右下角的一勺老抽变成半勺并移动到左侧';
      const suggestedInstruction='将画面右下角正在倒出的汤勺和液流移动到锅的左侧，把勺中老抽减少为半勺，保持液流落入锅内并自然修复原位置；不要修改文字和其他内容。';
      const suggested=await service.create(taskId,request({operation:'AI_LOCAL',instruction:originalInstruction}),actor);
      const claim=await service.claim('suggestion');
      assert.equal(claim.id,suggested.id);
      const validation={stage:'LOCAL_EDIT_SUGGESTION',decision:'SUGGEST',canEdit:true,confidence:0.96,candidateCount:1,
        operationType:'MOVE',targetDescription:'右下角汤勺和液流',touchesImageEdge:true,sourceRegion:{x:910,y:965,width:176,height:483},
        destinationRegion:{x:470,y:850,width:260,height:460},editRegions:[{x:890,y:940,width:196,height:508},{x:430,y:810,width:340,height:540}],
        suggestedInstruction,warnings:['目标贴边'],reason:'目标唯一，但需要明确落点与原位置修复。',
        checks:{instructionSpecific:true,exactlyOneTarget:true,wholeVisibleTargetInsideRegion:true,protectedTextExcluded:true,editRegionSafe:true},
        model:'fake-planner',billedImageGeneration:false};
      await service.fail(claim,Object.assign(new Error('已生成更适合图片编辑的描述，请确认采用后再调用图片编辑模型'),{nonBillablePreflightFailure:true,validation}));
      const queued=await action(suggested.id,'apply-suggestion');
      assert.equal(queued.status,'QUEUED');assert.equal(queued.config.instruction,suggestedInstruction);assert.equal(queued.config.localPlan.accepted,true);
      assert.equal(queued.config.localPlan.originalInstruction,originalInstruction);assert.equal(queued.config.localPlan.editRegions.length,2);
      const event=(await pool.query("SELECT detail FROM image_edit_events WHERE edit_id=$1 AND action='apply-suggestion'",[suggested.id])).rows[0];
      assert.equal(event.detail.suggestedInstruction,suggestedInstruction);
      await action(suggested.id,'cancel');
    });
    await t.test('a user-approved targeted retry freezes the rejected preview and reduced repair region',async()=>{
      const instruction='把右下角汤勺移动到锅的左侧，并保持半勺老抽倒入锅内';
      const local=await service.create(taskId,request({operation:'AI_LOCAL',instruction}),actor);
      const claimed=await service.claim('targeted-repair-source');
      assert.equal(claimed.id,local.id);
      const sourceRegion={x:830,y:960,width:256,height:488},destinationRegion={x:450,y:830,width:300,height:500};
      const validation={stage:'LOCAL_EDIT_RESULT',passed:false,billedImageGeneration:true,
        localization:{mode:'VISION_PROMPT_REGION_CHECK',operationType:'MOVE',targetDescription:'右下角汤勺和液流',
          sourceAction:'清除右下角旧勺和液流',destinationAction:'在锅左侧重建同一把勺子',quantity:'半勺老抽',relationship:'液流落入锅内',
          sourceRegion,destinationRegion,contactRegion:{x:560,y:1180,width:90,height:80},editRegions:[sourceRegion,destinationRegion],
          touchesImageEdge:true,warnings:['贴边'],reason:'唯一目标',confidence:.96,checks:{}},
        localConsistency:{passed:false,reason:'旧勺已删除，但左侧没有出现新勺和入锅液流',
          failureCodes:['DESTINATION_OBJECT_MISSING','POUR_CONTACT_MISSING'],repairableFromRejected:true,
          repairInstruction:'只在锅左侧补生成半勺老抽的汤勺，并让连续液流落入锅内',repairRegions:[destinationRegion],
          checks:{requestedChangeCompleted:false,targetCountCorrect:false,placementAndRepairNatural:false,protectedTextPreserved:true,unrelatedContentPreserved:true},
          repairAttempt:0,repairMaxAttempts:1}};
      await service.fail(claimed,Object.assign(new Error('局部修改结果未通过验收'),{validation}),{bytes:localPng});
      const failed=await service.get(local.id);
      await assert.rejects(()=>action(local.id,'retry',{useRejectedPreview:true}),/重新确认费用/u);
      const unsafeValidation=structuredClone(failed.result.validation);
      unsafeValidation.localConsistency.checks.protectedTextPreserved=false;
      unsafeValidation.localConsistency.failureCodes.push('PROTECTED_TEXT_CHANGED');
      await pool.query('UPDATE image_edit_results SET validation=$2 WHERE request_id=$1',[local.id,unsafeValidation]);
      await assert.rejects(()=>action(local.id,'retry',{useRejectedPreview:true,confirmation:'LIVE_IMAGE_COST_ACCEPTED'}),/不能安全局部补救/u);
      await pool.query('UPDATE image_edit_results SET validation=$2 WHERE request_id=$1',[local.id,failed.result.validation]);
      const queued=await action(local.id,'retry',{useRejectedPreview:true,confirmation:'LIVE_IMAGE_COST_ACCEPTED'});
      assert.equal(queued.status,'QUEUED');assert.equal(queued.config.localRepair.attempt,1);
      assert.equal(queued.config.localRepair.baseAssetId,Number(failed.result.asset_id));
      assert.deepEqual(queued.config.localRepair.failureCodes,['DESTINATION_OBJECT_MISSING','POUR_CONTACT_MISSING']);
      assert.deepEqual(queued.config.localRepair.repairRegions,[destinationRegion]);
      const repairClaim=await repository.claimImage('edit-test',1,2,7);
      assert.equal(repairClaim.imageEdit.id,local.id);
      const app=createControlPlaneApp({repository,storageRoot:root});
      const server=await new Promise(resolveServer=>{const listening=app.listen(0,'127.0.0.1',()=>resolveServer(listening));});
      try {
        const control=createControlPlaneClient({baseUrl:`http://127.0.0.1:${server.address().port}`});
        const context=await control.imageEditContext(repairClaim.execution.id,repairClaim.imageEdit);
        assert.equal(Number(context.repairSource.id),Number(failed.result.asset_id));
        assert.equal((await control.imageEditAsset(repairClaim.execution.id,repairClaim.imageEdit,Number(context.repairSource.id))).equals(localPng),true);
      } finally { await new Promise(close=>server.close(close));await app.context.disposeControlPlaneResources?.(); }
      const event=(await pool.query("SELECT detail FROM image_edit_events WHERE edit_id=$1 AND action='retry' ORDER BY id DESC LIMIT 1",[local.id])).rows[0];
      assert.equal(event.detail.targetedRepair,true);assert.equal(event.detail.attempt,1);
      await action(local.id,'cancel');
    });
    await t.test('failures can retry, rejection leaves current image untouched, restore needs preview acceptance',async()=>{
      const restore=await service.create(taskId,request({operation:'RESTORE',restoreRunId:runId,instruction:'恢复'}),actor);
      const claimed=await service.claim('failure');
      await service.fail(claimed,Object.assign(new Error('fake preflight failure'),{nonBillablePreflightFailure:true,code:'ALIGNMENT_SERVICE_FAILED',serviceCode:'CODEX_CONCURRENCY_MISMATCH'}));
      assert.equal((await service.get(restore.id)).attempts,claimed.attempts-1);
      await action(restore.id,'retry');
      const result=await processImageEdit({service,storageRoot:root,workerId:'restore',validateImage:async()=>({passed:true,model:'fake-vision',layoutMatched:true,ocrConfidence:1,ocrMismatches:[],unreadableText:[],recognizedText:{headline:'真实参考',subtitle:'',bullets:[],otherText:[]}})});
      assert.equal(result.status,'PREVIEW_READY',result.error);await action(restore.id,'reject');
      assert.equal((await pool.query('SELECT current_image_run_id FROM tasks WHERE id=$1',[taskId])).rows[0].current_image_run_id,currentRun);
      const failedEdit=await service.create(taskId,request({operation:'RESTORE',restoreRunId:runId,instruction:'删除失败修复'}),actor);
      const failedClaim=await service.claim('failure-delete');
      await service.fail(failedClaim,new Error('fake repair failure'));
      const deleted=await action(failedEdit.id,'cancel');
      assert.equal(deleted.status,'CANCELLED');
      const second=await service.create(taskId,request({operation:'RESTORE',restoreRunId:runId,instruction:'确认恢复'}),actor);
      const secondResult=await processImageEdit({service,storageRoot:root,workerId:'restore',validateImage:async()=>({passed:true,model:'fake-vision',layoutMatched:true,ocrConfidence:1,ocrMismatches:[],unreadableText:[],recognizedText:{headline:'真实参考',subtitle:'',bullets:[],otherText:[]}})});
      assert.equal(secondResult.status,'PREVIEW_READY',secondResult.error);
      await action(second.id,'accept');
      const restored=(await pool.query('SELECT r.result FROM tasks t JOIN image_runs r ON r.id=t.current_image_run_id WHERE t.id=$1',[taskId])).rows[0].result;
      assert.equal(restored.processing.type,'RESTORE');assert.deepEqual(restored.images[0],images[0]);assert.deepEqual(restored.images[2],images[2]);
    });
  }finally{if(pool)await pool.end();if(started)await ctl(['-D',data,'-m','fast','-w','stop']);assert.ok(resolve(root).startsWith(resolve(tmpdir())));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
