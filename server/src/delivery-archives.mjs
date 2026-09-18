import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import { ZipArchive } from 'archiver';
import yauzl from 'yauzl';
import ExcelJS from '@excel.js/exceljs';
import { ControlPlaneConflictError, ControlPlaneNotFoundError, normalizeTaskId, normalizeUuid } from './domain.mjs';
import { deliveryActor, deliveryItemFrom, inDeliveryTransaction, selectDeliveryArchiveItems } from './delivery-ledger.mjs';
import { normalizeListPagination } from './list-pagination.mjs';

const MAX_PART_BYTES = 1024 ** 3;
const MAX_PART_ITEMS = 200;
const MAX_TOTAL_BYTES = 10 * 1024 ** 3;
const PREVIEW_TTL = 10 * 60_000;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fingerprint = rows => sha256(JSON.stringify(rows.map(r=>[String(r.item_id),r.source_sha256,r.delivered_at])));

export async function deliveryFileHash(path) {
  const hash=createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function sourcePath(root, row) {
  return join(root,'.delivery-batches',`${normalizeUuid(row.batch_public_id,'batchId')}.zip`);
}

// Read central directories and stream only exact task members out of immutable
// original ZIPs. Never reconstruct a historical delivery from current tasks.
export async function inspectDeliverySources(root, rows) {
  const groups = new Map(), found = new Map();
  for (const row of rows) {
    const key=row.batch_public_id;
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(row);
  }
  let totalBytes=0;
  for (const members of groups.values()) {
    const path=sourcePath(root,members[0]);
    const metadata=await stat(path).catch(()=>null);
    if (!metadata?.isFile() || metadata.size!==Number(members[0].source_byte_size)
        || await deliveryFileHash(path)!==members[0].source_sha256) {
      throw new ControlPlaneConflictError('DELIVERY_SOURCE_MISSING',`批次 ${members[0].batch_code} 的冻结文件缺失或校验失败`);
    }
    const targets=new Map(members.map(row=>[Number(row.task_id),row]));
    const zip=await yauzl.openPromise(path,{lazyEntries:true,autoClose:false,strictFileNames:true});
    try {
      for await (const entry of zip.eachEntry()) {
        const match=/(?:^|\/)任务-(\d+)-资源包\.zip$/u.exec(entry.fileName);
        if (!match || !targets.has(Number(match[1]))) continue;
        const row=targets.get(Number(match[1])), id=Number(row.item_id);
        if (found.has(id)) throw new ControlPlaneConflictError('DELIVERY_SOURCE_AMBIGUOUS',`任务 #${row.task_id} 的原文件成员重复`);
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize<1 || entry.uncompressedSize>MAX_PART_BYTES) {
          throw new RangeError(`任务 #${row.task_id} 的文件超过单卷 1 GiB 上限`);
        }
        found.set(id,{row,path,entryName:entry.fileName,byteSize:entry.uncompressedSize});
        totalBytes+=entry.uncompressedSize;
        if (totalBytes>MAX_TOTAL_BYTES) throw new RangeError('汇总内容超过 10 GiB，请缩小范围');
      }
    } finally { zip.close(); }
    for (const row of members) if (!found.has(Number(row.item_id))) {
      throw new ControlPlaneConflictError('DELIVERY_SOURCE_MISSING',`原始包中找不到任务 #${row.task_id}，未替换为当前版本`);
    }
  }
  return {members:rows.map(row=>found.get(Number(row.item_id))),totalBytes};
}

async function appendOriginalMember(archive, member, signal) {
  const zip=await yauzl.openPromise(member.path,{lazyEntries:true,autoClose:false,strictFileNames:true});
  try {
    for await (const entry of zip.eachEntry()) {
      signal.throwIfAborted();
      if (entry.fileName!==member.entryName) continue;
      const stream=await zip.openReadStreamPromise(entry);
      const onAbort=()=>stream.destroy(signal.reason);
      signal.addEventListener('abort',onAbort,{once:true});
      try {
        if(archive.destroyed)throw new Error('汇总文件输出已中断');
        const done=once(archive,'entry',{signal});
        stream.once('error',error=>archive.emit('error',error));
        archive.append(stream,{name:`${normalizeTaskId(member.row.task_id)}/${normalizeTaskId(member.row.copy_revision_id)}/${normalizeUuid(member.row.image_run_id,'imageRunId')}/资源包.zip`,store:true});
        await done;
      } finally { signal.removeEventListener('abort',onAbort); stream.destroy(); }
      return;
    }
    throw new Error(`冻结成员丢失：${member.row.task_id}`);
  } finally { zip.close(); }
}

