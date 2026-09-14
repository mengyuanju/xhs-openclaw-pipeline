import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import sharp from 'sharp';

import { batchReturnCopyQa, getCopyQaBatchReturnPreview, passCopyQaItem, routeManualCopyApproval } from '../src/copy-quality-control.mjs';
import { migrateDatabase } from '../src/database-migrations.mjs';
import { processImageEdit } from '../src/image-edit-renderer.mjs';
import { createImageEditingService } from '../src/image-editing.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { createAgentClient } from '../../src/agent-client.mjs';
import { imageHash } from '../../src/image-edit-pixels.mjs';

const enabled=process.env.RUN_LIVE_WORKFLOW_PAID_E2E==='1';
const maintenanceUrl=process.env.LIVE_E2E_DATABASE_URL;
const replayPath=process.env.LIVE_IMAGE_EDIT_REPLAY_PATH?.trim()||null;

test('paid live workflow: admin priority, whole-person QA return/recheck, and Codex AI disclosure edit', {
  skip:!enabled,
  timeout:20*60_000,
}, async t=>{
  assert.ok(maintenanceUrl,'LIVE_E2E_DATABASE_URL is required');
  const adminUrl=new URL(maintenanceUrl);
  assert.ok(['127.0.0.1','localhost'].includes(adminUrl.hostname),'live E2E database must be local');
  const database=`live_e2e_${randomUUID().replaceAll('-','')}`;
  const administrator=new pg.Pool({connectionString:adminUrl.href});
  await administrator.query(`CREATE DATABASE ${database}`);
  adminUrl.pathname=`/${database}`;
  const storageRoot=await mkdtemp(resolve(tmpdir(),'xhs-live-paid-e2e-'));
  let repository;
  try {
    repository=new PostgresControlPlaneRepository({connectionString:adminUrl.href});
    await repository.initialize();
    await migrateDatabase(repository.pool);
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
    const batch=(await pool.query(`INSERT INTO production_batches(
        public_id,query_package_name,created_by_username,request_id,request_fingerprint
      ) VALUES($1,'live paid e2e','admin',$2,$3) RETURNING *`,[randomUUID(),randomUUID(),'e'.repeat(64)])).rows[0];
    const taskId=Date.now();
    assert.ok(Number.isSafeInteger(taskId));
    await pool.query(`INSERT INTO tasks(
        id,query,input,state,created_by_node_id,copy_executor_node_id,production_batch_id,
        assigned_to_user_id,assignment_source,assigned_at
      ) VALUES($1,'真实付费端到端测试','{}','COPY_RUNNING','live-paid','live-paid',$2,
        'live-producer','MANUAL',now())`,[taskId,batch.id]);
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
    assert.equal(Number(recheck.assigned_review_account_id),inspector.userId);
    await passCopyQaItem(pool,recheck.public_id,{requestId:randomUUID(),
      expectedCopyRevisionId:Number(recheck.copy_revision_id)},inspector);
    task=(await pool.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];
    assert.equal(task.state,'IMAGE_QUEUED');
    assert.equal(Number(task.copy_qc_released_revision_id),Number(editedRevision.id));

    const sourceSvg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1086" height="1448">
      <rect width="1086" height="1448" fill="#f7f3ea"/>
      <text x="543" y="330" text-anchor="middle" font-family="Microsoft YaHei,sans-serif"
        font-size="96" font-weight="700" fill="#111827">低成本也能保持</text>
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
      [{aiDisclosureEnabled:true,aiDisclosureText:'AI生成'}]);

    const service=createImageEditingService({pool,storageRoot});
    const edit=await service.create(taskId,{requestId:randomUUID(),sourceImageRunId:sourceRunId,
      sourceAssetId:Number(sourceAsset.id),copyRevisionId:Number(editedRevision.id),sha256:sourceAsset.sha256,
      targetPage:1,operation:'TEXT',instruction:'使用清晰的现代无衬线字体，作为合规标识自然融入画面',
      preserve:'保留标题“低成本也能保持”和全部构图元素',negative:'不要增加任何其他文字',
      confirmation:'LIVE_IMAGE_COST_ACCEPTED',overlay:{text:'AI生成',textType:'AI_DISCLOSURE',
        disclosureType:'AI_GENERATED',position:'bottom-right',size:52,margin:64,
        color:'#ffffff',background:'#111827',opacity:1}},admin);
    const settings=(await pool.query("SELECT value FROM global_settings WHERE key='production'")).rows[0].value;
    const liveClient=createAgentClient({modelApi:settings.modelApi});
    let imageGenerationCalls=0,visionValidationCalls=0;
    const measuredClient={provider:liveClient.provider,
      runImageEdit:async input=>{
        if(replayPath){await writeFile(input.outputPath,await readFile(replayPath));return{model:'gpt-image-2-replay'};}
        imageGenerationCalls++;return liveClient.runImageEdit(input);
      },
      runVision:async input=>{visionValidationCalls++;return liveClient.runVision(input);}};
    const rendered=await processImageEdit({service,storageRoot,workerId:'live-paid-worker',
      agentClient:measuredClient,maxGenerationAttempts:1});
    if(rendered.status!=='PREVIEW_READY') {
      const failedEdit=await service.get(edit.id);
      t.diagnostic(JSON.stringify({rendered,validation:failedEdit.validation,imageGenerationCalls,visionValidationCalls}));
    }
    assert.equal(rendered.status,'PREVIEW_READY',rendered.error);
    const completed=await service.get(edit.id);
    assert.equal(completed.result.validation.passed,true);
    assert.equal(completed.result.validation.text.targetOccurrences,1);
    assert.equal(completed.result.validation.text.placement.passed,true);
    assert.equal(completed.result.validation.generationAttempts,1);
    assert.match(String(completed.result.validation.model),/gpt-image-2/u);
    const resultAsset=await service.asset(Number(completed.result.asset_id),taskId);
    const resultBytes=await service.readAsset(resultAsset);
    assert.notEqual(resultAsset.sha256,sourceAsset.sha256);
    await service.action(edit.id,'accept',{version:completed.version,requestId:randomUUID(),reason:'真实测试校验通过并采用'},admin);
    task=(await pool.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];
    assert.equal(task.state,'MANUAL_ARCHIVE');
    assert.equal(task.current_image_run_id,completed.result.image_run_id);

    const outputDir=resolve(process.cwd(),'output','live-e2e',String(taskId),'attempt-1');
    await mkdir(outputDir,{recursive:true});
    await Promise.all([
      writeFile(resolve(outputDir,'source.png'),sourceBytes,{flag:'wx'}),
      writeFile(resolve(outputDir,'edited.png'),resultBytes,{flag:'wx'}),
      writeFile(resolve(outputDir,'report.json'),JSON.stringify({taskId,priorityMode:task.priority_mode,
        sampling:{rateBps:freeze.rate_bps,population:freeze.population_count,sample:freeze.sample_count,
          batchReturned:true,mandatoryRecheckPassed:true},imageEdit:{editId:edit.id,model:completed.result.validation.model,
          generationAttempts:completed.result.validation.generationAttempts,imageGenerationCalls,visionValidationCalls,replay:Boolean(replayPath),
          ocrEngine:completed.result.validation.text.engine,
          recognizedText:completed.result.validation.text.recognizedText,targetOccurrences:completed.result.validation.text.targetOccurrences,
          placementPassed:completed.result.validation.text.placement.passed,accepted:true},published:false},null,2),{flag:'wx'}),
    ]);
    t.diagnostic(JSON.stringify({outputDir,taskId,model:completed.result.validation.model,
      generationAttempts:completed.result.validation.generationAttempts,imageGenerationCalls,visionValidationCalls,replay:Boolean(replayPath),
      recognizedText:completed.result.validation.text.recognizedText,published:false}));
  } finally {
    await repository?.close();
    await rm(storageRoot,{recursive:true,force:true});
    await administrator.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await administrator.end();
  }
});
