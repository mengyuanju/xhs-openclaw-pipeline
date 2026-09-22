import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rename, stat, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import { ZipArchive } from 'archiver';
import yauzl from 'yauzl';
import { Readable } from 'node:stream';
import { withOriginalDeliveryQuery } from './delivery-copy-query.mjs';
import { ControlPlaneConflictError, ControlPlaneNotFoundError, normalizeTaskId, normalizeUuid } from './domain.mjs';
import { deliveryActor, inDeliveryTransaction, selectDeliveryArchiveItems } from './delivery-ledger.mjs';
import { normalizeListPagination } from './list-pagination.mjs';

const MAX_PART_BYTES = 1024 ** 3;
const MAX_PART_ITEMS = 200;
const MAX_TOTAL_BYTES = 10 * 1024 ** 3;
const PREVIEW_TTL = 10 * 60_000;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fingerprint = rows => sha256(JSON.stringify(rows.map(r=>[String(r.item_id),r.source_sha256,r.delivered_at,r.issued_query ?? null])));

export async function deliveryFileHash(path) {
  const hash=createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function sourcePath(root, row) {
  return join(root,'.delivery-batches',`${normalizeUuid(row.batch_public_id,'batchId')}.zip`);
}

function ambiguousMember(member) {
  return new ControlPlaneConflictError('DELIVERY_SOURCE_AMBIGUOUS',`任务 #${member.row.task_id} 的原文件成员重复`);
}

function addMemberFile(member, entry, name) {
  const key=name.normalize('NFC').toLocaleLowerCase('zh-CN');
  if (yauzl.validateFileName(name) || name.split('/').some(part=>!part || part==='.')
      || /[\u0000-\u001f]/u.test(name)) throw new TypeError('冻结文件路径无效');
  if (member.files.some(file=>file.key===key)) throw ambiguousMember(member);
  if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize<0
      || member.byteSize+entry.uncompressedSize>MAX_PART_BYTES) {
    throw new RangeError(`任务 #${member.row.task_id} 的文件超过单卷 1 GiB 上限`);
  }
  member.files.push({entryName:entry.fileName,name,key,byteSize:entry.uncompressedSize});
  member.byteSize+=entry.uncompressedSize;
}

// Legacy batches contain a ZIP per task. Stage only that ZIP on disk so its
// files can be read individually without buffering an entire task in memory.
async function withTaskSourceZip(member, operation, signal) {
  const zip=await yauzl.openPromise(member.path,{lazyEntries:true,autoClose:false,strictFileNames:true});
  try {
    if (!member.entryName) return await operation(zip);
    for await (const entry of zip.eachEntry()) {
      signal?.throwIfAborted();
      if (entry.fileName!==member.entryName) continue;
      const directory=await mkdtemp(join(tmpdir(),'xhs-delivery-member-'));
      const temporary=join(directory,'member.zip');
      try {
        const stream=await zip.openReadStreamPromise(entry);
        await pipeline(stream,createWriteStream(temporary,{flags:'wx'}),{signal});
        const inner=await yauzl.openPromise(temporary,{lazyEntries:true,autoClose:false,strictFileNames:true});
        try { return await operation(inner); }
        finally {
          const closed=once(inner,'close');
          inner.close();
          await closed;
        }
      } finally {
        await rm(temporary,{force:true});
        await rmdir(directory);
      }
    }
    throw new Error(`冻结成员丢失：${member.row.task_id}`);
  } finally { zip.close(); }
}

