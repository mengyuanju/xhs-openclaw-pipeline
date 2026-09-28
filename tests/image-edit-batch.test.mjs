import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImageEditingService, normalizeEditBatch } from '../server/src/image-editing.mjs';

const actor={role:'USER',username:'operator',userId:7,credentialVersion:1};
const sha='a'.repeat(64);
const overlay={text:'AI生成'};
function request(runId,batchId,page,count) {
  return {requestId:randomUUID(),batchId,batchSize:count,sourceImageRunId:runId,
    sourceAssetId:100+page,copyRevisionId:11,sha256:sha,targetPage:page,
    operation:'SVG_DISCLOSURE',instruction:'添加人工生成标识',overlay};
}
function fakePool(runId) {
  const rows=[],events=[];
  const task={id:5,state:'MANUAL_ARCHIVE',current_execution_id:null,mandatory_copy_qc:false,
    current_copy_revision_id:11,current_image_run_id:runId};
  const imageRun={id:runId,status:'COMPLETED',copy_revision_id:11,
    result:{images:[1,2,3,4,5].map(page=>({assetId:100+page,deliveryAssetId:100+page}))}};
  const runs=new Map([[runId,imageRun]]),results=new Map(),assets=new Map();
  let snapshot=null,commits=0,rollbacks=0;
  const client={
    async query(sql,values=[]) {
      if(sql==='BEGIN'){
        snapshot={rows:structuredClone(rows),events:structuredClone(events),task:structuredClone(task),
          runs:structuredClone([...runs]),results:structuredClone([...results])};return{rows:[]};
      }
      if(sql==='COMMIT'){snapshot=null;commits++;return{rows:[]};}
      if(sql==='ROLLBACK'){
        rows.splice(0,rows.length,...snapshot.rows);events.splice(0,events.length,...snapshot.events);
        Object.assign(task,snapshot.task);
        runs.clear();for(const [key,value] of snapshot.runs)runs.set(key,value);
        results.clear();for(const [key,value] of snapshot.results)results.set(key,value);
        snapshot=null;rollbacks++;return{rows:[]};
      }
      if(sql.includes('SELECT u.id FROM app_users'))return{rows:[{id:actor.userId}]};
      if(sql==='SELECT id FROM tasks WHERE id=$1 FOR UPDATE')return{rows:[{id:5}]};
      if(sql==='SELECT current_image_run_id FROM tasks WHERE id=$1')return{rows:[{current_image_run_id:task.current_image_run_id}]};
      if(sql.startsWith('SELECT request_id,target_page FROM image_edit_requests'))return{rows:rows
        .filter(row=>row.config.batchId===values[1]).map(({request_id,target_page})=>({request_id,target_page}))};
      if(sql.includes('FROM image_edit_requests e WHERE e.task_id=$1 AND e.request_id=$2')){
        return{rows:rows.filter(row=>row.request_id===values[1]).map(row=>({...row,created_by_account_id:actor.userId}))};
      }
      if(sql.includes('FROM image_edit_requests e WHERE e.id=$1 FOR UPDATE OF e'))return{rows:rows
        .filter(row=>row.id===values[0]).map(row=>({...row,created_by_account_id:actor.userId}))};
      if(sql==='SELECT * FROM image_edit_requests WHERE id=$1 FOR UPDATE')return{rows:rows.filter(row=>row.id===values[0])};
      if(sql.startsWith("SELECT value FROM global_settings"))return{rows:[{value:{}}]};
      if(sql==='SELECT * FROM tasks WHERE id=$1 FOR UPDATE')return{rows:[task]};
      if(sql.startsWith('SELECT * FROM copy_revisions'))return{rows:[{id:11,approved_at:'2026-01-01'}]};
      if(sql.startsWith('SELECT * FROM image_runs WHERE id=$1 AND task_id=$2')){
        return{rows:runs.has(values[0])?[runs.get(values[0])]:[]};
      }
      if(sql.startsWith('SELECT * FROM assets WHERE id=$1 AND task_id=$2')){
        return{rows:[assets.get(Number(values[0]))??{id:values[0],task_id:5,sha256:sha}]};
      }
      if(sql.startsWith('SELECT request_id,validation FROM image_edit_results')){
        return{rows:values[0].map(id=>results.get(id)).filter(Boolean)};
      }
      if(sql==='SELECT * FROM image_edit_results WHERE request_id=$1'){
        return{rows:results.has(values[0])?[results.get(values[0])]:[]};
      }
      if(sql.startsWith('INSERT INTO image_edit_requests(')){
        const row={id:values[0],task_id:values[1],request_id:values[2],source_image_run_id:values[3],
          source_asset_id:values[4],copy_revision_id:values[5],source_sha256:values[6],
          target_page:values[7],operation:values[8],config:values[9],status:values[10],created_by:values[11],version:1};
        rows.push(row);return{rows:[row]};
      }
      if(sql.startsWith('INSERT INTO image_edit_events(')){
        events.push({task_id:values[0],edit_id:values[1],action:values[2],actor:values[3],
          reason:values[4],request_id:values[5],detail:values[6]});
        return{rows:[]};
      }
      if(sql.startsWith('SELECT * FROM image_edit_events WHERE task_id=$1 AND request_id=$2')){
        return{rows:events.filter(event=>event.request_id===values[1])};
      }
      if(sql.includes("config->>'batchId'=$2 ORDER BY target_page,id FOR UPDATE")){
        return{rows:rows.filter(row=>row.config.batchId===values[1]).sort((a,b)=>a.target_page-b.target_page)};
      }
      if(sql.trimStart().startsWith('UPDATE delivery_entries'))return{rows:[]};
      if(sql.startsWith('INSERT INTO image_runs(')){
        runs.set(values[0],{id:values[0],status:'COMPLETED',copy_revision_id:values[2],result:values[3]});
        return{rows:[]};
      }
      if(sql.startsWith('INSERT INTO image_run_asset_members('))return{rows:[{asset_id:values[1]}],rowCount:1};
      if(sql.startsWith('UPDATE image_edit_results SET adopted=true,image_run_id=$2')){
        Object.assign(results.get(values[0]),{adopted:true,image_run_id:values[1]});return{rows:[]};
      }
      if(sql.startsWith('UPDATE tasks SET')){
        task.current_image_run_id=values[1];task.state='MANUAL_ARCHIVE';return{rows:[]};
      }
      if(sql.startsWith('UPDATE image_edit_requests SET status=$2')){
        const row=rows.find(item=>item.id===values[0]);
        Object.assign(row,{status:values[1],config:values[2],version:row.version+1});
        return{rows:[row]};
      }
      throw new Error(`Unexpected fake query: ${sql}`);
    },
    release() {},
  };
  return {pool:{connect:async()=>client},rows,events,task,runs,results,assets,
    get commits(){return commits;},get rollbacks(){return rollbacks;}};
}

