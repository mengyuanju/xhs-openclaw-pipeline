import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { ControlPlaneAuthorizationError, ControlPlaneConflictError, ControlPlaneNotFoundError, normalizeTaskId, normalizeUuid } from './domain.mjs';
import { normalizeTaskDataReportQuery, streamTaskDataReportCsv } from './task-data-report.mjs';
import { createExportProgressLease } from './export-progress-lease.mjs';

function owner(actor) {
  if (actor?.role !== 'ADMIN' || !Number.isSafeInteger(actor.userId) || actor.userId < 1
    || !actor.username || !Number.isSafeInteger(actor.credentialVersion) || actor.credentialVersion < 1) throw new ControlPlaneAuthorizationError();
  return [actor.userId,actor.username,actor.credentialVersion];
}

function visible(row) {
  return {id:Number(row.id),status:row.status,rowCount:Number(row.row_count),createdAt:row.created_at,
    completedAt:row.completed_at,expiresAt:row.expires_at,error:row.last_error};
}

export async function createTaskReportExport(pool, actor, input) {
  const identity = owner(actor);
  const requestId = normalizeUuid(input?.requestId,'requestId');
  const {requestId:unused,...rawQuery} = input ?? {};
  const query = normalizeTaskDataReportQuery(rawQuery);
  query.time.mode = 'ABSOLUTE'; // Resolve a relative date once; a resumed job keeps the submitted range.
  const fingerprint = createHash('sha256').update(JSON.stringify([identity,query])).digest('hex');
  // One request produces one persistent job. A changed payload cannot silently replay an old file.
  const client=await pool.connect();
  let row;
  try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(7311,104)');
  const result = await client.query(`INSERT INTO task_report_exports(request_id,request_fingerprint,owner_account_id,owner_username,credential_version,query)
    SELECT $1,$2,$3,$4,$5,$6::jsonb WHERE
      (SELECT count(*) FROM task_report_exports WHERE status IN ('QUEUED','RUNNING') AND expires_at>clock_timestamp())<10
    ON CONFLICT (owner_account_id,request_id) DO NOTHING RETURNING *`,[requestId,fingerprint,...identity,JSON.stringify(query)]);
  row = result.rows[0] ?? (await client.query('SELECT * FROM task_report_exports WHERE owner_account_id=$1 AND request_id=$2',[actor.userId,requestId])).rows[0];
  await client.query('COMMIT');
  } catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
  if (!row) throw new ControlPlaneConflictError('REPORT_EXPORT_BUSY','导出队列已满，请稍后重试');
  if (row.request_fingerprint !== fingerprint) throw new ControlPlaneConflictError('REQUEST_REPLAY_MISMATCH','同一个导出请求的筛选条件已改变');
  return visible(row);
}

export async function readTaskReportExport(pool, actor, rawId) {
  const identity=owner(actor);
  const row=(await pool.query(`SELECT * FROM task_report_exports
    WHERE id=$1 AND owner_account_id=$2 AND owner_username=$3 AND credential_version=$4`,[normalizeTaskId(rawId),...identity])).rows[0];
  if(!row)throw new ControlPlaneNotFoundError('report export not found');
  return row;
}

export async function listTaskReportExports(pool,actor) {
  const identity=owner(actor);
  return (await pool.query(`SELECT * FROM task_report_exports WHERE owner_account_id=$1 AND owner_username=$2 AND credential_version=$3
    ORDER BY id DESC LIMIT 20`,identity)).rows.map(visible);
}

export async function taskReportExportStatus(pool,actor,id) {return visible(await readTaskReportExport(pool,actor,id));}

function exportPath(storageRoot,row,partial=false) {
  const id=normalizeTaskId(row.id),token=normalizeUuid(row.lease_token,'export lease');
  return join(resolve(storageRoot),'report-exports',`${id}-${token}.csv${partial?'.partial':''}`);
}

export async function readyTaskReportExport(pool,actor,id,storageRoot) {
  const row=await readTaskReportExport(pool,actor,id);
  if(new Date(row.expires_at).valueOf()<=Date.now())throw new ControlPlaneConflictError('REPORT_EXPORT_EXPIRED','导出文件已过期，请重新导出');
  if(row.status!=='COMPLETE')throw new ControlPlaneConflictError('REPORT_EXPORT_NOT_READY','导出文件尚未准备好');
  const path=exportPath(storageRoot,row);
  const file=await stat(path).catch(()=>null);
  if(!file?.isFile())throw new ControlPlaneNotFoundError('report export file not found');
  return {path,size:file.size};
}

