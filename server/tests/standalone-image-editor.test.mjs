import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import { startTemporaryPostgres18 } from './temporary-postgres18.mjs';
import { requestIdAt } from './fixtures/claim-request-id.mjs';
import { migrateDatabase } from '../src/database-migrations.mjs';
import { createPostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { createControlPlaneClient } from '../../src/control-plane/client.mjs';
import { createStandaloneImageEditor } from '../src/standalone-image-editor.mjs';
import { processStandaloneImageEdit,parseUploadImageReview } from '../src/standalone-image-editor-renderer.mjs';
import { imageHash } from '../../src/image-edit-pixels.mjs';

const vision=(text='原图文字')=>({passed:true,checks:{textPreserved:true,unrelatedContentPreserved:true},ocrConfidence:1,
  recognizedText:{headline:text,subtitle:'',bullets:[],otherText:[]},reason:''});
test('upload review fails closed on malformed, low-confidence, missing-text and negative checks',()=>{
  assert.equal(parseUploadImageReview(JSON.stringify(vision()),['原图文字']).passed,true);
  for(const patch of [{passed:false},{ocrConfidence:0.2},{checks:{textPreserved:false,unrelatedContentPreserved:true}},
    {checks:{textPreserved:true,unrelatedContentPreserved:false}}]) {
    const result=parseUploadImageReview(JSON.stringify({...vision(),...patch}));assert.equal(result.passed,false);assert.ok(result.ocrMismatches.length);
  }
  assert.equal(parseUploadImageReview(JSON.stringify(vision()),['缺少文字']).passed,false);
  assert.throws(()=>parseUploadImageReview('{}'));
});

test('standalone uploads: isolation, executor claims, shared capacity, preview, adoption, download and cancellation',
  {skip:process.env.RUN_POSTGRES_E2E!=='1',timeout:150000},async t=>{
  const db=await startTemporaryPostgres18('standalone-editor-pg-');
  const pool=new pg.Pool({connectionString:db.connectionString});
  const root=await mkdtemp(join(tmpdir(),'standalone-editor-assets-'));
  let app,server;
  try {
    await migrateDatabase(pool);
    const repository=createPostgresControlPlaneRepository({pool});
    const service=createStandaloneImageEditor({pool,storageRoot:root});
    const makeUser=async username=>{
      const user=(await pool.query("INSERT INTO app_users(username,display_name,role,password_hash,must_change_password) VALUES($1,$1,'USER','test-only',false) RETURNING *",[username])).rows[0];
      return {userId:Number(user.id),username,role:'USER',credentialVersion:user.credential_version};
    };
    const actor=await makeUser('standalone-owner'),other=await makeUser('standalone-other');
    await repository.registerNode({nodeId:'standalone-executor',name:'standalone-executor',imageWorkerEnabled:true,
      copyConcurrency:1,imageConcurrency:1,codexPoolId:'standalone-pool',codexTotalConcurrency:1,codexImageConcurrency:1,imageEditExecutorVersion:13});
    app=createControlPlaneApp({repository,storageRoot:root,logger:{info(){},error(){}}});
    server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    const baseUrl=`http://127.0.0.1:${server.address().port}`;
    const machine=createControlPlaneClient({baseUrl});
    const headers=a=>({'content-type':'application/json','x-actor-username':a.username,'x-actor-role':a.role,'x-actor-user-id':String(a.userId),'x-actor-credential-version':String(a.credentialVersion)});
    const request=async(path,{method='GET',body,as=actor}={})=>fetch(baseUrl+path,{method,headers:headers(as),...(body?{body:JSON.stringify(body)}:{})});
    const png=await sharp({create:{width:1086,height:1448,channels:4,background:'white'}}).png().toBuffer();
    const input={requestId:randomUUID(),title:'用户上传原图',images:[{mediaType:'image/png',base64:png.toString('base64')}]};
    const upload=await request('/v1/image-editor/workspaces',{method:'POST',body:input});
    assert.equal(upload.status,201,await upload.clone().text());
    const workspace=(await upload.json()).data,id=workspace.id;
    assert.equal((await service.create(input,actor)).id,id);
    await assert.rejects(()=>service.create({...input,title:'另一个内容'},actor),/不同上传内容/u);
    assert.equal((await request(`/v1/image-editor/workspaces/${id}`,{as:other})).status,403);
    assert.equal((await request(`/v1/image-editor/assets/${workspace.assets[0].id}`,{as:other})).status,403);
    assert.equal((await request(`/v1/tasks/${id}`)).status,404);
    assert.equal((await request(`/v1/tasks/${id}/image-edits`)).status,404);
    const tasks=await repository.listTasks({includeTotal:true});assert.equal(tasks.total,0);
    assert.equal((await repository.taskCounts({nodeId:'standalone-executor'})).manualArchive,0);
    const personal=await repository.personalWorkspace(actor,{});assert.equal(JSON.stringify(personal).includes('用户上传原图'),false);
    assert.equal((await service.list(actor)).total,1);assert.equal((await service.list(other)).total,0);
    assert.equal((await service.list(actor,{queue:true})).total,0);
    const small=await sharp({create:{width:20,height:20,channels:4,background:'white'}}).png().toBuffer();
    await assert.rejects(()=>service.create({...input,requestId:randomUUID(),images:[{mediaType:'image/png',base64:small.toString('base64')}]},actor),/1086/u);
    await assert.rejects(()=>service.create({...input,requestId:randomUUID(),images:[{mediaType:'image/jpeg',base64:png.toString('base64')}]},actor),/签名/u);
    await assert.rejects(()=>pool.query("UPDATE tasks SET state='IMAGE_QUEUED' WHERE id=$1",[id]),/standalone_image_workspace_state/u);
    const makeEdit=(extra={})=>({requestId:randomUUID(),sourceImageRunId:workspace.runId,sourceAssetId:workspace.assets[0].id,
      copyRevisionId:workspace.copyRevisionId,sha256:workspace.assets[0].sha256,targetPage:1,
      operation:'SVG_DISCLOSURE',overlay:{text:'AI生成'},...extra});
    const edit=await service.createEdit(id,makeEdit(),actor);
    assert.equal((await service.list(actor,{queue:true})).items[0].status,'QUEUED');
    assert.equal(await repository.claimImage('standalone-executor',1,2,12),null,'old executors must not claim uploads');
    const requestId=requestIdAt();
    const batch=await machine.claimImageBatch({nodeId:'standalone-executor',limit:1,requestId});
    const claim=batch.claims[0];assert.equal(claim.imageEdit.id,edit.id);
    assert.equal(claim.execution.snapshot.task.kind,'STANDALONE_IMAGE_EDIT');
    assert.equal((await machine.claimImageBatch({nodeId:'standalone-executor',limit:1,requestId})).claims[0].execution.id,claim.execution.id);
    assert.equal(await machine.claimImage('standalone-executor'),null,'shared IMAGE capacity is occupied');
    const remote=claim=>({context:()=>machine.imageEditContext(claim.execution.id,claim.imageEdit),
      readAsset:a=>machine.imageEditAsset(claim.execution.id,claim.imageEdit,Number(a.id)),
      asset:id=>machine.imageEditAssetMetadata(claim.execution.id,claim.imageEdit,id),
      heartbeat:()=>machine.heartbeatImageEdit(claim.execution.id,claim.imageEdit),
      async complete(_e,{bytes,validation}){await machine.stageImageEditValidation(claim.execution.id,claim.imageEdit,validation);return machine.completeImageEdit(claim.execution.id,claim.imageEdit,bytes);},
      fail:(_e,error,preview)=>preview?.bytes?machine.rejectImageEdit(claim.execution.id,claim.imageEdit,preview.bytes,error):machine.failImageEdit(claim.execution.id,claim.imageEdit,error)});
    const result=await processStandaloneImageEdit({service:remote(claim),storageRoot:root,workerId:'standalone-executor',edit:claim.imageEdit,
      agentClient:{runVision:()=>assert.fail('SVG must not call models'),runImageEdit:()=>assert.fail('SVG must not call models')}});
    assert.equal(result.status,'PREVIEW_READY',result.error);
    const ready=await service.getEdit(edit.id,actor);assert.equal(ready.status,'PREVIEW_READY');
    const download=await request(`/v1/image-editor/assets/${ready.result.asset_id}?download=true`);
    assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/^attachment/u);
    assert.equal(imageHash(Buffer.from(await download.arrayBuffer())),ready.result.validation.integrity.sha256);
    assert.equal((await request(`/v1/assets/${ready.result.asset_id}`)).status,404);
    await service.action(edit.id,'accept',{requestId:randomUUID(),version:ready.version,reason:'符合要求'},actor);
    assert.notEqual((await service.detail(id,actor)).runId,workspace.runId);
    assert.equal((await repository.listTasks({includeTotal:true})).total,0);
    assert.equal(Number((await pool.query('SELECT count(*) FROM delivery_entries WHERE task_id=$1',[id])).rows[0].count),0);
    await assert.rejects(()=>service.createEdit(id,makeEdit(),actor),/已更新/u);

    await t.test('AI adapter compares uploaded text and calls the image model once',async()=>{
      const fresh=await service.create({...input,requestId:randomUUID()},actor);
      const template=(await pool.query("INSERT INTO prompt_templates(kind,name) VALUES('IMAGE_EDIT_SYSTEM','图片编辑') RETURNING id")).rows[0];
      const content='按要求编辑图片，保留其余内容。';
      await pool.query("INSERT INTO prompt_versions(template_id,version,content,content_sha256,status,published_at) VALUES($1,1,$2,$3,'PUBLISHED',now())",[template.id,content,imageHash(Buffer.from(content))]);
      const e=await service.createEdit(fresh.id,{...makeEdit({operation:'TEXT',confirmation:'LIVE_IMAGE_COST_ACCEPTED'}),
        sourceImageRunId:fresh.runId,sourceAssetId:fresh.assets[0].id,copyRevisionId:fresh.copyRevisionId},actor);
      const claim=await machine.claimImage('standalone-executor');assert.equal(claim.imageEdit.id,e.id);
      let generations=0;const reviews=[];
      const output=await processStandaloneImageEdit({service:remote(claim),storageRoot:root,workerId:'standalone-executor',edit:claim.imageEdit,
        agentClient:{async runImageEdit({outputPath}){generations++;await writeFile(outputPath,png);return {model:'fake-image'};},
          async runVision(args){reviews.push(args);return {model:'fake-vision',rawText:JSON.stringify(vision(args.inputPaths.length===2?'原图文字AI生成':'原图文字'))};}}});
      assert.equal(output.status,'PREVIEW_READY',output.error);assert.equal(generations,1);
      assert.equal(reviews[0].inputPaths.length,1);assert.equal(reviews.at(-1).inputPaths.length,2);
      assert.match(reviews[0].prompt,/没有业务文案白名单/u);
    });
    await t.test('multi-page history restoration validates each page against its own source',async()=>{
      const fresh=await service.create({...input,requestId:randomUUID(),images:[input.images[0],input.images[0]]},actor);
      const e=await service.createEdit(fresh.id,{...makeEdit({operation:'RESTORE',restoreRunId:fresh.runId}),
        sourceImageRunId:fresh.runId,sourceAssetId:fresh.assets[0].id,copyRevisionId:fresh.copyRevisionId},actor);
      const claim=await machine.claimImage('standalone-executor');assert.equal(claim.imageEdit.id,e.id);
      const reviews=[];
      const output=await processStandaloneImageEdit({service:remote(claim),storageRoot:root,workerId:'standalone-executor',edit:claim.imageEdit,
        agentClient:{runImageEdit:()=>assert.fail('restore must not generate'),
          async runVision(args){reviews.push(args);return {rawText:JSON.stringify(vision())};}}});
      assert.equal(output.status,'PREVIEW_READY',output.error);
      assert.deepEqual(reviews.map(review=>review.inputPaths.length),[1,2,1]);
      const ready=await service.getEdit(e.id,actor);
      await service.action(e.id,'accept',{requestId:randomUUID(),version:ready.version,reason:'恢复上传图'},actor);
      assert.equal((await service.detail(fresh.id,actor)).assets.length,2);
    });
    await t.test('failed validation retains a quarantined preview and permits explicit retry',async()=>{
      const fresh=await service.create({...input,requestId:randomUUID()},actor);
      const e=await service.createEdit(fresh.id,{...makeEdit({operation:'TEXT',confirmation:'LIVE_IMAGE_COST_ACCEPTED'}),
        sourceImageRunId:fresh.runId,sourceAssetId:fresh.assets[0].id,copyRevisionId:fresh.copyRevisionId},actor);
      const claim=await machine.claimImage('standalone-executor');
      const output=await processStandaloneImageEdit({service:remote(claim),storageRoot:root,workerId:'standalone-executor',edit:claim.imageEdit,
        agentClient:{async runImageEdit({outputPath}){await writeFile(outputPath,png);return {model:'fake-image'};},
          async runVision(){return {rawText:JSON.stringify(vision())};}}});
      assert.equal(output.status,'FAILED');
      const failed=await service.getEdit(e.id,actor);assert.ok(failed.result.asset_id);assert.equal(failed.result.validation.passed,false);
      assert.equal((await service.detail(fresh.id,actor)).runId,fresh.runId);
      const queued=await service.action(e.id,'retry',{requestId:randomUUID(),version:failed.version,reason:'重新生成标识'},actor);
      assert.equal(queued.status,'QUEUED');
      await service.action(e.id,'cancel',{requestId:randomUUID(),version:queued.version,reason:'测试完成'},actor);
    });
    await t.test('cancellation prevents late writes and frees the shared slot',async()=>{
      const fresh=await service.create({...input,requestId:randomUUID()},actor);
      const e=await service.createEdit(fresh.id,{...makeEdit(),sourceImageRunId:fresh.runId,sourceAssetId:fresh.assets[0].id,copyRevisionId:fresh.copyRevisionId},actor);
      const claim=await machine.claimImage('standalone-executor');assert.equal(claim.imageEdit.id,e.id);
      const running=await service.getEdit(e.id,actor);
      await service.action(e.id,'cancel',{requestId:randomUUID(),version:running.version,reason:'取消编辑'},actor);
      await assert.rejects(()=>machine.stageImageEditValidation(claim.execution.id,claim.imageEdit,{passed:true}),/取消|租约/u);
      await assert.rejects(()=>machine.completeImageEdit(claim.execution.id,claim.imageEdit,png),/取消|租约/u);
    });
  }finally{
    if(server)await new Promise(r=>server.close(r));
    await app?.context.disposeControlPlaneResources?.();
    await pool.end();await db.stop();
    assert.ok(resolve(root).startsWith(resolve(tmpdir())));
    await rm(root,{recursive:true,force:true});
  }
});
