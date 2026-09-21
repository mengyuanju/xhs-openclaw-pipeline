import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { deliveryDateBoundary,normalizeDeliveryFilters,listDeliveryItems,confirmDeliveryItems } from '../src/delivery-ledger.mjs';
import { createDeliveryArchiveService } from '../src/delivery-archives.mjs';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { applyMigrations,loadMigrations } from '../src/database-migrations.mjs';
import { inDeliveryTransaction } from '../src/delivery-ledger.mjs';

test('delivery dates use exclusive Shanghai midnight boundaries and reject impossible dates',()=>{
  assert.equal(deliveryDateBoundary('2026-09-18'),'2026-09-17T16:00:00.000Z');
  assert.equal(deliveryDateBoundary('2026-09-18',true),'2026-09-18T16:00:00.000Z');
  assert.throws(()=>deliveryDateBoundary('2026-02-30'));
  assert.throws(()=>normalizeDeliveryFilters({from:'2026-09-19',to:'2026-09-18'}));
  assert.throws(()=>normalizeDeliveryFilters({dateField:'created_at; DROP TABLE tasks'}));
});

test('shared delivery PostgreSQL: cross-role visibility, partial confirmation, original-byte subsets and archives',{
  skip:process.env.RUN_SHARED_DELIVERY_POSTGRES!=='1',timeout:180_000,
},async()=>{
  const database=await startTemporaryPostgres18();
  const repository=new PostgresControlPlaneRepository({connectionString:database.connectionString});
  const root=await mkdtemp(join(tmpdir(),'xhs-shared-delivery-'));
  let service,app,server;
  try {
    await repository.initialize();const pool=repository.pool;
    const users=(await pool.query(`INSERT INTO app_users(username,display_name,role,password_hash,status,created_at,must_change_password)
      VALUES ('delivery-admin','Admin','ADMIN','fake','ACTIVE',now()-interval '5 days',false),
        ('delivery-a','A','USER','fake','ACTIVE',now()-interval '5 days',false),
        ('delivery-b','B','USER','fake','ACTIVE',now()-interval '5 days',false) RETURNING id,username,role`)).rows;
    const [admin,a,b]=users.map(row=>({userId:Number(row.id),username:row.username,role:row.role}));
    await pool.query("INSERT INTO executor_nodes(id,name) VALUES ('delivery-test','Test')");
    async function task(actor,label) {
      const taskId=Number((await pool.query(`INSERT INTO tasks(query,input,state,created_by_node_id,copy_executor_node_id,
        created_by_user_id,assigned_to_user_id,assignment_source,assigned_at)
        VALUES ($1,'{}','IMAGE_RUNNING','delivery-test','delivery-test',$2,$2,'MANUAL',now()-interval '1 day') RETURNING id`,[label,actor.username])).rows[0].id);
      const revisionId=Number((await pool.query(`INSERT INTO copy_revisions(task_id,revision,content) VALUES ($1,1,'{}') RETURNING id`,[taskId])).rows[0].id);
      const execution=randomUUID(),run=randomUUID();
      await pool.query(`INSERT INTO task_executions(id,task_id,kind,node_id,status,stage,snapshot) VALUES ($1,$2,'IMAGE','delivery-test','SUCCEEDED','DONE','{}')`,[execution,taskId]);
      await pool.query(`INSERT INTO image_runs(id,task_id,execution_id,copy_revision_id,status,result,image_production_chain_id) VALUES ($1,$2,$3,$4,'COMPLETED','{}',$1)`,[run,taskId,execution,revisionId]);
      await pool.query(`UPDATE tasks SET current_copy_revision_id=$2,current_image_run_id=$3,state='REVIEWED' WHERE id=$1`,[taskId,revisionId,run]);
      await pool.query('UPDATE tasks SET image_qc_legacy_accepted=true WHERE id=$1',[taskId]);
      await pool.query(`INSERT INTO delivery_entries(task_id,copy_revision_id,image_run_id,status,approved_by_username)
        VALUES ($1,$2,$3,'READY','reviewer')`,[taskId,revisionId,run]);
      return {taskId,copyRevisionId:revisionId,imageRunId:run};
    }
    const tasks=[await task(a,'甲内容'),await task(a,'甲第二条'),await task(b,'乙内容')];
    const original=new JSZip(),bytesByTask=new Map();
    for(const item of tasks){const zip=new JSZip();zip.file('文案.txt',`frozen-${item.taskId}`);zip.file('image.png',Buffer.from([1,2,3,item.taskId]));
      const bytes=await zip.generateAsync({type:'nodebuffer'});bytesByTask.set(item.taskId,bytes);original.file(`未归属甲方批次/任务-${item.taskId}-资源包.zip`,bytes);}
    const bytes=await original.generateAsync({type:'nodebuffer'}),publicId=randomUUID();
    await mkdir(join(root,'.delivery-batches'));
    await writeFile(join(root,'.delivery-batches',`${publicId}.zip`),bytes);
    const batch=await repository.createDeliveryBatch({publicId,scope:'SELECTED',fileName:'test.zip',byteSize:bytes.length,
      sha256:createHash('sha256').update(bytes).digest('hex'),bindings:tasks},{actor:admin});
    let page=await listDeliveryItems(pool,{},a);
    assert.equal(page.total,2);assert.equal(page.items[0].packedBy,admin.username);assert.equal(page.summary.packed,2);
    const history=await listDeliveryItems(pool,{view:'HISTORY'},a);assert.equal(history.total,2,'admin-created members are visible to their owner');
    const adminPage=await listDeliveryItems(pool,{view:'HISTORY'},admin);assert.equal(adminPage.total,3);
    const itemA=history.items.find(item=>item.taskId===tasks[0].taskId),itemB=adminPage.items.find(item=>item.taskId===tasks[2].taskId);
    await assert.rejects(confirmDeliveryItems(pool,{itemIds:[itemA.itemId]},a),{code:'DELIVERY_BATCH_NOT_DOWNLOADED'});
    await assert.rejects(confirmDeliveryItems(pool,{itemIds:[itemB.itemId]},a),{code:'FORBIDDEN'});
    service=createDeliveryArchiveService({pool,storageRoot:root});
    await assert.rejects(service.preview({kind:'ARCHIVE',itemIds:[itemA.itemId]},a),{code:'FORBIDDEN'});
    await assert.rejects(service.preview({kind:'DOWNLOAD',itemIds:[itemA.itemId,itemB.itemId]},a),{code:'FORBIDDEN'});
    const preview=await service.preview({kind:'DOWNLOAD',itemIds:[itemA.itemId]},a);
    const requestId=randomUUID(),created=await service.create({token:preview.token,requestId},a);
    assert.equal((await service.create({token:preview.token,requestId},a)).id,created.id,'network retry returns the same job');
    async function finished(id,actor){
      for(let attempt=0;attempt<100;attempt++){
        const job=await service.get(id,actor);if(job.status==='FAILED')throw new Error(job.error);
        if(job.status==='SUCCEEDED')return job;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      throw new Error('archive did not finish');
    }
    await finished(created.id,a);
    const artifact=await service.download(created.id,1,a),downloaded=await JSZip.loadAsync(await readFile(artifact.path));
    async function assertFrozenFiles(zip) {
      assert.equal(Object.keys(zip.files).some(name=>name.endsWith('.zip')),false);
      const original=await JSZip.loadAsync(bytesByTask.get(tasks[0].taskId));
      const directory=`${tasks[0].taskId}/${tasks[0].copyRevisionId}/${tasks[0].imageRunId}`;
      for(const file of Object.values(original.files)) {
        assert.deepEqual(await zip.file(`${directory}/${file.name}`).async('nodebuffer'),await file.async('nodebuffer'));
      }
    }
    await assertFrozenFiles(downloaded);
    assert.equal(Object.keys(downloaded.files).some(name=>name.startsWith(`${tasks[2].taskId}/`)),false,'another operator is never included');
    await artifact.record();
    const confirmations=await Promise.all([confirmDeliveryItems(pool,{itemIds:[itemA.itemId]},a),confirmDeliveryItems(pool,{itemIds:[itemA.itemId]},a)]);
    assert.equal(confirmations.reduce((sum,value)=>sum+value.confirmed,0),1);
    assert.equal((await pool.query("SELECT account_id FROM operator_performance_events WHERE event_key=$1",[`delivered:${batch.id}:${itemA.itemId}`])).rows[0].account_id,String(a.userId));
    assert.equal((await pool.query('SELECT status FROM delivery_batches WHERE id=$1',[batch.id])).rows[0].status,'GENERATED','partial delivery is not whole-batch confirmation');
    page=await listDeliveryItems(pool,{state:'DELIVERED'},admin);assert.equal(page.total,1);assert.equal(page.items[0].deliveredBy,a.username);
    const originalDate=page.items[0].deliveredAt;
    assert.equal(page.items[0].batchDeliveredCount,1);assert.equal(page.items[0].batchVisibleCount,3);
    assert.equal((await listDeliveryItems(pool,{state:'DELIVERED'},a)).items[0].batchVisibleCount,2,'user counts do not reveal other members');
    const date=new Date(Date.parse(originalDate)+8*3600_000).toISOString().slice(0,10);
    assert.equal((await listDeliveryItems(pool,{state:'DELIVERED',dateField:'DELIVERED',from:date,to:date},a)).total,1);
    assert.equal((await listDeliveryItems(pool,{state:'PENDING'},a)).total,1);
    const archivePreview=await service.preview({kind:'ARCHIVE',filters:{view:'HISTORY',dateField:'DELIVERED',from:date,to:date,archiveState:'NO'}},admin);
    assert.equal(archivePreview.itemCount,1);
    const archive=await service.create({token:archivePreview.token,requestId:randomUUID()},admin);await finished(archive.id,admin);
    page=await listDeliveryItems(pool,{state:'DELIVERED',archiveState:'YES'},admin);
    assert.equal(page.total,1);assert.equal(page.items[0].deliveredAt,originalDate,'saving does not modify delivery time');
    assert.equal((await pool.query('SELECT count(*)::integer AS total FROM delivery_item_confirmations')).rows[0].total,1);
    await assert.rejects(service.download(archive.id,1,b),{code:'NOT_FOUND'});
    await assert.rejects(service.download(archive.id,1,{...admin,role:'USER'}),{code:'NOT_FOUND'},'demoted admin cannot download an administrator aggregate');
    app=createControlPlaneApp({repository,storageRoot:root,logger:{info(){},error(){}}});
    await new Promise(resolve=>{server=app.listen(0,'127.0.0.1',resolve);});
    const base=`http://127.0.0.1:${server.address().port}`;
    const headers=actor=>({'X-Actor-Username':actor.username,'X-Actor-User-Id':String(actor.userId),'X-Actor-Role':actor.role,'X-Actor-Credential-Version':'1','Content-Type':'application/json'});
    const read=await fetch(`${base}/v1/delivery-items?view=HISTORY`,{headers:headers(a)});
    assert.equal(read.status,200);assert.match(read.headers.get('cache-control'),/no-store/);assert.equal((await read.json()).data.total,2);
    const denied=await fetch(`${base}/v1/delivery-items/confirm`,{method:'POST',headers:headers(a),body:JSON.stringify({itemIds:[itemB.itemId]})});
    assert.equal(denied.status,403);
    const forbiddenArchive=await fetch(`${base}/v1/delivery-archives/preview`,{method:'POST',headers:headers(a),body:JSON.stringify({kind:'ARCHIVE',itemIds:[itemA.itemId]})});
    assert.equal(forbiddenArchive.status,403);
    const before=Number((await pool.query('SELECT count(*) FROM delivery_archive_download_events')).rows[0].count);
    const head=await fetch(`${base}/v1/delivery-archives/${created.id}/download/1`,{method:'HEAD',headers:headers(a)});
    assert.equal(head.status,200);
    assert.equal(Number((await pool.query('SELECT count(*) FROM delivery_archive_download_events')).rows[0].count),before,'HEAD is not a download');
    const blocked=await fetch(`${base}/v1/delivery-archives/${archive.id}/download/1`,{headers:headers(b)});assert.equal(blocked.status,404);
    const third=await listDeliveryItems(pool,{view:'HISTORY'},b);assert.equal(third.total,1);
    await repository.recordDeliveryBatchDownload(publicId,{actor:admin});
    await pool.query("UPDATE tasks SET state='IMAGE_REWORK_PENDING' WHERE id=$1",[tasks[2].taskId]);
    await assert.rejects(repository.confirmDeliveryBatch(publicId,{actor:admin}),{code:'DELIVERY_VERSION_CHANGED'},'legacy endpoint cannot confirm withdrawn content');
    assert.equal(Number((await pool.query('SELECT count(*) FROM delivery_item_confirmations')).rows[0].count),1,'failed batch confirmation rolls back every member');
    await pool.query("UPDATE tasks SET state='REVIEWED' WHERE id=$1",[tasks[2].taskId]);
    await repository.confirmDeliveryBatch(publicId,{actor:admin});
    assert.equal((await listDeliveryItems(pool,{state:'DELIVERED'},b)).total,1,'legacy whole-batch confirmation mirrors member state');
    assert.equal((await listDeliveryItems(pool,{state:'DELIVERED'},a)).items.find(item=>item.itemId===itemA.itemId).deliveredBy,a.username,'legacy confirmation preserves earlier member actor');
    assert.equal((await pool.query('SELECT account_id FROM operator_performance_events WHERE event_key=$1',[`delivered:${batch.id}:${itemA.itemId}`])).rows[0].account_id,String(a.userId),'whole-batch completion does not reattribute the first confirmer');
    await pool.query(`UPDATE tasks SET assigned_to_user_id=$2,assigned_at=now(),assignment_source='MANUAL' WHERE id=$1`,[tasks[0].taskId,b.username]);
    assert.equal((await listDeliveryItems(pool,{view:'HISTORY'},a)).total,2,'original owner keeps the frozen history');
    assert.equal((await listDeliveryItems(pool,{},a)).total,1,'current scope follows reassignment');
    await pool.query('UPDATE tasks SET state=$2 WHERE id=$1',[tasks[0].taskId,'IMAGE_REWORK_PENDING']);
    const old=(await listDeliveryItems(pool,{view:'HISTORY'},admin)).items.find(item=>item.itemId===itemA.itemId);
    assert.equal(old.isCurrent,false);assert.equal(old.state,'DELIVERED');
    const retryPreview=await service.preview({kind:'ARCHIVE',itemIds:[itemA.itemId]},admin);
    await writeFile(join(root,'.delivery-batches',`${publicId}.zip`),'corrupted');
    await assert.rejects(service.preview({kind:'ARCHIVE',itemIds:[itemA.itemId]},admin),{code:'DELIVERY_SOURCE_MISSING'});
    const interrupted=await service.create({token:retryPreview.token,requestId:randomUUID()},admin);
    for(let attempt=0;attempt<100;attempt++){
      const state=await service.get(interrupted.id,admin);if(state.status==='FAILED')break;
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    assert.equal((await service.get(interrupted.id,admin)).status,'FAILED','failure never publishes a partial successful archive');
    await writeFile(join(root,'.delivery-batches',`${publicId}.zip`),bytes);
    await service.retry(interrupted.id,admin);await finished(interrupted.id,admin);
    const recovered=await service.download(interrupted.id,1,admin),recoveredZip=await JSZip.loadAsync(await readFile(recovered.path));
    await assertFrozenFiles(recoveredZip);
  } finally {
    if(server)await new Promise(resolve=>server.close(resolve));await app?.context.disposeControlPlaneResources();
    await service?.dispose();await repository.pool.end();await database.stop();
    assert.ok(root.startsWith(join(tmpdir(),'xhs-shared-delivery-')));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});

test('shared delivery migration backfills only explicit legacy confirmations and preserves original timestamps',{
  skip:process.env.RUN_SHARED_DELIVERY_POSTGRES!=='1',timeout:120_000,
},async()=>{
  const database=await startTemporaryPostgres18();
  const repository=new PostgresControlPlaneRepository({connectionString:database.connectionString});
  try{
    const pool=repository.pool,migrations=await loadMigrations();
    await inDeliveryTransaction(pool,client=>applyMigrations(client,migrations.filter(m=>m.id<'0073_shared_delivery')));
    const originalDate='2026-09-17T16:00:00.000Z';
    const confirmedItems=[];
    for(const [index,status] of ['GENERATED','DOWNLOADED','DELIVERED'].entries()){
      const id=Number((await pool.query(`INSERT INTO delivery_batches(public_id,code,scope,status,archive_file_name,archive_byte_size,archive_sha256,task_count,
        created_by_account_id,created_by_username,delivered_at,delivered_by_account_id,delivered_by_username)
        VALUES ($1,$2,'SELECTED',$3,'legacy.zip',1,$4,1,8,'legacy', $5,$6,$7) RETURNING id`,
      [randomUUID(),`JF-AAAAAAA${index}`,status,'a'.repeat(64),status==='DELIVERED'?originalDate:null,status==='DELIVERED'?9:null,status==='DELIVERED'?'legacy-confirmer':null])).rows[0].id);
      const item=Number((await pool.query(`INSERT INTO delivery_batch_items(delivery_batch_id,ordinal,task_id,copy_revision_id,image_run_id,query_snapshot)
        VALUES ($1,1,$2,$2,$3,'legacy') RETURNING id`,[id,100+index,randomUUID()])).rows[0].id);
      confirmedItems.push(item);
      if(status!=='GENERATED')await pool.query(`INSERT INTO delivery_batch_download_events(delivery_batch_id,actor_account_id,actor_username) VALUES ($1,8,'legacy')`,[id]);
    }
    await inDeliveryTransaction(pool,client=>applyMigrations(client,migrations));
    const rows=(await pool.query('SELECT * FROM delivery_item_confirmations')).rows;
    assert.equal(rows.length,1);assert.equal(Number(rows[0].item_id),confirmedItems[2]);
    assert.equal(rows[0].confirmed_at.toISOString(),originalDate);assert.equal(rows[0].actor_username,'legacy-confirmer');
    assert.equal(Number((await pool.query('SELECT count(*) FROM delivery_item_download_events')).rows[0].count),2);
    assert.deepEqual(await inDeliveryTransaction(pool,client=>applyMigrations(client,migrations)),[],'reapplying migration does not duplicate confirmations');
  }finally{await repository.pool.end();await database.stop();}
});
