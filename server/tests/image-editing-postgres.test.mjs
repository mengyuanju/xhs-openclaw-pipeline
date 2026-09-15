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
    const actor={userId:Number(admin.id),username:admin.username,role:'ADMIN',credentialVersion:admin.credential_version};
    await pool.query("INSERT INTO executor_nodes(id,name) VALUES('edit-test','edit-test')");
    const task=(await pool.query("INSERT INTO tasks(query,state,created_by_node_id,copy_executor_node_id) VALUES('edit fixture','MANUAL_ARCHIVE','edit-test','edit-test') RETURNING *")).rows[0];
    const taskId=Number(task.id),runId=randomUUID();
    const revision=(await pool.query("INSERT INTO copy_revisions(task_id,revision,content,approved_at) VALUES($1,1,$2,now()) RETURNING *",[taskId,{copy:{title:'标题',body:'正文',tags:[]},imagePlan:[1,2,3].map(()=>({kind:'detail',headline:'真实参考'}))}])).rows[0];
    const copyRevisionId=Number(revision.id);
    await pool.query("INSERT INTO image_runs(id,task_id,copy_revision_id,status,image_production_chain_id) VALUES($1,$2,$3,'COMPLETED',$1)",[runId,taskId,copyRevisionId]);
    const png=await sharp({create:{width:1086,height:1448,channels:4,background:'white'}}).png().toBuffer(),sha256=imageHash(png);
    const images=[];
    for(let i=0;i<3;i++){
      const path=resolve(root,`source-${i}.png`);await writeFile(path,png);
      const a=(await pool.query("INSERT INTO assets(task_id,image_run_id,media_type,byte_size,sha256,storage_path,image_production_chain_id,artifact_key,origin_image_run_id) VALUES($1,$2,'image/png',$3,$4,$5,$2,$6,$2) RETURNING id",[taskId,runId,png.length,sha256,path,`source-${i}`])).rows[0];
      images.push({assetId:Number(a.id),deliveryAssetId:Number(a.id),pageIndex:i+1});
    }
    await pool.query('UPDATE image_runs SET result=$2 WHERE id=$1',[runId,{images}]);
    await pool.query('UPDATE tasks SET current_copy_revision_id=$2,current_image_run_id=$3 WHERE id=$1',[taskId,copyRevisionId,runId]);
    await pool.query("UPDATE global_settings SET value=$1 WHERE key='production'",[{aiDisclosureEnabled:false,imageEditRepairMaxAttempts:1}]);
    const service=createImageEditingService({pool,storageRoot:root});
    let currentRun=runId,currentAsset=images[1].assetId,currentHash=sha256;
    const request=(extra={})=>({requestId:randomUUID(),sourceImageRunId:currentRun,sourceAssetId:currentAsset,copyRevisionId,sha256:currentHash,targetPage:2,operation:'TEXT',confirmation:'LIVE_IMAGE_COST_ACCEPTED',overlay:{text:'AI生成',textType:'AI_DISCLOSURE',disclosureType:'AI_GENERATED',position:'bottom-right'},...extra});
    const validateImage=async({imagePath})=>({passed:true,model:'fake-vision',layoutMatched:true,ocrConfidence:1,
      ocrMismatches:[],unreadableText:[],recognizedText:{headline:'真实参考',subtitle:'',bullets:[],otherText:imagePath.endsWith('result.png')?['AI生成']:[]}});
    const agentClient={runImageEdit:async({prompt,inputPaths,outputPath})=>{assert.match(prompt,/<trusted_business_rules kind="IMAGE_EDIT_SYSTEM">/u);assert.match(prompt,/AI_DISCLOSURE_LABEL/u);assert.equal(inputPaths.length,1);await writeFile(outputPath,png);return{model:'fake-text-edit'};}};
    const action=async(id,name,extra={})=>{const e=await service.get(id);return service.action(id,name,{version:e.version,requestId:randomUUID(),reason:'test',...extra},actor);};
    await t.test('permissions, copy gate and source conflicts fail before queue insertion',async()=>{
      await assert.rejects(()=>service.create(taskId,request(),{...actor,role:'USER'}),{code:'FORBIDDEN'});
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
    let first;
    await t.test('create is idempotent and withdraws a ready delivery before any execution',async()=>{
      await createReadyDeliveryEntry(pool,{taskId,copyRevisionId,imageRunId:currentRun,actor});
      const input=request();first=await service.create(taskId,input,actor);
      assert.equal(first.config.imageEditRepairMaxAttempts,1);
      assert.equal(first.config.imageEditPrompt.versionId,Number(promptVersion.id));
      assert.equal(first.config.imageEditPrompt.content,imageEditPromptContent);
      assert.equal((await service.create(taskId,input,actor)).id,first.id);
      await assert.rejects(()=>service.create(taskId,{...input,overlay:{text:'不同文字'}},actor),{code:'IMAGE_EDIT_CONFLICT'});
      assert.equal((await pool.query('SELECT status FROM delivery_entries WHERE task_id=$1',[taskId])).rows[0].status,'WITHDRAWN');
      await assert.rejects(()=>createReadyDeliveryEntry(pool,{taskId,copyRevisionId,imageRunId:currentRun,actor}),/待处理/u);
    });
    await t.test('concurrent workers claim a request once; cancellation fences late completion',async()=>{
      const claims=await Promise.all([service.claim('one'),service.claim('two')]);assert.equal(claims.filter(Boolean).length,1);
      await action(first.id,'cancel');
      await assert.rejects(()=>service.complete(claims.find(Boolean),{bytes:png,validation:{passed:true}}),{code:'IMAGE_EDIT_CONFLICT'});
    });
    let edited;
    await t.test('AI text execution produces a validated preview without changing current run',async()=>{
      edited=await service.create(taskId,request(),actor);
      const result=await processImageEdit({service,storageRoot:root,workerId:'fake',agentClient,validateImage});assert.equal(result.status,'PREVIEW_READY',result.error);
      assert.equal((await pool.query('SELECT current_image_run_id FROM tasks WHERE id=$1',[taskId])).rows[0].current_image_run_id,currentRun);
      const e=await service.get(edited.id),run=(await pool.query('SELECT result FROM image_runs WHERE id=$1',[e.result.image_run_id])).rows[0];
      assert.deepEqual(run.result.images[0],images[0]);assert.deepEqual(run.result.images[2],images[2]);assert.notEqual(run.result.images[1].assetId,images[1].assetId);
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
    await t.test('failures can retry, rejection leaves current image untouched, restore needs preview acceptance',async()=>{
      const restore=await service.create(taskId,request({operation:'RESTORE',restoreRunId:runId,instruction:'恢复'}),actor);
      const claimed=await service.claim('failure');await service.fail(claimed,new Error('fake failure'));await action(restore.id,'retry');
      const result=await processImageEdit({service,storageRoot:root,workerId:'restore',validateImage:async()=>({passed:true,model:'fake-vision',layoutMatched:true,ocrConfidence:1,ocrMismatches:[],unreadableText:[],recognizedText:{headline:'真实参考',subtitle:'',bullets:[],otherText:[]}})});
      assert.equal(result.status,'PREVIEW_READY',result.error);await action(restore.id,'reject');
      assert.equal((await pool.query('SELECT current_image_run_id FROM tasks WHERE id=$1',[taskId])).rows[0].current_image_run_id,currentRun);
      const second=await service.create(taskId,request({operation:'RESTORE',restoreRunId:runId,instruction:'确认恢复'}),actor);
      const secondResult=await processImageEdit({service,storageRoot:root,workerId:'restore',validateImage:async()=>({passed:true,model:'fake-vision',layoutMatched:true,ocrConfidence:1,ocrMismatches:[],unreadableText:[],recognizedText:{headline:'真实参考',subtitle:'',bullets:[],otherText:[]}})});
      assert.equal(secondResult.status,'PREVIEW_READY',secondResult.error);
      await action(second.id,'accept');
      const restored=(await pool.query('SELECT r.result FROM tasks t JOIN image_runs r ON r.id=t.current_image_run_id WHERE t.id=$1',[taskId])).rows[0].result;
      assert.equal(restored.processing.type,'RESTORE');assert.deepEqual(restored.images[0],images[0]);assert.deepEqual(restored.images[2],images[2]);
    });
  }finally{if(pool)await pool.end();if(started)await ctl(['-D',data,'-m','fast','-w','stop']);assert.ok(resolve(root).startsWith(resolve(tmpdir())));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