test('batch input accepts selected pages and rejects duplicate or mismatched submissions',()=>{
  const runId=randomUUID(),batchId=randomUUID();
  const edits=[request(runId,batchId,2,2),request(runId,batchId,4,2)];
  assert.deepEqual(normalizeEditBatch({edits}).map(item=>item.targetPage),[2,4]);
  assert.throws(()=>normalizeEditBatch({edits:[edits[0],{...edits[1],targetPage:2}]}),/重复提交同一张/u);
  assert.throws(()=>normalizeEditBatch({edits:[edits[0],{...edits[1],requestId:edits[0].requestId}]}),/请求编号/u);
  assert.throws(()=>normalizeEditBatch({edits:[edits[0],{...edits[1],batchSize:3}]}),/批次编号/u);
  assert.throws(()=>normalizeEditBatch({edits:[edits[0],{...edits[1],sourceImageRunId:randomUUID()}]}),/图片版本/u);
  assert.throws(()=>normalizeEditBatch({edits:[edits[0],{...edits[1],overlay:{text:'人工生成'}}]}),/文字、说明/u);
  assert.throws(()=>normalizeEditBatch({edits:[edits[0],{...edits[1],instruction:'不同说明'}]}),/文字、说明/u);
  assert.throws(()=>normalizeEditBatch({edits:[]}),/1 至 5/u);
  assert.throws(()=>normalizeEditBatch({edits,unexpected:true}),/1 至 5/u);
  assert.equal(normalizeEditBatch({edits:[{...edits[0],batchId:undefined,batchSize:undefined}]}).length,1);
});

test('reviewers cannot submit or adopt a batch before database access',async()=>{
  const runId=randomUUID(),batchId=randomUUID();
  const service=createImageEditingService({pool:{connect(){assert.fail('must not connect');}},storageRoot:tmpdir()});
  const reviewer={role:'REVIEWER',username:'reviewer'};
  await assert.rejects(()=>service.createBatch(5,{edits:[request(runId,batchId,1,2),request(runId,batchId,2,2)]},reviewer),
    {code:'FORBIDDEN'});
  await assert.rejects(()=>service.acceptBatch(5,batchId,{requestId:randomUUID(),imageRunId:runId,
    edits:[{id:randomUUID(),version:1},{id:randomUUID(),version:1}]},reviewer),{code:'FORBIDDEN'});
});

test('batch creation commits all selected pages or rolls them all back and replays idempotently',async()=>{
  const runId=randomUUID(),batchId=randomUUID(),fake=fakePool(runId);
  const service=createImageEditingService({pool:fake.pool,storageRoot:tmpdir()});
  const edits=[request(runId,batchId,2,2),request(runId,batchId,4,2)];
  await assert.rejects(()=>service.createBatch(5,{edits:[edits[0],{...edits[1],sha256:'f'.repeat(64)}]},actor),/校验值已变化/u);
  assert.equal(fake.rows.length,0);assert.equal(fake.events.length,0);assert.equal(fake.rollbacks,1);
  const created=await service.createBatch(5,{edits},actor);
  assert.deepEqual(created.map(row=>row.target_page),[2,4]);
  assert.equal(fake.rows.length,2);assert.equal(fake.events.length,2);assert.equal(fake.commits,1);
  const retried=await service.createBatch(5,{edits},actor);
  assert.deepEqual(retried.map(row=>row.id),created.map(row=>row.id));
  assert.equal(fake.rows.length,2);assert.equal(fake.events.length,2);
  await assert.rejects(()=>service.createBatch(5,{edits:edits.map(edit=>({...edit,instruction:'不同标识内容'}))},actor),/requestId 已用于不同请求/u);
  assert.equal(fake.rows.length,2);
});

