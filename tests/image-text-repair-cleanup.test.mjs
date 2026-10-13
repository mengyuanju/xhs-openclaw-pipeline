import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isObsoleteTextRepairAsset, scheduleObsoleteTextRepairCleanup, drainReferenceCleanup,
  backfillEligibleReferenceCleanup } from '../server/src/image-reference-cleanup.mjs';
import { resetTextRepairReference } from '../server/src/image-text-repair-state.mjs';

function fixture() {
  const edit={id:randomUUID(),task_id:1,operation:'AI_TEXT_REPAIR',text_repair_state:{
    references:[{text:'滩',assetId:2,status:'READY'}],locations:[{id:'first',assetId:3,status:'COMPLETED'}]}};
  const asset=(id,role='TEXT_REFERENCE')=>({id,task_id:1,asset_role:role,edit_metadata:{editId:edit.id},
    sha256:'a'.repeat(64),storage_path:`unused-${id}`,content_cleared_at:null});
  return {edit,asset};
}
test('current glyph references and patches survive retries and terminal history, while dropped bindings can be cleaned',()=>{
  const {edit,asset}=fixture();
  for(const status of ['DRAFT','QUEUED','RUNNING','FAILED','PREVIEW_READY','ACCEPTED','CANCELLED','REJECTED']) {
    assert.equal(isObsoleteTextRepairAsset(asset(2),{...edit,status}),false,status);
    assert.equal(isObsoleteTextRepairAsset(asset(3,'TEXT_PATCH'),{...edit,status}),false,status);
  }
  assert.equal(isObsoleteTextRepairAsset(asset(4),edit),true);
  assert.equal(isObsoleteTextRepairAsset(asset(2),edit,{workspaceDeleted:true}),true);
  for(const role of ['DELIVERY','MASK','REFERENCE','REJECTED_PREVIEW']) {
    assert.equal(isObsoleteTextRepairAsset(asset(4,role),edit,{workspaceDeleted:true}),false);
  }
  assert.equal(isObsoleteTextRepairAsset({...asset(4),task_id:2},edit,{workspaceDeleted:true}),false);
  assert.equal(isObsoleteTextRepairAsset({...asset(4),edit_metadata:{editId:randomUUID()}},edit),false);
  assert.equal(isObsoleteTextRepairAsset({...asset(4),content_cleared_at:'already-cleared'},edit),false);
});
test('durable orphan scheduling rechecks role, task, edit and current bindings before tombstoning',async()=>{
  const {edit,asset}=fixture();
  const row=value=>({...value,repair_edit_id:edit.id,repair_task_id:edit.task_id,repair_operation:edit.operation,
    text_repair_state:edit.text_repair_state,workspace_deleted:false});
  const candidates=[row(asset(2)),row(asset(3,'TEXT_PATCH')),row(asset(4)),row(asset(5,'DELIVERY')),
    row({...asset(6),task_id:2}),row({...asset(7),edit_metadata:{editId:randomUUID()}})];
  const inserted=[],cleared=[];
  const client={query:async(sql,values=[])=>{
    if(sql.startsWith('SELECT id FROM tasks'))return {rows:[{id:1}]};
    if(sql.includes('SELECT a.*, e.id AS repair_edit_id'))return {rows:candidates};
    if(sql.includes('INSERT INTO image_reference_cleanup_jobs')) {inserted.push(values[0]);return {rows:[]};}
    if(sql.includes('UPDATE assets SET content_cleared_at')) {cleared.push(values[0]);return {rows:[],rowCount:1};}
    throw new Error('Unexpected fake cleanup query');
  }};
  assert.equal(await scheduleObsoleteTextRepairCleanup(client,1,edit.id),1);
  assert.deepEqual(inserted,[4]);assert.deepEqual(cleared,[4]);
});
test('regeneration keeps the previous reference bound until its replacement checkpoint and releases invalidated patches',async()=>{
  const {edit,asset}=fixture();
  edit.text_repair_state.references[0]={...edit.text_repair_state.references[0],status:'FAILED',
    validation:{passed:false,reason:'字形缺少笔画'}};
  edit.text_repair_state.locations[0].correctText='滩';
  edit.text_repair_state=resetTextRepairReference(edit.text_repair_state,'滩');
  const currentAssets=[asset(2),asset(3,'TEXT_PATCH')],scheduled=[],cleared=[];
  const client={query:async(sql,values=[])=>{
    if(sql.startsWith('SELECT id FROM tasks'))return {rows:[{id:1}]};
    if(sql.includes('SELECT a.*, e.id AS repair_edit_id'))return {rows:currentAssets.map(value=>({...value,
      repair_edit_id:edit.id,repair_task_id:edit.task_id,repair_operation:edit.operation,
      text_repair_state:edit.text_repair_state,workspace_deleted:false}))};
    if(sql.includes('INSERT INTO image_reference_cleanup_jobs')) {scheduled.push(values[0]);return {rows:[]};}
    if(sql.includes('UPDATE assets SET content_cleared_at')) {
      cleared.push(values[0]);currentAssets.find(value=>value.id===values[0]).content_cleared_at='committed';return {rows:[],rowCount:1};
    }
    throw new Error('Unexpected fake regeneration cleanup query');
  }};
  assert.equal(await scheduleObsoleteTextRepairCleanup(client,1,edit.id),1);
  assert.deepEqual(scheduled,[3]);assert.equal(currentAssets[0].content_cleared_at,null);
  assert.equal(edit.text_repair_state.references[0].assetId,2);
  currentAssets.push(asset(4));
  edit.text_repair_state={...edit.text_repair_state,references:[{text:'滩',status:'READY',assetId:4,validation:{passed:true}}]};
  assert.equal(await scheduleObsoleteTextRepairCleanup(client,1,edit.id),1);
  assert.deepEqual(scheduled,[3,2]);assert.deepEqual(cleared,[3,2]);
  assert.equal(currentAssets[2].content_cleared_at,null);
});
test('the file drainer refuses a delivery-role queue entry and only unlinks committed generated tombstones',async()=>{
  const storageRoot=await mkdtemp(join(tmpdir(),'text-repair-cleanup-'));
  const directory=join(storageRoot,'image-edits','1');await mkdir(directory,{recursive:true});
  const path=join(directory,`${randomUUID()}.png`);await writeFile(path,'fake generated bytes');
  let job={asset_id:2,task_id:1,storage_path:path,sha256:'a'.repeat(64)},attempts=0;
  let asset={task_id:1,asset_role:'DELIVERY',storage_path:path,sha256:job.sha256,content_cleared_at:'committed'};
  const query=async(sql)=>{
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)||sql.startsWith('SELECT id FROM tasks'))return {rows:[]};
    if(sql.includes('SELECT asset_id,task_id FROM image_reference_cleanup_jobs'))return {rows:job?[{asset_id:job.asset_id,task_id:job.task_id}]:[]};
    if(sql.includes('SELECT * FROM image_reference_cleanup_jobs'))return {rows:job?[job]:[]};
    if(sql.includes('FROM assets WHERE id=$1 FOR UPDATE'))return {rows:[asset]};
    if(sql.includes('UPDATE image_reference_cleanup_jobs SET attempts')) {attempts++;return {rows:[]};}
    if(sql.startsWith('DELETE FROM image_reference_cleanup_jobs')) {job=null;return {rows:[]};}
    throw new Error('Unexpected fake drain query');
  };
  const pool={query,connect:async()=>({query,release(){}})};
  try {
    assert.deepEqual(await drainReferenceCleanup(pool,storageRoot,{limit:1}),{processed:0,failed:1});
    assert.equal(attempts,1);assert.equal(await readFile(path,'utf8'),'fake generated bytes');
    asset={...asset,asset_role:'TEXT_PATCH',content_cleared_at:null};
    assert.deepEqual(await drainReferenceCleanup(pool,storageRoot,{limit:1}),{processed:0,failed:1});
    assert.equal(await readFile(path,'utf8'),'fake generated bytes');
    asset={...asset,content_cleared_at:'committed'};
    assert.deepEqual(await drainReferenceCleanup(pool,storageRoot,{limit:1}),{processed:1,failed:0});
    await assert.rejects(readFile(path),{code:'ENOENT'});assert.equal(job,null);
  } finally {await rm(storageRoot,{recursive:true,force:true});}
});
test('background backfill finds text artifacts after a missed regeneration cleanup without removing current history',async()=>{
  const {edit,asset}=fixture();
  const row=value=>({...value,repair_edit_id:edit.id,repair_task_id:edit.task_id,repair_operation:edit.operation,
    text_repair_state:edit.text_repair_state,workspace_deleted:false});
  const scheduled=[];
  const query=async(sql,values=[])=>{
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)||sql.startsWith('SELECT id FROM tasks'))return {rows:[]};
    if(sql.includes("WHERE a.asset_role='REFERENCE'"))return {rows:[]};
    if(sql.includes('SELECT DISTINCT a.task_id FROM assets a JOIN image_edit_requests e'))return {rows:[{task_id:1}]};
    if(sql.includes('SELECT a.*, e.id AS repair_edit_id'))return {rows:[row(asset(2)),row(asset(4))]};
    if(sql.includes('INSERT INTO image_reference_cleanup_jobs')) {scheduled.push(values[0]);return {rows:[]};}
    if(sql.includes('UPDATE assets SET content_cleared_at'))return {rows:[],rowCount:1};
    throw new Error('Unexpected fake backfill query');
  };
  const pool={query,connect:async()=>({query,release(){}})};
  assert.deepEqual(await backfillEligibleReferenceCleanup(pool,{limitTasks:10}),{tasks:1,scheduled:1});
  assert.deepEqual(scheduled,[4]);
});
