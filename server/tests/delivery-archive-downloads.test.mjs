import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Koa from 'koa';
import Router from '@koa/router';
import JSZip from 'jszip';
import { createDeliverySnapshot, inspectSnapshotSources, saveDeliverySnapshot } from '../src/delivery-snapshots.mjs';
import { createDeliveryArchiveService, writeDeliveryAggregate } from '../src/delivery-archives.mjs';
import { installSharedDeliveryRoutes } from '../src/delivery-routes.mjs';

const admin={userId:1,username:'admin',role:'ADMIN'};
const owner={userId:2,username:'owner',role:'USER'};
const stranger={userId:3,username:'stranger',role:'USER'};

async function fixture(t,{imageSize=32,status='SUCCEEDED'}={}) {
  const root=await mkdtemp(join(tmpdir(),'xhs-aggregate-snapshot-'));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  await mkdir(join(root,'tasks'));
  const picture=randomBytes(imageSize),imagePath=join(root,'tasks','original.png');
  await writeFile(imagePath,picture);
  const zip=new JSZip(),directory='甲方批次/任务-1-资源包';
  const copy='\uFEFF原始 Query：冻结 Query\r\n标题：冻结标题\r\n文案内容：冻结正文\r\n';
  zip.file(`${directory}/文案.txt`,copy);zip.file(`${directory}/01.png`,picture);
  zip.file(`${directory}/小红书链接.txt`,'https://example.test/frozen');
  const bytes=await zip.generateAsync({type:'nodebuffer'}),publicId=randomUUID(),source=join(root,'initial.zip');
  await writeFile(source,bytes);
  const snapshot=await createDeliverySnapshot(root,source,publicId,{resolveImage:async()=>({storagePath:'tasks/original.png'})});
  await saveDeliverySnapshot(root,snapshot);await rm(source);
  const selection={item_id:1,task_id:1,batch_id:1,batch_public_id:publicId,batch_code:'JF-TEST',
    source_byte_size:bytes.length,source_sha256:createHash('sha256').update(bytes).digest('hex'),
    query:'冻结 Query',issued_query:'冻结下发 Query'};
  const job={id:1,run_token:randomUUID(),status,kind:'DOWNLOAD',item_count:1,
    actor_role:'USER',actor_account_id:owner.userId,actor_username:owner.username,
    artifacts:[{part:1,fileName:'HG-1-1-交付内容.zip',byteSize:123,itemIds:[1]}]};
  const events=[];
  const pool={async query(sql,args=[]) {
    if(sql.includes('SELECT * FROM delivery_archive_jobs WHERE id=')) {
      return {rows:args[1]||Number(args[2])===job.actor_account_id?[{...job}]:[]};
    }
    if(sql.includes('SELECT archived.snapshot'))return {rows:[{snapshot:selection}]};
    if(sql.includes("UPDATE delivery_archive_jobs SET status='FAILED'"))return {rows:[]};
    if(sql.includes("UPDATE delivery_archive_jobs SET status='RUNNING'")) {
      if(job.status!=='QUEUED')return {rows:[]};
      job.status='RUNNING';job.run_token=args[0];return {rows:[{...job}]};
    }
    if(sql.includes("UPDATE delivery_archive_jobs SET status='SUCCEEDED'")) {
      job.status='SUCCEEDED';job.artifacts=JSON.parse(args[2]);return {rows:[]};
    }
    if(sql.startsWith('INSERT INTO delivery_archive_download_events')){events.push(args);return {rows:[]};}
    if(sql.startsWith('INSERT INTO delivery_item_download_events')||['BEGIN','COMMIT','ROLLBACK'].includes(sql))return {rows:[]};
    throw new Error(`Unexpected fixture query: ${sql}`);
  },async connect(){return {query:pool.query.bind(pool),release(){}};}};
  return {root,pool,events,job,selection,picture,imagePath,directory,copy};
}

async function temporaryFiles(root) {
  return readdir(join(root,'.delivery-exports')).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
}

