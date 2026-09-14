import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { ControlPlaneConflictError, ControlPlaneAuthorizationError, ControlPlaneNotFoundError, normalizeTaskId, normalizeUuid } from './domain.mjs';
import { withdrawReadyDeliveryEntries } from './final-delivery.mjs';
import { boundedNumber, shortText, normalizeManualOverlay, normalizeMask, decodeReference, imageHash, safeRect } from '../../src/image-edit-pixels.mjs';

const conflict = message => { throw new ControlPlaneConflictError('IMAGE_EDIT_CONFLICT', message); };
const actorName = actor => { if(actor?.role !== 'ADMIN' || !actor.username) throw new ControlPlaneAuthorizationError('仅管理员可修改图片'); return actor.username; };
async function lockAdmin(c,actor) {
  actorName(actor);
  const row=(await c.query("SELECT id FROM app_users WHERE id=$1 AND username=$2 AND role='ADMIN' AND status='ACTIVE' AND credential_version=$3 FOR UPDATE",[normalizeTaskId(actor.userId),actor.username,boundedNumber(actor.credentialVersion,1,2147483647)])).rows[0];
  if(!row)throw new ControlPlaneAuthorizationError('管理员身份已失效，请重新登录');
}
export async function editTransaction(pool, action) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const value = await action(c); await c.query('COMMIT'); return value; }
  catch(error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
}
export function editStoragePath(root, stored) {
  const path = resolve(stored), rel = relative(resolve(root), path);
  if(!rel || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) throw new TypeError('资产路径无效');
  return path;
}
export function normalizeEdit(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('修改参数无效');
  const allowed = ['requestId','sourceImageRunId','sourceAssetId','copyRevisionId','sha256','targetPage','operation','instruction','preserve','negative','overlay','mask','references','confirmation','draft','restoreRunId'];
  if(Object.keys(input).some(k => !allowed.includes(k))) throw new TypeError('未知修改参数');
  const operation = input.operation;
  if(!['TEXT','COMPOSITE','AI_FUSION','AI_FULL','AI_LOCAL','RESTORE'].includes(operation)) throw new TypeError('修改类型无效');
  if(operation.startsWith('AI_') && input.confirmation !== 'LIVE_IMAGE_COST_ACCEPTED') throw new TypeError('请确认图片编辑及校验模型费用');
  if(!/^[a-f0-9]{64}$/u.test(input.sha256 ?? '')) throw new TypeError('源图校验值无效');
  const refs = input.references ?? [];
  if(!['COMPOSITE','AI_FUSION'].includes(operation) && refs.length) throw new TypeError('仅实体图片操作可附加参考图');
  if(!Array.isArray(refs) || refs.length > 4 || (['COMPOSITE','AI_FUSION'].includes(operation) && !refs.length)) throw new TypeError('请选择 1 至 4 张参考图');
  const references = refs.map((r, i) => ({ assetId: normalizeTaskId(r.assetId), purpose: shortText(r.purpose ?? '实体参考',200),
    ...(operation === 'COMPOSITE' ? { ...safeRect(r), opacity: boundedNumber(r.opacity ?? 1,0.01,1,false), z: boundedNumber(r.z ?? i,0,10),
      crop: r.crop ? { x: boundedNumber(r.crop.x,0,16000), y: boundedNumber(r.crop.y,0,16000), width: boundedNumber(r.crop.width,1,16000), height: boundedNumber(r.crop.height,1,16000) } : null,
      removeBackground: r.removeBackground === true } : {}) }));
  if(new Set(references.map(r=>r.assetId)).size !== references.length) throw new TypeError('参考图重复');
  return { requestId: normalizeUuid(input.requestId,'requestId'), sourceImageRunId: normalizeUuid(input.sourceImageRunId,'sourceImageRunId'),
    sourceAssetId: normalizeTaskId(input.sourceAssetId), copyRevisionId: normalizeTaskId(input.copyRevisionId), sha256: input.sha256,
    targetPage: boundedNumber(input.targetPage,1,5), operation,
    instruction: shortText(input.instruction ?? '',2000,operation.startsWith('AI_')), preserve: shortText(input.preserve ?? '',2000,false), negative: shortText(input.negative ?? '',2000,false),
    overlay: operation === 'TEXT' ? normalizeManualOverlay(input.overlay) : null,
    mask: operation === 'AI_LOCAL' ? normalizeMask(input.mask) : null,
    references, confirmation: operation.startsWith('AI_') ? input.confirmation : null, draft: input.draft === true,
    restoreRunId: operation === 'RESTORE' ? normalizeUuid(input.restoreRunId,'restoreRunId') : null };
}
export function imageAssetIds(result) {
  return [...new Set((result?.images ?? []).flatMap(i=>[i.assetId,i.sourceAssetId,i.deliveryAssetId]).filter(Number.isSafeInteger))];
}
export function replaceImagePage(result, page, asset) {
  if(!Array.isArray(result?.images) || !result.images[page-1]) throw new TypeError('目标页面不存在');
  const images = result.images.map((image,index) => index === page-1 ? { ...image, assetId: Number(asset.id), sourceAssetId: Number(asset.id), deliveryAssetId: Number(asset.id),
    url: `/v1/assets/${asset.id}`, sourceUrl: `/v1/assets/${asset.id}`, deliveryUrl: `/v1/assets/${asset.id}`, sha256: asset.sha256,
    imageSettings: image.imageSettings ? {...image.imageSettings,format:'PNG'} : undefined,
    sourceOriginal: false, imageEdit: true } : image);
  return { ...result, images };
}
async function audit(c, taskId, id, action, actor, reason, requestId = null, detail = {}) {
  await c.query('INSERT INTO image_edit_events(task_id,edit_id,action,actor,reason,request_id,detail) VALUES($1,$2,$3,$4,$5,$6,$7)',[taskId,id,action,actor,reason,requestId,detail]);
}
export async function assertEditSource(c, taskId, config) {
  const task = (await c.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[taskId])).rows[0];
  if(!task) throw new ControlPlaneNotFoundError('task not found');
  if(!['MANUAL_ARCHIVE','REVIEWED'].includes(task.state) || task.current_execution_id || task.mandatory_copy_qc) conflict('任务不在可编辑状态，或文案仍需质检');
  if(task.current_image_run_id !== config.sourceImageRunId || Number(task.current_copy_revision_id) !== config.copyRevisionId) conflict('图片或文案已更新，请刷新');
  const revision = (await c.query('SELECT * FROM copy_revisions WHERE id=$1 AND task_id=$2',[config.copyRevisionId,taskId])).rows[0];
  if(!revision?.approved_at) conflict('文案尚未批准');
  const run = (await c.query('SELECT * FROM image_runs WHERE id=$1 AND task_id=$2',[config.sourceImageRunId,taskId])).rows[0];
  if(run?.status !== 'COMPLETED' || Number(run.copy_revision_id) !== config.copyRevisionId) conflict('源图集未完成或文案不匹配');
  const page = run.result?.images?.[config.targetPage-1];
  if(!page || Number(page.deliveryAssetId ?? page.assetId) !== config.sourceAssetId) conflict('所选资产不是当前页交付图');
  const source = (await c.query('SELECT * FROM assets WHERE id=$1 AND task_id=$2',[config.sourceAssetId,taskId])).rows[0];
  if(!source || source.sha256 !== config.sha256) conflict('源图片校验值已变化');
  return { task, revision, run, source };
}
export function createImageEditingService({ pool, storageRoot }) {
  const stagedFiles=new WeakMap();
  const tx = async action => {
    const files=[];
    try { return await editTransaction(pool,async c=>{stagedFiles.set(c,files);try{return await action(c);}finally{stagedFiles.delete(c);}}); }
    catch(error){await Promise.all(files.map(path=>unlink(path).catch(()=>{})));throw error;}
  };
  async function storeAsset(c,taskId,run,bytes,role,metadata,parent=null) {
    const id = randomUUID(), directory=resolve(storageRoot,'image-edits',String(normalizeTaskId(taskId)));
    await mkdir(directory,{recursive:true});
    const path=resolve(directory,`${id}.png`);
    await writeFile(path,bytes,{flag:'wx'});
    stagedFiles.get(c)?.push(path);
    try { return (await c.query(`INSERT INTO assets(task_id,image_run_id,media_type,byte_size,sha256,storage_path,original_name,image_production_chain_id,artifact_key,origin_image_run_id,active,parent_asset_id,asset_role,edit_metadata)
      VALUES($1,$2,'image/png',$3,$4,$5,$6,$7,$8,$2,false,$9,$10,$11) RETURNING *`,[taskId,run.id,bytes.length,imageHash(bytes),path,`${role.toLowerCase()}-${id}.png`,run.image_production_chain_id,id,parent,role,metadata])).rows[0]; }
    catch(error) { await unlink(path).catch(()=>{}); throw error; }
  }
  async function get(id) {
    const row=(await pool.query(`SELECT e.*,row_to_json(r) AS result,
      (SELECT json_agg(a ORDER BY a.id) FROM image_edit_events a WHERE a.edit_id=e.id) AS events
      FROM image_edit_requests e LEFT JOIN image_edit_results r ON r.request_id=e.id WHERE e.id=$1`,[normalizeUuid(id,'editId')])).rows[0];
    if(!row) throw new ControlPlaneNotFoundError('image edit not found');
    return row;
  }
  return {
    get,
    async asset(id,taskId) { const a=(await pool.query('SELECT * FROM assets WHERE id=$1 AND task_id=$2',[normalizeTaskId(id),normalizeTaskId(taskId)])).rows[0];if(!a)throw new ControlPlaneNotFoundError('asset not found');return a; },
    async list(taskId) { return (await pool.query('SELECT e.*,row_to_json(r) AS result, (SELECT json_agg(a ORDER BY a.id) FROM image_edit_events a WHERE a.edit_id=e.id) AS events FROM image_edit_requests e LEFT JOIN image_edit_results r ON r.request_id=e.id WHERE task_id=$1 ORDER BY created_at DESC LIMIT 100',[normalizeTaskId(taskId)])).rows; },
    async upload(taskId,input,actor) {
      const username=actorName(actor); taskId=normalizeTaskId(taskId);
      if(typeof input?.base64 !== 'string' || input.base64.length > 7_000_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(input.base64)) throw new TypeError('图片编码无效');
      const purpose=shortText(input.purpose,200), source=shortText(input.source,1000);
      const decoded=await decodeReference(Buffer.from(input.base64,'base64'),input.mediaType);
      return tx(async c=> {
        await lockAdmin(c,actor);
        const task=(await c.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[taskId])).rows[0];
        if(!task?.current_image_run_id || !['MANUAL_ARCHIVE','REVIEWED'].includes(task.state)) conflict('当前任务无可编辑图片');
        const quota=(await c.query("SELECT count(*)::integer AS count, COALESCE(sum(byte_size),0)::bigint AS bytes FROM assets WHERE task_id=$1 AND asset_role='REFERENCE'",[taskId])).rows[0];
        if(quota.count >= 20 || Number(quota.bytes)+decoded.bytes.length > 50*1024*1024) throw new TypeError('任务参考图存储已达上限');
        const run=(await c.query('SELECT * FROM image_runs WHERE id=$1',[task.current_image_run_id])).rows[0];
        const asset=await storeAsset(c,taskId,run,decoded.bytes,'REFERENCE',{ ...decoded,bytes:undefined,uploadedBy:username,purpose,source });
        await audit(c,taskId,null,'UPLOAD_REFERENCE',username,source,null,{assetId:Number(asset.id),sha256:asset.sha256});
        return { id:Number(asset.id),sha256:asset.sha256,width:decoded.width,height:decoded.height,url:`/v1/assets/${asset.id}` };
      });
    },
    async create(taskId,input,actor) {
      const username=actorName(actor), config=normalizeEdit(input); taskId=normalizeTaskId(taskId);
      return tx(async c=> {
        await lockAdmin(c,actor);
        await c.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[taskId]);
        const prior=(await c.query('SELECT * FROM image_edit_requests WHERE task_id=$1 AND request_id=$2',[taskId,config.requestId])).rows[0];
        if(prior) { if(JSON.stringify(prior.config) !== JSON.stringify(JSON.parse(JSON.stringify(config)))) {
          // jsonb key order differs: compare normalized content structurally.
          if(!sameJson(prior.config,config)) conflict('requestId 已用于不同请求');
        } return prior; }
        await assertEditSource(c,taskId,config);
        let bytes=0,pixels=0;
        for(const ref of config.references) {
          const a=(await c.query("SELECT * FROM assets WHERE id=$1 AND task_id=$2 AND asset_role='REFERENCE'",[ref.assetId,taskId])).rows[0];
          if(!a) throw new TypeError('参考图片不属于当前任务');
          bytes+=Number(a.byte_size); pixels+=a.edit_metadata.width*a.edit_metadata.height;
        }
        if(bytes > 20*1024*1024 || pixels > 32_000_000) throw new TypeError('参考图总大小或像素超限');
        const id=randomUUID();
        const row=(await c.query(`INSERT INTO image_edit_requests(id,task_id,request_id,source_image_run_id,source_asset_id,copy_revision_id,source_sha256,target_page,operation,config,status,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[id,taskId,config.requestId,config.sourceImageRunId,config.sourceAssetId,config.copyRevisionId,config.sha256,config.targetPage,config.operation,config,config.draft?'DRAFT':'QUEUED',username])).rows[0];
        for(const [i,ref] of config.references.entries()) await c.query('INSERT INTO image_edit_reference_assets(request_id,asset_id,purpose,sort_order,sha256) SELECT $1,id,$3,$4,sha256 FROM assets WHERE id=$2',[id,ref.assetId,ref.purpose,i]);
        await withdrawReadyDeliveryEntries(c,taskId,'IMAGE_MANUAL_EDIT');
        await c.query("UPDATE tasks SET state='MANUAL_ARCHIVE',image_reviewed_at=NULL,image_reviewed_by_user_id=NULL,updated_at=now() WHERE id=$1",[taskId]);
        await audit(c,taskId,id,'CREATE',username,config.instruction || config.operation);
        return row;
      });
    },
    async action(id,action,input,actor) {
      const username=actorName(actor), requestId=normalizeUuid(input.requestId,'requestId'), version=boundedNumber(input.version,1,2147483647), reason=shortText(input.reason,1000);
      const initial=await get(id);
      return tx(async c=> {
        await lockAdmin(c,actor);
        await c.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[initial.task_id]);
        const e=(await c.query('SELECT * FROM image_edit_requests WHERE id=$1 FOR UPDATE',[initial.id])).rows[0];
        const previous=(await c.query('SELECT * FROM image_edit_events WHERE task_id=$1 AND request_id=$2',[e.task_id,requestId])).rows[0];
        if(previous) { if(previous.edit_id !== id || previous.action !== action || previous.reason !== reason || previous.actor !== username) conflict('requestId 已用于其他操作'); return e; }
        if(e.version !== version) conflict('编辑状态已更新，请刷新');
        const states={queue:['DRAFT'],retry:['FAILED'],cancel:['DRAFT','QUEUED','RUNNING','PREVIEW_READY'],reject:['PREVIEW_READY'],accept:['PREVIEW_READY']};
        if(!states[action]?.includes(e.status)) conflict('当前编辑状态不允许此操作');
        if(['queue','retry','accept'].includes(action)) await assertEditSource(c,Number(e.task_id),e.config);
        if(action==='retry' && e.attempts >= 3) conflict('已达到三次执行上限，请创建新请求');
        if(action==='accept') {
          const r=(await c.query('SELECT * FROM image_edit_results WHERE request_id=$1',[id])).rows[0];
          if(r?.validation?.passed !== true || r.validation.mock === true) conflict('图片校验未通过');
          const output=(await c.query('SELECT * FROM assets WHERE id=$1 AND task_id=$2',[r.asset_id,e.task_id])).rows[0];
          if(!output || imageHash(await readFile(editStoragePath(storageRoot,output.storage_path)))!==output.sha256 || output.sha256!==r.validation.integrity?.sha256) conflict('预览图片完整性校验失败');
          await withdrawReadyDeliveryEntries(c,e.task_id,'IMAGE_MANUAL_EDIT_ACCEPTED');
          await c.query('UPDATE image_edit_results SET adopted=true WHERE request_id=$1',[id]);
          await c.query("UPDATE tasks SET current_image_run_id=$2,state='MANUAL_ARCHIVE',current_stage='MANUAL_ARCHIVE',image_reviewed_at=NULL,image_reviewed_by_user_id=NULL,progress_message='图片修改已采用，请重新审核归档',updated_at=now() WHERE id=$1",[e.task_id,r.image_run_id]);
        }
        const next={queue:'QUEUED',retry:'QUEUED',cancel:'CANCELLED',reject:'REJECTED',accept:'ACCEPTED'}[action];
        const updated=(await c.query('UPDATE image_edit_requests SET status=$2,version=version+1,error=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 RETURNING *',[id,next])).rows[0];
        await audit(c,e.task_id,id,action,username,reason,requestId);
        return updated;
      });
    },
    async claim(worker) {
      shortText(worker,128);
      return tx(async c=> {
        // Expired attempts fail visibly; model calls are never silently replayed.
        const expired=await c.query("UPDATE image_edit_requests SET status='FAILED',error='执行租约过期，请确认后重试',version=version+1,lease_token=NULL WHERE status='RUNNING' AND lease_expires_at < now() RETURNING *");
        for(const item of expired.rows)await audit(c,item.task_id,item.id,'LEASE_EXPIRED',worker,'执行租约过期');
        const e=(await c.query("SELECT * FROM image_edit_requests WHERE status='QUEUED' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
        if(!e) return null;
        const row=(await c.query("UPDATE image_edit_requests SET status='RUNNING',attempts=attempts+1,version=version+1,claimed_by=$2,lease_token=$3,lease_expires_at=now()+interval '15 minutes',updated_at=now() WHERE id=$1 RETURNING *",[e.id,worker,randomUUID()])).rows[0];
        await audit(c,e.task_id,e.id,'EXECUTE',worker,`attempt ${row.attempts}`); return row;
      });
    },
    async heartbeat(e) { return (await pool.query("UPDATE image_edit_requests SET lease_expires_at=now()+interval '15 minutes' WHERE id=$1 AND lease_token=$2 AND status='RUNNING' AND lease_expires_at>now()",[e.id,e.lease_token])).rowCount===1; },
    async context(e) {
      return tx(async c=> {
        const source=await assertEditSource(c,Number(e.task_id),e.config);
        const refs=(await c.query('SELECT a.* FROM image_edit_reference_assets r JOIN assets a ON a.id=r.asset_id WHERE r.request_id=$1 ORDER BY r.sort_order',[e.id])).rows;
        const bindings=(await c.query('SELECT asset_id,sha256 FROM image_edit_reference_assets WHERE request_id=$1',[e.id])).rows;
        if(refs.length!==e.config.references.length||refs.some(a=>!bindings.some(b=>Number(b.asset_id)===Number(a.id)&&b.sha256===a.sha256))) conflict('参考图绑定或校验值变化');
        const settings=(await c.query("SELECT value FROM global_settings WHERE key='production'")).rows[0]?.value ?? {};
        const restored=e.operation==='RESTORE' ? (await c.query("SELECT * FROM image_runs WHERE id=$1 AND task_id=$2 AND copy_revision_id=$3 AND status='COMPLETED'",[e.config.restoreRunId,e.task_id,e.copy_revision_id])).rows[0] : null;
        if(e.operation==='RESTORE' && !restored) conflict('仅能恢复当前已批准文案对应的历史图集');
        return {...source,refs,settings,restored};
      });
    },
    async readAsset(asset) { const bytes=await readFile(editStoragePath(storageRoot,asset.storage_path)); if(imageHash(bytes)!==asset.sha256) throw new Error('资产完整性校验失败'); return bytes; },
    async complete(e,{bytes,mask,validation,originalResult}) {
      return tx(async c=> {
        const source=await assertEditSource(c,Number(e.task_id),e.config);
        const locked=(await c.query('SELECT * FROM image_edit_requests WHERE id=$1 FOR UPDATE',[e.id])).rows[0];
        if(locked.status!=='RUNNING' || locked.lease_token!==e.lease_token || new Date(locked.lease_expires_at)<=new Date()) conflict('执行已取消或租约过期');
        if(validation?.passed!==true) throw new TypeError('校验未通过');
        const run=(await c.query("INSERT INTO image_runs(id,task_id,copy_revision_id,status,image_production_chain_id,finished_at) VALUES($1,$2,$3,'COMPLETED',$1,now()) RETURNING *",[randomUUID(),e.task_id,e.copy_revision_id])).rows[0];
        const asset=await storeAsset(c,Number(e.task_id),run,bytes,'DELIVERY',{operation:e.operation,editId:e.id,disclosure:e.config.overlay?.disclosureType?{type:e.config.overlay.disclosureType,text:e.config.overlay.text}:null,validation},e.source_asset_id);
        const maskAsset=mask?await storeAsset(c,Number(e.task_id),run,mask,'MASK',{editId:e.id},e.source_asset_id):null;
        const result=replaceImagePage(originalResult??source.run.result,e.target_page,asset);
        result.images[e.target_page-1].imageEditRequiredText=validation.requiredText;
        result.processing={type:e.operation,editId:e.id,parentRunId:e.source_image_run_id};
        result.imageEditValidation=validation;
        await c.query('UPDATE image_runs SET result=$2 WHERE id=$1',[run.id,result]);
        for(const id of imageAssetIds(result)) {
          const member=await c.query("INSERT INTO image_run_asset_members(image_run_id,asset_id) SELECT $1,id FROM assets WHERE id=$2 AND task_id=$3 AND asset_role='DELIVERY' RETURNING asset_id",[run.id,id,e.task_id]);
          if(member.rowCount!==1)conflict('图集包含不属于当前任务的交付资产');
        }
        await c.query('INSERT INTO image_edit_results(request_id,asset_id,image_run_id,mask_asset_id,validation) VALUES($1,$2,$3,$4,$5)',[e.id,asset.id,run.id,maskAsset?.id??null,validation]);
        await c.query("UPDATE image_edit_requests SET status='PREVIEW_READY',validation=$2,version=version+1,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",[e.id,validation]);
        await audit(c,e.task_id,e.id,'PREVIEW_READY',e.claimed_by,'图片校验通过');
        return {assetId:Number(asset.id),imageRunId:run.id};
      });
    },
    async fail(e,error) {
      return tx(async c=> {
        const updated=await c.query("UPDATE image_edit_requests SET status='FAILED',error=$3,validation=$4,version=version+1,lease_token=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2 AND status='RUNNING' RETURNING id",[e.id,e.lease_token,String(error?.message??'图片修改失败').replace(/sk-[\w-]+|Bearer\s+\S+/gu,'[REDACTED]').slice(0,1000),error?.validation??null]);
        if(updated.rowCount) await audit(c,e.task_id,e.id,'FAILED',e.claimed_by,'执行或校验失败');
      });
    },
  };
}
function sameJson(a,b) {
  if(a===b)return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
  const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&sameJson(a[k],b[k]));
}