export function createTaskReportExportWorker(pool,storageRoot,{logger=console,progressIntervalMs=1500,heartbeatMs=30_000,csvStream=streamTaskDataReportCsv}={}) {
  // A separate single connection keeps a long snapshot export out of interactive requests.
  const exportPool=new pg.Pool({...pool.options,max:1,statement_timeout:60_000,idle_in_transaction_session_timeout:30_000});
  let flight=null,stopping=false,activeProgress=null;
  async function removeLeaseFiles(row) {
    await rm(exportPath(storageRoot,row),{force:true});
    await rm(exportPath(storageRoot,row,true),{force:true});
  }
  async function cleanRetiredFiles() {
    const retired=(await pool.query(`SELECT id,token AS lease_token FROM task_report_exports
      CROSS JOIN LATERAL unnest(retired_lease_tokens) token
      WHERE cardinality(retired_lease_tokens)>0 ORDER BY id,token LIMIT 20`)).rows;
    for(const old of retired) {
      try {
        await removeLeaseFiles(old);
        await pool.query(`UPDATE task_report_exports SET retired_lease_tokens=array_remove(retired_lease_tokens,$2::uuid)
          WHERE id=$1`,[old.id,old.lease_token]);
      } catch(error) {
        // A download or interrupted writer can still hold the file on Windows.
        // Keep its token durable so the next sweep retries instead of leaking it.
        logger.error?.('report export file cleanup deferred',{jobId:Number(old.id),code:error.code??'EXPORT_CLEANUP_ERROR'});
      }
    }
  }
  async function run() {
    await pool.query(`UPDATE task_report_exports SET status='EXPIRED',updated_at=clock_timestamp(),
      retired_lease_tokens=CASE WHEN lease_token IS NULL OR lease_token=ANY(retired_lease_tokens)
        THEN retired_lease_tokens ELSE array_append(retired_lease_tokens,lease_token) END
      WHERE id IN (SELECT id FROM task_report_exports WHERE expires_at<=clock_timestamp() AND status<>'EXPIRED'
        ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED)`);
    const row=(await pool.query(`WITH candidate AS MATERIALIZED (
      SELECT * FROM task_report_exports WHERE expires_at>clock_timestamp()
        AND (status='QUEUED' OR (status='RUNNING' AND lease_until<clock_timestamp()))
        ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
      ) UPDATE task_report_exports job SET status='RUNNING',lease_token=$1,
      retired_lease_tokens=CASE WHEN candidate.lease_token IS NULL OR candidate.lease_token=ANY(job.retired_lease_tokens)
        THEN job.retired_lease_tokens ELSE array_append(job.retired_lease_tokens,candidate.lease_token) END,
      lease_until=clock_timestamp()+interval '2 minutes',updated_at=clock_timestamp(),row_count=0,last_error=NULL
      FROM candidate WHERE job.id=candidate.id RETURNING job.*`,[randomUUID()])).rows[0];
    await cleanRetiredFiles();
    if(!row)return;
    const actor={role:'ADMIN',userId:Number(row.owner_account_id),username:row.owner_username,credentialVersion:row.credential_version};
    const partial=exportPath(storageRoot,row,true),path=exportPath(storageRoot,row);
    let file,rows=0,progress;
    try {
      const current=(await pool.query('SELECT id FROM app_users WHERE id=$1 AND username=$2 AND credential_version=$3 AND role=\'ADMIN\' AND status=\'ACTIVE\'',owner(actor))).rows[0];
      if(!current)throw new ControlPlaneAuthorizationError();
      progress=createExportProgressLease(async count=>{
        const renewed=await pool.query(`UPDATE task_report_exports SET row_count=$3,updated_at=clock_timestamp(),lease_until=clock_timestamp()+interval '2 minutes'
          WHERE id=$1 AND lease_token=$2 AND status='RUNNING'
            AND lease_until>clock_timestamp() AND expires_at>clock_timestamp() RETURNING id`,[row.id,row.lease_token,count]);
        if(!renewed.rows.length)throw new Error('EXPORT_LEASE_LOST');
      },{intervalMs:progressIntervalMs,heartbeatMs});
      activeProgress=progress;
      await mkdir(join(resolve(storageRoot),'report-exports'),{recursive:true});
      file=await open(partial,'wx');
      for await(const chunk of csvStream(exportPool,actor,row.query,{signal:progress.signal})) {
        if(stopping)throw new Error('EXPORT_INTERRUPTED');
        await file.writeFile(chunk.csv);rows+=chunk.rows;
        progress.setRows(rows);
        await progress.flush();
      }
      await progress.flush(true);
      await progress.dispose();
      await file.close();file=null;await rename(partial,path);
      const done=await pool.query(`UPDATE task_report_exports SET status='COMPLETE',row_count=$3,completed_at=clock_timestamp(),updated_at=clock_timestamp(),lease_until=NULL
        WHERE id=$1 AND lease_token=$2 AND status='RUNNING'
          AND lease_until>clock_timestamp() AND expires_at>clock_timestamp() RETURNING id`,[row.id,row.lease_token,rows]);
      if(!done.rows.length)await rm(path,{force:true});
    } catch(error) {
      await progress?.dispose();
      await file?.close().catch(()=>{});
      await removeLeaseFiles(row).catch(()=>{});
      await pool.query(`UPDATE task_report_exports SET status=$3,last_error=$4,lease_until=NULL,updated_at=clock_timestamp(),
        retired_lease_tokens=CASE WHEN $2::uuid=ANY(retired_lease_tokens) THEN retired_lease_tokens
          ELSE array_append(retired_lease_tokens,$2::uuid) END
        WHERE id=$1 AND lease_token=$2 AND status='RUNNING'`,[row.id,row.lease_token,stopping?'QUEUED':'FAILED',stopping?null:'导出失败，请稍后重新提交']).catch(()=>{});
      if(!stopping)logger.error?.('report export failed',{jobId:Number(row.id),code:error.code??'EXPORT_ERROR'});
    } finally {activeProgress=null;}
  }
  const wake=()=>{
    if(stopping||flight)return flight;
    flight=run().catch(error=>logger.error?.('report export queue failed',{code:error.code??'EXPORT_ERROR'})).finally(()=>{flight=null;});
    return flight;
  };
  return {wake,async dispose(){stopping=true;activeProgress?.abort(new Error('EXPORT_INTERRUPTED'));await flight;await exportPool.end();}};
}
