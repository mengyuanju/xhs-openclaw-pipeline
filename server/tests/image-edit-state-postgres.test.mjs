import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';
import { migrateDatabase } from '../src/database-migrations.mjs';
import { createStandaloneImageEditor } from '../src/standalone-image-editor.mjs';
import { createImageEditingService } from '../src/image-editing.mjs';

test('compact image state covers old tracked edits, stable heartbeats and immutable creator identities in one snapshot',
  {skip:process.env.RUN_POSTGRES_E2E!=='1',timeout:90000},async()=>{
  const database=await startTemporaryPostgres18('image-state-e2e-');
  const pool=new pg.Pool({connectionString:database.connectionString});
  const root=await mkdtemp(join(tmpdir(),'image-state-assets-'));
  try {
    await migrateDatabase(pool);
    const user=(await pool.query("INSERT INTO app_users(username,display_name,role,password_hash,must_change_password) VALUES('compact-owner','test owner','USER','fake-only',false) RETURNING *")).rows[0];
    const actor={userId:Number(user.id),username:user.username,role:'USER',credentialVersion:user.credential_version};
    const png=await sharp({create:{width:1086,height:1448,channels:4,background:'white'}}).png().toBuffer();
    const standalone=createStandaloneImageEditor({pool,storageRoot:root});
    const workspace=await standalone.create({requestId:randomUUID(),title:'compact test',images:[{mediaType:'image/png',base64:png.toString('base64')}]},actor);
    const first=await standalone.createEdit(workspace.id,{requestId:randomUUID(),sourceImageRunId:workspace.runId,
      sourceAssetId:workspace.assets[0].id,copyRevisionId:workspace.copyRevisionId,sha256:workspace.assets[0].sha256,
      targetPage:1,operation:'SVG_DISCLOSURE',overlay:{text:'AI生成'}},actor);
    await pool.query(`INSERT INTO image_edit_requests(id,task_id,request_id,source_image_run_id,source_asset_id,
      copy_revision_id,source_sha256,target_page,operation,config,status,created_by,created_at)
      SELECT gen_random_uuid(),task_id,gen_random_uuid(),source_image_run_id,source_asset_id,copy_revision_id,
        source_sha256,target_page,operation,config,'QUEUED',created_by,now()+s*interval '1 millisecond'
      FROM image_edit_requests CROSS JOIN generate_series(1,120) s WHERE id=$1`,[first.id]);
    await pool.query("UPDATE image_edit_requests SET status='RUNNING' WHERE id=$1",[first.id]);
    const service=createImageEditingService({pool,storageRoot:root});
    const initial=await service.state(workspace.id);
    assert.equal(initial.status,'RUNNING','processing status examines old rows beyond the display page');
    assert.equal(initial.items.length,100);assert.ok(!initial.items.some(item=>item.id===first.id));
    const tracked=await service.state(workspace.id,{ids:[first.id]});assert.equal(tracked.items.length,101);
    assert.ok(tracked.items.some(item=>item.id===first.id));
    assert.ok(tracked.items.every(item=>item.created_by_account_id===actor.userId));
    assert.ok(tracked.items.every(item=>!('config'in item)&&!('result'in item)&&!('events'in item)&&!('validation'in item)));
    await pool.query("UPDATE image_edit_requests SET updated_at=now(),lease_expires_at=now()+interval '10 minutes' WHERE id=$1",[first.id]);
    assert.equal((await service.state(workspace.id,{ids:[first.id]})).signature,tracked.signature);
    await pool.query("UPDATE image_edit_requests SET status='PREVIEW_READY',version=version+1 WHERE id=$1",[first.id]);
    assert.notEqual((await service.state(workspace.id,{ids:[first.id]})).signature,tracked.signature);
    await assert.rejects(service.state(workspace.id,{ids:Array(101).fill(first.id)}),/100/u);
    await assert.rejects(service.state(workspace.id,{ids:['invalid']}),/editId/u);
  } finally {
    await pool.end();await database.stop();
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`)&&basename(root).startsWith('image-state-assets-'));
    await rm(root,{recursive:true,force:true});
  }
});