export async function writeDeliveryAggregate(root, job, members, {signal}={signal:new AbortController().signal}) {
  const directory=join(root,'.delivery-archives',String(normalizeTaskId(job.id)));
  await mkdir(directory,{recursive:true});
  const parts=[];
  let group=[],bytes=0;
  for (const member of members) {
    if (group.length && (group.length>=MAX_PART_ITEMS || bytes+member.byteSize>MAX_PART_BYTES)) {
      parts.push(group); group=[]; bytes=0;
    }
    group.push(member); bytes+=member.byteSize;
  }
  if (group.length) parts.push(group);
  const artifacts=[];
  for (const [index,part] of parts.entries()) {
    signal.throwIfAborted();
    const base=`${normalizeUuid(job.run_token,'runToken')}-${index+1}.zip`,path=join(directory,base),temporary=`${path}.tmp`;
    const output=createWriteStream(temporary,{flags:'wx'}),archive=new ZipArchive({forceZip64:true,zlib:{level:0}});
    let transferError;
    const transfer=pipeline(archive,output,{signal}).catch(error=>{transferError=error;});
    try {
      const sheet=new ExcelJS.Workbook(),tab=sheet.addWorksheet('交付清单');
      tab.columns=[['任务号','taskId',12],['Query','query',40],['文案版本','copyRevisionId',14],['图片版本','imageRunId',38],
        ['负责人','ownerUsername',18],['原批次','batchCode',18],['交付人','deliveredBy',18],['交付确认时间（北京时间）','deliveredAt',28]]
        .map(([header,key,width])=>({header,key,width}));
      const manifest=part.map(member=>deliveryItemFrom(member.row,{role:job.actor_role,userId:job.actor_account_id,username:job.actor_username}));
      for (const item of manifest) tab.addRow({...item,deliveredAt:item.deliveredAt?new Date(item.deliveredAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):''});
      tab.getRow(1).font={bold:true};tab.views=[{state:'frozen',ySplit:1}];
      const spreadsheet=Buffer.from(await sheet.xlsx.writeBuffer());
      if(transferError)throw transferError;
      let appended=once(archive,'entry',{signal});
      archive.append(spreadsheet,{name:'清单.xlsx',store:true});
      await appended;
      appended=once(archive,'entry',{signal});
      archive.append(JSON.stringify({archiveId:Number(job.id),kind:job.kind,part:index+1,items:manifest},null,2),{name:'manifest.json'});
      await appended;
      for (const member of part) { if (transferError) throw transferError; await appendOriginalMember(archive,member,signal); }
      await archive.finalize();await transfer;if (transferError) throw transferError;
      await rename(temporary,path);
      artifacts.push({part:index+1,file:base,fileName:`HG-${job.id}-${index+1}-交付内容.zip`,byteSize:(await stat(path)).size,sha256:await deliveryFileHash(path),itemIds:part.map(member=>Number(member.row.item_id))});
    } catch (error) {
      archive.abort();output.destroy(error);await transfer;
      await rm(temporary,{force:true}).catch(()=>{});
      throw error;
    }
  }
  return artifacts;
}

function publicJob(row) {
  return {id:Number(row.id),kind:row.kind,status:row.status,itemCount:row.item_count,createdBy:row.actor_username,
    createdAt:row.created_at,finishedAt:row.finished_at,error:row.error,
    downloadCount:Number(row.download_count??0),lastDownloadedAt:row.last_downloaded_at??null,
    artifacts:(row.artifacts??[]).map(({part,fileName,byteSize})=>({part,fileName,byteSize}))};
}