test('batch acceptance refuses incomplete previews before changing the task',async()=>{
  const runId=randomUUID(),batchId=randomUUID(),fake=fakePool(runId);
  const service=createImageEditingService({pool:fake.pool,storageRoot:tmpdir()});
  const created=await service.createBatch(5,{edits:[request(runId,batchId,1,2),request(runId,batchId,3,2)]},actor);
  const input={requestId:randomUUID(),imageRunId:runId,
    edits:created.map(row=>({id:row.id,version:row.version})),reason:'预览符合要求'};
  await assert.rejects(()=>service.acceptBatch(5,batchId,input,actor),/尚未全部就绪/u);
  assert.equal(fake.rows.length,2);assert.equal(fake.rows.every(row=>row.status==='QUEUED'),true);
  assert.equal(fake.task.current_image_run_id,runId);
  await assert.rejects(()=>service.acceptBatch(5,batchId,{...input,edits:[input.edits[0],input.edits[0]]},actor),/重复提交/u);
  await assert.rejects(()=>service.acceptBatch(5,batchId,{...input,imageRunId:randomUUID()},actor),/图片版本已变化/u);
});

test('batch acceptance rolls back every page when a later preview is corrupt, then merges both pages',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'image-edit-batch-'));
  try {
    const runId=randomUUID(),batchId=randomUUID(),fake=fakePool(runId);
    const service=createImageEditingService({pool:fake.pool,storageRoot:directory});
    const created=await service.createBatch(5,{edits:[request(runId,batchId,1,2),request(runId,batchId,3,2)]},actor);
    const firstPreviewRunId=randomUUID();
    const firstBytes=Buffer.from('first preview'),secondBytes=Buffer.from('second preview');
    const firstPath=join(directory,'first.png'),secondPath=join(directory,'second.png');
    await writeFile(firstPath,firstBytes);await writeFile(secondPath,Buffer.from('corrupt preview'));
    const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
    for(const [index,row] of created.entries()) {
      const assetId=index===0?201:203;
      const bytes=index===0?firstBytes:secondBytes;
      fake.assets.set(assetId,{id:assetId,task_id:5,sha256:digest(bytes),
        storage_path:index===0?firstPath:secondPath,asset_role:'DELIVERY'});
      fake.results.set(row.id,{request_id:row.id,asset_id:assetId,
        image_run_id:index===0?firstPreviewRunId:randomUUID(),adopted:false,
        validation:{passed:true,integrity:{sha256:digest(bytes)},requiredText:[],disclosure:{added:null}}});
      Object.assign(fake.rows.find(item=>item.id===row.id),{status:'PREVIEW_READY',version:2});
    }
    const previewImages=structuredClone(fake.runs.get(runId).result.images);
    Object.assign(previewImages[0],{assetId:201,deliveryAssetId:201,sourceAssetId:201});
    fake.runs.set(firstPreviewRunId,{id:firstPreviewRunId,status:'COMPLETED',copy_revision_id:11,
      result:{images:previewImages}});
    const input={requestId:randomUUID(),imageRunId:runId,
      edits:fake.rows.map(row=>({id:row.id,version:row.version})),reason:'标识预览符合要求'};
    await assert.rejects(()=>service.acceptBatch(5,batchId,input,actor),/完整性校验失败/u);
    assert.equal(fake.task.current_image_run_id,runId);
    assert.equal(fake.rows.every(row=>row.status==='PREVIEW_READY'),true);
    assert.equal([...fake.results.values()].every(result=>result.adopted===false),true);
    assert.equal(fake.events.some(event=>event.action==='BATCH_ACCEPT'),false);
    await writeFile(secondPath,secondBytes);
    const accepted=await service.acceptBatch(5,batchId,input,actor);
    assert.equal(accepted.processed,2);
    assert.equal(fake.task.current_image_run_id,accepted.imageRunId);
    assert.deepEqual(fake.runs.get(accepted.imageRunId).result.images.map(image=>image.deliveryAssetId),
      [201,102,203,104,105]);
    assert.equal(fake.rows.every(row=>row.status==='ACCEPTED'),true);
    assert.equal([...fake.results.values()].every(result=>result.adopted===true),true);
    assert.deepEqual(await service.acceptBatch(5,batchId,input,actor),accepted);
    assert.equal(fake.events.filter(event=>event.action==='BATCH_ACCEPT').length,1);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