async function until(check) {
  for(let attempt=0;attempt<200;attempt++) {
    if(await check())return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('temporary delivery operation did not settle');
}

test('snapshot-only aggregate preparation retains metadata and deletes every prepared ZIP',async t=>{
  const f=await fixture(t,{status:'QUEUED'}),service=createDeliveryArchiveService({pool:f.pool,storageRoot:f.root});
  t.after(()=>service.dispose());
  await service.kick();
  await until(async()=>f.job.status==='SUCCEEDED'&&(await temporaryFiles(f.root)).length===0);
  assert.equal(f.job.artifacts.length,1);
  assert.equal(f.job.artifacts[0].path,undefined);
  assert.equal(f.job.artifacts[0].file,undefined);
  assert.equal(f.job.artifacts[0].byteSize>0,true);
  assert.equal((await readdir(f.root)).includes('.delivery-archives'),false);
});

test('historical and concurrent downloads regenerate exact frozen members without retaining ZIPs',async t=>{
  const f=await fixture(t),service=createDeliveryArchiveService({pool:f.pool,storageRoot:f.root});
  t.after(()=>service.dispose());
  await assert.rejects(service.download(1,1,stranger),{code:'NOT_FOUND'});
  assert.deepEqual(await temporaryFiles(f.root),[]);
  const first=await service.download(1,1,owner),second=await service.download(1,1,owner);
  assert.notEqual(first.path,second.path);
  const archive=await JSZip.loadAsync(await readFile(first.path));
  assert.deepEqual(await archive.file(`${f.directory}/01.png`).async('nodebuffer'),f.picture);
  assert.equal(await archive.file(`${f.directory}/文案.txt`).async('string'),f.copy.replace('冻结 Query','冻结下发 Query'));
  assert.equal(await archive.file(`${f.directory}/小红书链接.txt`).async('string'),'https://example.test/frozen');
  await first.record();await first.cleanup();
  assert.equal((await readFile(second.path)).length>0,true,'one download must not remove another download');
  await second.cleanup();assert.deepEqual(await temporaryFiles(f.root),[]);
  const third=await service.download(1,1,admin);await third.cleanup();
  assert.deepEqual(await temporaryFiles(f.root),[]);assert.equal(f.events.length,1);
});

test('changed image hashes, cancellation and shutdown remove partial and completed temporary output',async t=>{
  const f=await fixture(t,{imageSize:1024*1024}),service=createDeliveryArchiveService({pool:f.pool,storageRoot:f.root});
  t.after(()=>service.dispose());
  await writeFile(f.imagePath,Buffer.alloc(f.picture.length));
  await assert.rejects(service.download(1,1,owner),{code:'DELIVERY_SOURCE_MISSING'});
  assert.deepEqual(await temporaryFiles(f.root),[]);
  await writeFile(f.imagePath,f.picture);
  const abort=new AbortController(),pending=service.download(1,1,owner,{signal:abort.signal});
  abort.abort(new DOMException('cancelled','AbortError'));
  await assert.rejects(pending,{name:'AbortError'});assert.deepEqual(await temporaryFiles(f.root),[]);
  const inspected=await inspectSnapshotSources(f.root,[f.selection]),writingAbort=new AbortController();
  const writing=writeDeliveryAggregate(f.root,f.job,inspected.members,{signal:writingAbort.signal});
  setImmediate(()=>writingAbort.abort(new DOMException('cancel writing','AbortError')));
  await assert.rejects(writing,{name:'AbortError'});assert.deepEqual(await temporaryFiles(f.root),[]);
  const artifact=await service.download(1,1,owner);await service.dispose();
  await assert.rejects(readFile(artifact.path),{code:'ENOENT'});assert.deepEqual(await temporaryFiles(f.root),[]);
});

test('download routes leave HEAD metadata-only and clean success, repeat download and client cancellation',async t=>{
  const f=await fixture(t,{imageSize:2*1024*1024}),app=new Koa(),router=new Router();
  app.on('error',()=>{});
  app.use(async(ctx,next)=>{try{await next();}catch(error){ctx.status=error.code==='NOT_FOUND'?404:409;ctx.body={error:error.message};}});
  const dispose=installSharedDeliveryRoutes(router,{pool:f.pool},f.root,{
    requestActor:()=>owner,requireJson:ctx=>ctx.request.body,json:(ctx,status,data)=>{ctx.status=status;ctx.body=data;},
    assertCurrentActorIdentity:async()=>{},
  });
  app.use(router.routes());
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await dispose();});
  const url=`http://127.0.0.1:${server.address().port}/v1/delivery-archives/1/download/1`;
  const head=await fetch(url,{method:'HEAD'});assert.equal(head.status,200);
  assert.deepEqual(await temporaryFiles(f.root),[]);assert.equal(f.events.length,0);
  for(let attempt=0;attempt<2;attempt++) {
    const response=await fetch(url);assert.equal(response.status,200);
    const zip=await JSZip.loadAsync(await response.arrayBuffer());
    assert.deepEqual(await zip.file(`${f.directory}/01.png`).async('nodebuffer'),f.picture);
    await until(async()=>(await temporaryFiles(f.root)).length===0);
  }
  assert.equal(f.events.length,2);
  const cancelled=await fetch(url),reader=cancelled.body.getReader();
  await reader.read();await reader.cancel();
  await until(async()=>(await temporaryFiles(f.root)).length===0);
});