export function createDeliveryArchiveService({pool,storageRoot}) {
  const previews=new Map(),running=new Map();
  let stopped=false,pumping=null;
  async function expireLeases() {
    await pool.query(`UPDATE delivery_archive_jobs SET status='FAILED',error='文件生成中断，请重试',finished_at=now()
      WHERE status='RUNNING' AND lease_until<now()`);
  }
  async function run(job) {
    const controller=new AbortController();
    const heartbeat=setInterval(()=>{void pool.query(`UPDATE delivery_archive_jobs SET lease_until=now()+interval '2 minutes'
      WHERE id=$1 AND run_token=$2 AND status='RUNNING' RETURNING id`,[job.id,job.run_token])
      .then(result=>{if(!result.rows.length)controller.abort(new Error('归档任务已失效'));})
      .catch(error=>controller.abort(error));},30_000);
    heartbeat.unref?.();
    try {
      const rows=(await pool.query('SELECT snapshot FROM delivery_archive_items WHERE job_id=$1 ORDER BY item_id',[job.id])).rows.map(row=>row.snapshot);
      const inspected=await inspectDeliverySources(storageRoot,rows);
      const artifacts=await writeDeliveryAggregate(storageRoot,{...job,actor_account_id:Number(job.actor_account_id)},inspected.members,{signal:controller.signal});
      await pool.query(`UPDATE delivery_archive_jobs SET status='SUCCEEDED',artifacts=$3,finished_at=now(),lease_until=NULL
        WHERE id=$1 AND run_token=$2 AND status='RUNNING'`,[job.id,job.run_token,JSON.stringify(artifacts)]);
    } catch (error) {
      await pool.query(`UPDATE delivery_archive_jobs SET status='FAILED',error=$3,finished_at=now(),lease_until=NULL
        WHERE id=$1 AND run_token=$2 AND status='RUNNING'`,[job.id,job.run_token,String(error.message).slice(0,1000)]).catch(()=>{});
    } finally {clearInterval(heartbeat);}
  }
  function kick() {
    if(stopped || !pool || pumping) return pumping;
    pumping=(async()=>{
      await expireLeases();
      while(!stopped && running.size<2) {
        const token=randomUUID();
        const job=(await pool.query(`UPDATE delivery_archive_jobs SET status='RUNNING',run_token=$1,lease_until=now()+interval '2 minutes'
          WHERE id=(SELECT id FROM delivery_archive_jobs WHERE status='QUEUED' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,[token])).rows[0];
        if(!job)break;
        const promise=run(job).finally(()=>{running.delete(Number(job.id));queueMicrotask(()=>{void kick();});});
        running.set(Number(job.id),promise);
      }
    })().catch(error=>console.error('delivery archive queue:',error.message)).finally(()=>{pumping=null;});
    return pumping;
  }
  async function rawJob(id,rawActor) {
    const actor=deliveryActor(rawActor);
    const row=(await pool.query(`SELECT * FROM delivery_archive_jobs WHERE id=$1 AND ($2::boolean OR (actor_account_id=$3 AND actor_role='USER'))`,[normalizeTaskId(id),actor.role==='ADMIN',actor.userId])).rows[0];
    if(!row)throw new ControlPlaneNotFoundError('汇总记录不存在');
    return row;
  }
  return {
    kick,
    async preview(input,rawActor) {
      const actor=deliveryActor(rawActor);
      for(const [key,value] of previews)if(value.expires<Date.now())previews.delete(key);
      if(previews.size>=100)throw new ControlPlaneConflictError('DELIVERY_BUSY','当前预检较多，请稍后重试');
      const selected=await inDeliveryTransaction(pool,client=>selectDeliveryArchiveItems(client,input,actor),{readOnly:true});
      const {totalBytes}=await inspectDeliverySources(storageRoot,selected.rows);
      const token=randomUUID();
      previews.set(token,{actorId:actor.userId,expires:Date.now()+PREVIEW_TTL,selected,input,fingerprint:fingerprint(selected.rows)});
      return {token,itemCount:selected.rows.length,totalBytes,batchCount:new Set(selected.rows.map(row=>row.batch_id)).size,kind:selected.kind};
    },
    async create(input,rawActor) {
      const actor=deliveryActor(rawActor),requestId=normalizeUuid(input.requestId,'requestId');
      const previous=(await pool.query('SELECT * FROM delivery_archive_jobs WHERE actor_account_id=$1 AND request_id=$2 AND actor_role=$3',[actor.userId,requestId,actor.role])).rows[0];
      if(previous){void kick();return publicJob(previous);}
      const preview=previews.get(input.token);
      if(!preview || preview.actorId!==actor.userId || preview.expires<Date.now())throw new ControlPlaneConflictError('DELIVERY_PREVIEW_EXPIRED','预检已过期，请重新确认范围');
      const result=await inDeliveryTransaction(pool,async client=>{
        await client.query('SELECT pg_advisory_xact_lock(7373)');
        const existing=(await client.query('SELECT * FROM delivery_archive_jobs WHERE actor_account_id=$1 AND request_id=$2',[actor.userId,requestId])).rows[0];
        if(existing){
          if(existing.actor_role!==actor.role)throw new ControlPlaneConflictError('DELIVERY_IDENTITY_CHANGED','账号角色已变化，请重新创建文件请求');
          return existing;
        }
        const active=(await client.query(`SELECT count(*)::integer AS total,count(*) FILTER (WHERE actor_account_id=$1)::integer AS mine
          FROM delivery_archive_jobs WHERE status IN ('QUEUED','RUNNING')`,[actor.userId])).rows[0];
        if(active.total>=20||active.mine>=2)throw new ControlPlaneConflictError('DELIVERY_BUSY','已有文件正在生成，请完成后再创建');
        const current=await selectDeliveryArchiveItems(client,{kind:preview.selected.kind,itemIds:preview.selected.rows.map(row=>Number(row.item_id))},actor);
        if(fingerprint(current.rows)!==preview.fingerprint)throw new ControlPlaneConflictError('DELIVERY_STATE_CHANGED','所选内容已变化，请重新预检');
        const row=(await client.query(`INSERT INTO delivery_archive_jobs(request_id,actor_account_id,actor_username,kind,selection,item_count,actor_role)
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(actor_account_id,request_id) DO NOTHING RETURNING *`,
        [requestId,actor.userId,actor.username,current.kind,JSON.stringify(preview.input),current.rows.length,actor.role])).rows[0];
        if(!row)return (await client.query('SELECT * FROM delivery_archive_jobs WHERE actor_account_id=$1 AND request_id=$2',[actor.userId,requestId])).rows[0];
        for(const member of current.rows) await client.query('INSERT INTO delivery_archive_items(job_id,item_id,snapshot) VALUES ($1,$2,$3)',[row.id,member.item_id,JSON.stringify(member)]);
        return row;
      });
      previews.delete(input.token);void kick();return publicJob(result);
    },
    async list(input,rawActor) {
      const actor=deliveryActor(rawActor),{limit,offset}=normalizeListPagination(input.limit??20,input.offset??0);
      await expireLeases();void kick();
      const rows=await pool.query(`SELECT job.*,
        (SELECT count(*) FROM delivery_archive_download_events e WHERE e.job_id=job.id) AS download_count,
        (SELECT max(downloaded_at) FROM delivery_archive_download_events e WHERE e.job_id=job.id) AS last_downloaded_at
        FROM delivery_archive_jobs job WHERE ($1::boolean OR (actor_account_id=$2 AND actor_role='USER'))
        ORDER BY id DESC LIMIT $3 OFFSET $4`,[actor.role==='ADMIN',actor.userId,limit,offset]);
      const count=(await pool.query("SELECT count(*)::integer AS total FROM delivery_archive_jobs WHERE ($1::boolean OR (actor_account_id=$2 AND actor_role='USER'))",[actor.role==='ADMIN',actor.userId])).rows[0].total;
      return {items:rows.rows.map(publicJob),total:count};
    },
    async get(id,actor){await expireLeases();void kick();return publicJob(await rawJob(id,actor));},
    async retry(id,actor){const row=await rawJob(id,actor);await pool.query("UPDATE delivery_archive_jobs SET status='QUEUED',error=NULL,finished_at=NULL WHERE id=$1 AND status='FAILED'",[row.id]);void kick();return publicJob(await rawJob(id,actor));},
    async download(id,part,rawActor) {
      const actor=deliveryActor(rawActor),row=await rawJob(id,actor),number=normalizeTaskId(part);
      const artifact=row.artifacts.find(value=>value.part===number);
      if(row.status!=='SUCCEEDED'||!artifact)throw new ControlPlaneConflictError('DELIVERY_ARCHIVE_NOT_READY','文件尚未生成成功');
      const path=join(storageRoot,'.delivery-archives',String(row.id),`${normalizeUuid(row.run_token,'runToken')}-${number}.zip`);
      const meta=await stat(path).catch(()=>null);
      if(!meta?.isFile()||meta.size!==artifact.byteSize||await deliveryFileHash(path)!==artifact.sha256)throw new ControlPlaneConflictError('DELIVERY_ARCHIVE_MISSING','汇总文件缺失或校验失败');
      return {path,...artifact,async record(){
        await inDeliveryTransaction(pool,async client=>{
          await client.query('INSERT INTO delivery_archive_download_events(job_id,part,actor_account_id,actor_username) VALUES ($1,$2,$3,$4)',[row.id,number,actor.userId,actor.username]);
          await client.query(`INSERT INTO delivery_item_download_events(item_id,actor_account_id,actor_username)
            SELECT unnest($1::bigint[]),$2,$3`,[artifact.itemIds,actor.userId,actor.username]);
        });
      }};
    },
    async dispose(){stopped=true;await pumping;await Promise.allSettled([...running.values()]);},
  };
}