// Read central directories and stream only exact task members out of immutable
// original ZIPs. Keep frozen copy and image versions; only the Query header is
// corrected to the imported issued Query when writing a new download.
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
        if (entry.fileName.endsWith('/')) continue;
        const match=/^((?:[^/]+\/)?任务-(\d+)-资源包)(?:\.zip|\/(.+))$/u.exec(entry.fileName);
        if (!match || !targets.has(Number(match[2]))) continue;
        const row=targets.get(Number(match[2])), id=Number(row.item_id);
        const entryName=match[3] ? null : entry.fileName;
        let member=found.get(id);
        if (member && (member.entryName || entryName || member.directory!==match[1])) {
          throw ambiguousMember(member);
        }
        if (!member) {
          member={row,path,entryName,directory:match[1],files:[],byteSize:0};
          found.set(id,member);
        }
        if (entryName) {
          if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize<1 || entry.uncompressedSize>MAX_PART_BYTES) {
            throw new RangeError(`任务 #${row.task_id} 的文件超过单卷 1 GiB 上限`);
          }
        } else addMemberFile(member,entry,match[3]);
      }
    } finally { zip.close(); }
    for (const row of members) if (!found.has(Number(row.item_id))) {
      throw new ControlPlaneConflictError('DELIVERY_SOURCE_MISSING',`原始包中找不到任务 #${row.task_id}，未替换为当前版本`);
    }
    for (const row of members) {
      const member=found.get(Number(row.item_id));
      if (member.entryName) await withTaskSourceZip(member,async inner=>{
        for await (const entry of inner.eachEntry()) {
          if (!entry.fileName.endsWith('/')) addMemberFile(member,entry,entry.fileName);
        }
      });
      if (!member.files.length) throw new ControlPlaneConflictError('DELIVERY_SOURCE_MISSING',`任务 #${row.task_id} 的原始包没有文件`);
      totalBytes+=member.byteSize;
      if (totalBytes>MAX_TOTAL_BYTES) throw new RangeError('汇总内容超过 10 GiB，请缩小范围');
    }
  }
  return {members:rows.map(row=>found.get(Number(row.item_id))),totalBytes};
}

async function appendOriginalMember(archive, member, signal) {
  const directory=member.outputDirectory;
  await withTaskSourceZip(member,async zip=>{
    const remaining=new Map(member.files.map(file=>[file.entryName,file]));
    for await (const entry of zip.eachEntry()) {
      signal.throwIfAborted();
      const file=remaining.get(entry.fileName);
      if (!file) continue;
      if (file.byteSize!==entry.uncompressedSize) throw new Error(`冻结文件已变化：${member.row.task_id}`);
      const stream=await zip.openReadStreamPromise(entry);
      const content=/\.txt$/iu.test(file.name)
        ? Readable.from(withOriginalDeliveryQuery(stream,{issuedQuery:member.row.issued_query,query:member.row.query})) : stream;
      if(content!==stream)stream.once('error',error=>content.destroy(error));
      const onAbort=()=>{content.destroy(signal.reason);stream.destroy(signal.reason);};
      signal.addEventListener('abort',onAbort,{once:true});
      try {
        if(archive.destroyed)throw new Error('汇总文件输出已中断');
        const done=once(archive,'entry',{signal});
        content.once('error',error=>archive.emit('error',error));
        archive.append(content,{name:`${directory}/${file.name}`});
        await done;
      } finally { signal.removeEventListener('abort',onAbort); content.destroy(); stream.destroy(); }
      remaining.delete(entry.fileName);
    }
    if (remaining.size) throw new Error(`冻结成员丢失：${member.row.task_id}`);
  },signal);
}

export async function writeDeliveryAggregate(root, job, members, {signal}={signal:new AbortController().signal}) {
  const directory=join(root,'.delivery-archives',String(normalizeTaskId(job.id)));
  await mkdir(directory,{recursive:true});
  const parts=[];
  let group=[],bytes=0;
  const usedDirectories=new Set();
  for (const original of members) {
    let outputDirectory=original.directory,suffix=2;
    while(usedDirectories.has(outputDirectory.normalize('NFC').toLocaleLowerCase('zh-CN'))) outputDirectory=`${original.directory}-${suffix++}`;
    usedDirectories.add(outputDirectory.normalize('NFC').toLocaleLowerCase('zh-CN'));
    const member={...original,outputDirectory};
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
    const output=createWriteStream(temporary,{flags:'wx'}),archive=new ZipArchive({forceZip64:true,zlib:{level:6}});
    let transferError;
    const transfer=pipeline(archive,output,{signal}).catch(error=>{transferError=error;});
    try {
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
      const rows=(await pool.query(`SELECT archived.snapshot,source.issued_query
        FROM delivery_archive_items archived
        LEFT JOIN delivery_batch_items item ON item.id=archived.item_id
        LEFT JOIN tasks task ON task.id=item.task_id
        LEFT JOIN query_package_items source ON source.id=task.source_query_package_item_id
        WHERE archived.job_id=$1 ORDER BY archived.item_id`,[job.id])).rows
        .map(row=>Object.hasOwn(row.snapshot,'issued_query') ? row.snapshot : {...row.snapshot,issued_query:row.issued_query});
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
