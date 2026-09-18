import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import sharp from 'sharp';
import { ControlPlaneConflictError, ControlPlaneAuthorizationError, ControlPlaneNotFoundError, normalizeTaskId, normalizeUuid } from './domain.mjs';
import { PENDING_IMAGE_EDIT_STATUSES, withdrawReadyDeliveryEntries } from './final-delivery.mjs';
import { imagePageDisclosure, imageResultScopedToPage, imageSettingsScopedToPage } from './image-edit-lineage.mjs';
import { disclosureRemovalConfig, requestsDisclosureRemoval } from './image-edit-disclosure.mjs';
import { boundedNumber, shortText, normalizeManualOverlay, normalizeMask, decodeReference, imageHash, safeRect, renderMask, EDIT_WIDTH, EDIT_HEIGHT } from '../../src/image-edit-pixels.mjs';
import { orderedImageFileName } from '../../src/image-file-name.mjs';
import { normalizeImageEditRepairMaxAttempts } from '../../src/production-settings.mjs';
import { createPromptRuntime } from '../../src/prompt-runtime.mjs';
import { selectLocalEditAlternative } from '../../src/local-edit-alternatives.mjs';

const conflict = message => { throw new ControlPlaneConflictError('IMAGE_EDIT_CONFLICT', message); };
const actorName = actor => { if(!['ADMIN','USER'].includes(actor?.role) || !actor.username) throw new ControlPlaneAuthorizationError('当前账号不能修改图片'); return actor.username; };
async function lockEditor(c,actor,taskId) {
  actorName(actor);
  const row=(await c.query(`SELECT u.id FROM app_users u JOIN tasks t ON t.id=$4
    WHERE u.id=$1 AND u.username=$2 AND u.role=$5 AND u.status='ACTIVE'
      AND u.credential_version=$3
      AND (u.role='ADMIN' OR (u.role='USER' AND t.assigned_to_user_id=u.username
        AND t.state IN ('MANUAL_ARCHIVE','IMAGE_REWORK_PENDING')))
    FOR UPDATE OF u`,[normalizeTaskId(actor.userId),actor.username,
    boundedNumber(actor.credentialVersion,1,2147483647),normalizeTaskId(taskId),actor.role])).rows[0];
  if(!row)throw new ControlPlaneAuthorizationError('图片编辑权限或任务归属已变化，请重新登录后刷新');
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
  const allowed = ['requestId','batchId','sourceImageRunId','sourceAssetId','copyRevisionId','sha256','targetPage','operation','instruction','preserve','negative','overlay','mask','target','references','referenceMode','confirmation','draft','restoreRunId'];
  if(Object.keys(input).some(k => !allowed.includes(k))) throw new TypeError('未知修改参数');
  const operation = input.operation;
  if(!['TEXT','SVG_DISCLOSURE','COMPOSITE','AI_FUSION','AI_FULL','AI_LOCAL','RESTORE'].includes(operation)) throw new TypeError('修改类型无效');
  if(input.batchId != null && !['TEXT','SVG_DISCLOSURE'].includes(operation)) throw new TypeError('只有人工生成标识支持整套批次');
  const usesBillableModel = operation === 'TEXT' || operation.startsWith('AI_');
  const draft=input.draft===true,confirmed=input.confirmation==='LIVE_IMAGE_COST_ACCEPTED';
  if(usesBillableModel && !draft && !confirmed) throw new TypeError('请确认图片编辑或视觉校验模型费用');
  if(!/^[a-f0-9]{64}$/u.test(input.sha256 ?? '')) throw new TypeError('源图校验值无效');
  const refs = input.references ?? [];
  if(!['COMPOSITE','AI_FUSION'].includes(operation) && refs.length) throw new TypeError('仅实体图片操作可附加参考图');
  if(!Array.isArray(refs) || refs.length > 4 || (['COMPOSITE','AI_FUSION'].includes(operation) && !refs.length)) throw new TypeError('请选择 1 至 4 张参考图');
  if(operation === 'AI_FUSION' && refs.length !== 1) throw new TypeError('真实产品替换只能上传 1 张参考图');
  const references = refs.map((r, i) => ({ assetId: normalizeTaskId(r.assetId), purpose: shortText(r.purpose ?? '实体参考',200),
    ...(operation === 'COMPOSITE' ? { ...safeRect(r), opacity: boundedNumber(r.opacity ?? 1,0.01,1,false), z: boundedNumber(r.z ?? i,0,10),
      crop: r.crop ? { x: boundedNumber(r.crop.x,0,16000), y: boundedNumber(r.crop.y,0,16000), width: boundedNumber(r.crop.width,1,16000), height: boundedNumber(r.crop.height,1,16000) } : null,
      removeBackground: r.removeBackground === true } : {}) }));
  if(new Set(references.map(r=>r.assetId)).size !== references.length) throw new TypeError('参考图重复');
  if(operation !== 'AI_FUSION' && input.target != null) throw new TypeError('仅真实产品替换可指定目标物体');
  if(operation !== 'AI_FUSION' && input.referenceMode != null) throw new TypeError('仅真实产品替换可指定参考图使用方式');
  const referenceMode=operation === 'AI_FUSION' ? String(input.referenceMode??'STRICT') : null;
  if(operation === 'AI_FUSION' && !['STRICT','APPEARANCE'].includes(referenceMode)) throw new TypeError('参考图使用方式无效');
  let target=null;
  if(operation === 'AI_FUSION') {
    const value=input.target;
    if(!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key=>!['description','region'].includes(key))) {
      throw new TypeError('真实产品替换必须提供目标描述和框选区域');
    }
    const region=safeRect(value.region);
    if(region.width < 24 || region.height < 24) throw new TypeError('目标框选区域过小');
    target={description:shortText(value.description,500),region};
  }
  const normalizedOverlay=['TEXT','SVG_DISCLOSURE'].includes(operation) ? normalizeManualOverlay({...input.overlay,textType:'AI_DISCLOSURE',disclosureType:'AI_GENERATED',
    size:32,margin:32,opacity:1,color:'#ffffff',background:'#111827',position:'bottom-right'}) : null;
  const overlay=operation==='SVG_DISCLOSURE'
    ?{text:normalizedOverlay.text,textType:normalizedOverlay.textType,disclosureType:normalizedOverlay.disclosureType,position:'bottom-right'}
    :normalizedOverlay;
  return { requestId: normalizeUuid(input.requestId,'requestId'),
    ...(input.batchId == null ? {} : { batchId: normalizeUuid(input.batchId,'batchId') }),
    sourceImageRunId: normalizeUuid(input.sourceImageRunId,'sourceImageRunId'),
    sourceAssetId: normalizeTaskId(input.sourceAssetId), copyRevisionId: normalizeTaskId(input.copyRevisionId), sha256: input.sha256,
    targetPage: boundedNumber(input.targetPage,1,5), operation,
    instruction: shortText(input.instruction ?? '',2000,operation.startsWith('AI_')), preserve: shortText(input.preserve ?? '',2000,false), negative: shortText(input.negative ?? '',2000,false),
    overlay,
    // New local edits locate the target from the operator's prompt. Keep accepting
    // a mask for already-created clients and queued historical requests.
    mask: operation === 'AI_LOCAL' && input.mask != null ? normalizeMask(input.mask) : null,
    target,references,referenceMode, confirmation: usesBillableModel&&confirmed ? input.confirmation : null, draft,
    restoreRunId: operation === 'RESTORE' ? normalizeUuid(input.restoreRunId,'restoreRunId') : null };
}
export function imageAssetIds(result) {
  return [...new Set((result?.images ?? []).flatMap(i=>[i.assetId,i.sourceAssetId,i.deliveryAssetId]).filter(Number.isSafeInteger))];
}
function requestEditConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
  const { imageEditRepairMaxAttempts: _frozenRepairLimit, imageEditPrompt: _frozenPrompt, localPlan, localAlternative, localRepair: _localRepair, ...requestConfig } = config;
  const originalInstruction=localAlternative?.originalInstruction??localPlan?.originalInstruction;
  return originalInstruction?{...requestConfig,instruction:originalInstruction}:requestConfig;
}
const rectContains=(outer,inner)=>inner.x>=outer.x&&inner.y>=outer.y
  &&inner.x+inner.width<=outer.x+outer.width&&inner.y+inner.height<=outer.y+outer.height;
function localSuggestionPlan(validation,originalInstruction) {
  if(!validation||validation.stage!=='LOCAL_EDIT_SUGGESTION'||validation.canEdit!==true
    ||validation.decision!=='SUGGEST')throw new TypeError('当前请求没有可采用的局部修改建议');
  const sourceRegion=safeRect(validation.sourceRegion??validation.region);
  const destinationRegion=validation.destinationRegion?safeRect(validation.destinationRegion):null;
  if(!Array.isArray(validation.editRegions)||validation.editRegions.length<1||validation.editRegions.length>4)throw new TypeError('局部修改建议区域无效');
  const editRegions=validation.editRegions.map(region=>safeRect(region));
  const contactRegion=validation.contactRegion?safeRect(validation.contactRegion):null;
  if(editRegions.some(region=>region.width<24||region.height<24)
    ||!editRegions.some(region=>rectContains(region,sourceRegion))
    ||(destinationRegion&&!editRegions.some(region=>rectContains(region,destinationRegion)))
    ||(contactRegion&&!editRegions.some(region=>rectContains(region,contactRegion))))throw new TypeError('局部修改建议区域无效');
  const operationType=String(validation.operationType??'ADJUST').toUpperCase();
  if(!['ADJUST','MOVE','REMOVE','REPLACE','BACKGROUND'].includes(operationType))throw new TypeError('局部修改建议类型无效');
  return {accepted:true,originalInstruction:shortText(originalInstruction,2000),suggestedInstruction:shortText(validation.suggestedInstruction,2000),
    sourceRegion,destinationRegion,editRegions,operationType,touchesImageEdge:validation.touchesImageEdge===true,
    targetIsAiDisclosure:validation.targetIsAiDisclosure===true,targetDescription:shortText(validation.targetDescription??'',500,false),
    sourceAction:shortText(validation.sourceAction??'',500,false),destinationAction:shortText(validation.destinationAction??'',500,false),
    quantity:shortText(validation.quantity??'',500,false),relationship:shortText(validation.relationship??'',500,false),
    contactRegion,
    warnings:Array.isArray(validation.warnings)?validation.warnings.filter(value=>typeof value==='string').slice(0,8).map(value=>value.slice(0,300)):[],
    reason:shortText(validation.reason??'',1000,false),confidence:typeof validation.confidence==='number'?validation.confidence:0,
    checks:validation.checks??{},model:typeof validation.model==='string'?validation.model:null};
}
const LOCAL_REPAIR_FAILURE_CODES=new Set(['SOURCE_NOT_CLEARED','DESTINATION_OBJECT_MISSING','QUANTITY_INCORRECT',
  'POUR_CONTACT_MISSING','TARGET_COUNT_INCORRECT','PLACEMENT_OR_RELATIONSHIP_INCORRECT',
  'TARGET_INCOMPLETE_OR_OCCLUDED','COMPOSITION_UNBALANCED','REQUESTED_CHANGE_INCOMPLETE']);
function rejectedLocalRepairPlan(edit,result) {
  if(edit.operation!=='AI_LOCAL'||!result?.validation||result.validation.stage!=='LOCAL_EDIT_RESULT') {
    conflict('当前失败结果不能基于失败图定向修复，请调整说明后从原图重试');
  }
  const validation=result.validation,local=validation.localConsistency,localization=validation.localization;
  const rawFailureCodes=Array.isArray(local?.failureCodes)?local.failureCodes:[];
  const failureCodes=[...new Set(rawFailureCodes.filter(code=>typeof code==='string'))];
  if(local?.repairableFromRejected!==true||local?.checks?.protectedTextPreserved!==true
    ||local?.checks?.unrelatedContentPreserved!==true||!failureCodes.length
    ||failureCodes.length!==rawFailureCodes.length||failureCodes.some(code=>!LOCAL_REPAIR_FAILURE_CODES.has(code))
    ||!localization||typeof localization!=='object'||Array.isArray(localization)) {
    conflict('当前失败结果不能安全局部补救，请调整说明后从原图重试');
  }
  const repairRegions=Array.isArray(local.repairRegions)?local.repairRegions.map(region=>safeRect(region)):[];
  const allowedRegions=Array.isArray(localization.editRegions)?localization.editRegions.map(region=>safeRect(region)):[];
  if(!repairRegions.length||repairRegions.length>4||!allowedRegions.length
    ||repairRegions.some(region=>!allowedRegions.some(allowed=>rectContains(allowed,region)))) {
    conflict('失败结果的定向修复区域无效，请调整说明后从原图重试');
  }
  const sourceRegion=safeRect(localization.sourceRegion??localization.region);
  const destinationRegion=localization.destinationRegion?safeRect(localization.destinationRegion):null;
  const contactRegion=localization.contactRegion?safeRect(localization.contactRegion):null;
  if(!allowedRegions.some(region=>rectContains(region,sourceRegion))
    ||(destinationRegion&&!allowedRegions.some(region=>rectContains(region,destinationRegion)))
    ||(contactRegion&&!allowedRegions.some(region=>rectContains(region,contactRegion)))) {
    conflict('失败结果的原始编辑规划无效，请调整说明后从原图重试');
  }
  const maxAttempts=normalizeImageEditRepairMaxAttempts(edit.config.imageEditRepairMaxAttempts);
  const attempt=Number(edit.config.localRepair?.attempt??0)+1;
  if(attempt>maxAttempts)conflict('已达到定向修复次数上限，请人工采用结果或创建新的修改请求');
  const assetId=normalizeTaskId(result.asset_id);
  const sha256=String(validation.integrity?.sha256??'');
  if(!/^[a-f0-9]{64}$/u.test(sha256))conflict('失败预览完整性记录无效，不能作为修复起点');
  return {attempt,maxAttempts,baseAssetId:assetId,baseSha256:sha256,
    originalInstruction:shortText(edit.config.localRepair?.originalInstruction??edit.config.instruction,2000),
    failureCodes,repairInstruction:shortText(local.repairInstruction,2000),repairRegions,
    validationReason:shortText(local.reason??edit.error??'',1000,false),
    plan:{operationType:String(localization.operationType??'ADJUST').slice(0,50),
      targetDescription:shortText(localization.targetDescription??'',500,false),sourceAction:shortText(localization.sourceAction??'',500,false),
      destinationAction:shortText(localization.destinationAction??'',500,false),quantity:shortText(localization.quantity??'',500,false),
      relationship:shortText(localization.relationship??'',500,false),sourceRegion,destinationRegion,
      contactRegion,editRegions:allowedRegions,
      touchesImageEdge:localization.touchesImageEdge===true,targetIsAiDisclosure:localization.targetIsAiDisclosure===true,
      warnings:Array.isArray(localization.warnings)?localization.warnings.slice(0,8):[],reason:shortText(localization.reason??'',1000,false),
      confidence:typeof localization.confidence==='number'?localization.confidence:1,checks:localization.checks??{},model:localization.model??null}};
}
function availableRejectedLocalRepairPlan(edit,result) {
  try { return rejectedLocalRepairPlan(edit,result); }
  catch(error) {
    if(error instanceof ControlPlaneConflictError)return null;
    throw error;
  }
}
export function resolveImageEditRetry(edit,result,input={}) {
  if(input.useRejectedPreview===true) {
    return {targetedRepair:true,localRepair:rejectedLocalRepairPlan(edit,result)};
  }
  if(availableRejectedLocalRepairPlan(edit,result)) {
    conflict('当前失败结果可以定向修复，请刷新工作台后选择“基于失败图定向修复”；如需从原图改做，请复用说明并创建新的修改请求');
  }
  if(Number(edit?.attempts??0)>=3)conflict('已达到三次执行上限，请创建新请求');
  return {targetedRepair:false,localRepair:null};
}
async function publishedImageEditPrompt(client, { required = true } = {}) {
  const rows = (await client.query(`
    SELECT t.kind, t.name, v.id AS version_id, v.version, v.content, v.content_sha256
    FROM prompt_templates t
    JOIN prompt_versions v ON v.template_id = t.id AND v.status = 'PUBLISHED'
    WHERE t.kind = 'IMAGE_EDIT_SYSTEM' OR t.kind = 'IMAGE_ALIGNMENT_SYSTEM' OR t.kind LIKE 'INTERNAL_%'
  `)).rows;
  const row = rows.find(item => item.kind === 'IMAGE_EDIT_SYSTEM');
  if (!row) {
    if (required) throw new TypeError('请先在提示词管理中发布图片编辑提示词');
    return null;
  }
  return {
    kind: 'IMAGE_EDIT_SYSTEM',
    name: row.name,
    versionId: Number(row.version_id),
    version: Number(row.version),
    content: row.content,
    sha256: row.content_sha256,
    capturedAt: new Date().toISOString(),
    runtime: createPromptRuntime({ source: 'IMAGE_EDIT_REQUEST', settings: null,
      prompts: Object.fromEntries(rows.map(item => [item.kind, { content: item.content, versionId: Number(item.version_id),
        version: Number(item.version), sha256: item.content_sha256 }])) }),
  };
}
export function replaceImagePage(result, page, asset) {
  if(!Array.isArray(result?.images) || !result.images[page-1]) throw new TypeError('目标页面不存在');
  const images = result.images.map((image,index) => {
    const inheritedDisclosure=imagePageDisclosure(result,index+1);
    const current=inheritedDisclosure&&!image.imageEditDisclosure
      ? {...image,imageEditDisclosure:inheritedDisclosure}:image;
    return index === page-1 ? { ...current, assetId: Number(asset.id), sourceAssetId: Number(asset.id), deliveryAssetId: Number(asset.id),
      url: `/v1/assets/${asset.id}`, sourceUrl: `/v1/assets/${asset.id}`, deliveryUrl: `/v1/assets/${asset.id}`, sha256: asset.sha256,
      imageSettings: image.imageSettings ? {...image.imageSettings,format:'PNG'} : undefined,
      sourceOriginal: false, imageEdit: true } : current;
  });
  return { ...result, images };
}
async function audit(c, taskId, id, action, actor, reason, requestId = null, detail = {}) {
  await c.query('INSERT INTO image_edit_events(task_id,edit_id,action,actor,reason,request_id,detail) VALUES($1,$2,$3,$4,$5,$6,$7)',[taskId,id,action,actor,reason,requestId,detail]);
}
export async function assertEditSource(c, taskId, config, { allowCompatibleCurrentRun = false } = {}) {
  const task = (await c.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[taskId])).rows[0];
  if(!task) throw new ControlPlaneNotFoundError('task not found');
  if(!['MANUAL_ARCHIVE','IMAGE_REWORK_PENDING','REVIEWED'].includes(task.state) || task.current_execution_id || task.mandatory_copy_qc) conflict('任务不在可编辑状态，或文案仍需质检');
  if(Number(task.current_copy_revision_id) !== config.copyRevisionId) conflict('图片或文案已更新，请刷新');
  const currentRunChanged=task.current_image_run_id !== config.sourceImageRunId;
  if(currentRunChanged && (!allowCompatibleCurrentRun || config.operation === 'RESTORE')) conflict('图片或文案已更新，请刷新');
  const revision = (await c.query('SELECT * FROM copy_revisions WHERE id=$1 AND task_id=$2',[config.copyRevisionId,taskId])).rows[0];
  if(!revision?.approved_at) conflict('文案尚未批准');
  const run = (await c.query('SELECT * FROM image_runs WHERE id=$1 AND task_id=$2',[config.sourceImageRunId,taskId])).rows[0];
  if(run?.status !== 'COMPLETED' || Number(run.copy_revision_id) !== config.copyRevisionId) conflict('源图集未完成或文案不匹配');
  const page = run.result?.images?.[config.targetPage-1];
  if(!page || Number(page.deliveryAssetId ?? page.assetId) !== config.sourceAssetId) conflict('所选资产不是当前页交付图');
  const source = (await c.query('SELECT * FROM assets WHERE id=$1 AND task_id=$2',[config.sourceAssetId,taskId])).rows[0];
  if(!source || source.sha256 !== config.sha256) conflict('源图片校验值已变化');
  let currentRun=run;
  if(currentRunChanged) {
    currentRun=(await c.query('SELECT * FROM image_runs WHERE id=$1 AND task_id=$2',[task.current_image_run_id,taskId])).rows[0];
    if(currentRun?.status !== 'COMPLETED' || Number(currentRun.copy_revision_id) !== config.copyRevisionId) conflict('当前图集未完成或文案不匹配');
    const currentPage=currentRun.result?.images?.[config.targetPage-1];
    if(!currentPage || Number(currentPage.deliveryAssetId ?? currentPage.assetId) !== config.sourceAssetId) conflict('当前页图片已更新，请刷新后重新修改');
  }
  return { task, revision, run, currentRun, source };
}
export function createImageEditingService({ pool, storageRoot }) {
  const stagedFiles=new WeakMap();
  const tx = async action => {
    const files=[];
    try { return await editTransaction(pool,async c=>{stagedFiles.set(c,files);try{return await action(c);}finally{stagedFiles.delete(c);}}); }
    catch(error){await Promise.all(files.map(path=>unlink(path).catch(()=>{})));throw error;}
  };
  async function storeAsset(c,taskId,run,bytes,role,metadata,parent=null,originalName=null) {
    const id = randomUUID(), directory=resolve(storageRoot,'image-edits',String(normalizeTaskId(taskId)));
    await mkdir(directory,{recursive:true});
    const path=resolve(directory,`${id}.png`);
    await writeFile(path,bytes,{flag:'wx'});
    stagedFiles.get(c)?.push(path);
    try { return (await c.query(`INSERT INTO assets(task_id,image_run_id,media_type,byte_size,sha256,storage_path,original_name,image_production_chain_id,artifact_key,origin_image_run_id,active,parent_asset_id,asset_role,edit_metadata)
      VALUES($1,$2,'image/png',$3,$4,$5,$6,$7,$8,$2,false,$9,$10,$11) RETURNING *`,[taskId,run.id,bytes.length,imageHash(bytes),path,originalName??`${role.toLowerCase()}-${id}.png`,run.image_production_chain_id,id,parent,role,metadata])).rows[0]; }
    catch(error) { await unlink(path).catch(()=>{}); throw error; }
  }
  async function previewMetadata(bytes) {
    if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>20*1024*1024)throw new TypeError('图片修改结果无效');
    const metadata=await sharp(bytes,{failOn:'warning',limitInputPixels:16_000_000,animated:true}).metadata();
    if(metadata.format!=='png'||metadata.width!==EDIT_WIDTH||metadata.height!==EDIT_HEIGHT||(metadata.pages??1)!==1) {
      throw new TypeError('图片修改结果必须为 1086×1448 单页 PNG');
    }
    return {metadata,sha256:imageHash(bytes)};
  }
  async function lockedExecutorEdit(c,rawExecutionId,rawEditId,rawLeaseToken,{allowCompleted=false,allowFailed=false}={}) {
    const executionId=normalizeUuid(rawExecutionId,'executionId');
    const editId=normalizeUuid(rawEditId,'editId');
    const leaseToken=normalizeUuid(rawLeaseToken,'leaseToken');
    const row=(await c.query(`SELECT e.*,x.status AS execution_status,x.node_id
      FROM image_edit_requests e JOIN task_executions x ON x.id=e.execution_id
      WHERE e.id=$1 AND e.execution_id=$2 FOR UPDATE OF e,x`,[editId,executionId])).rows[0];
    if(!row)throw new ControlPlaneNotFoundError('image edit execution not found');
    if(allowCompleted&&row.status==='PREVIEW_READY')return row;
    if(allowFailed&&row.status==='FAILED')return row;
    if(row.status!=='RUNNING'||row.execution_status!=='RUNNING'||row.lease_token!==leaseToken
      ||new Date(row.lease_expires_at)<=new Date())conflict('图片修改执行已取消或租约过期');
    return row;
  }
  async function loadContext(c,e) {
    // An existing one-page edit remains valid when only other pages have been
    // adopted since it was created. Acceptance rebases it onto the latest run.
    const source=await assertEditSource(c,Number(e.task_id),e.config,{allowCompatibleCurrentRun:true});
    const refs=(await c.query('SELECT a.* FROM image_edit_reference_assets r JOIN assets a ON a.id=r.asset_id WHERE r.request_id=$1 ORDER BY r.sort_order',[e.id])).rows;
    const bindings=(await c.query('SELECT asset_id,sha256 FROM image_edit_reference_assets WHERE request_id=$1',[e.id])).rows;
    if(refs.length!==e.config.references.length||refs.some(a=>!bindings.some(b=>Number(b.asset_id)===Number(a.id)&&b.sha256===a.sha256))) conflict('参考图绑定或校验值变化');
    const settings=(await c.query("SELECT value FROM global_settings WHERE key='production'")).rows[0]?.value ?? {};
    const restored=e.operation==='RESTORE' ? (await c.query("SELECT * FROM image_runs WHERE id=$1 AND task_id=$2 AND copy_revision_id=$3 AND status='COMPLETED'",[e.config.restoreRunId,e.task_id,e.copy_revision_id])).rows[0] : null;
    if(e.operation==='RESTORE' && !restored) conflict('仅能恢复当前已批准文案对应的历史图集');
    const usesImageModel=e.operation==='TEXT'||e.operation.startsWith('AI_');
    const imageEditPrompt=e.config.imageEditPrompt??(usesImageModel?await publishedImageEditPrompt(c):null);
    let repairSource=null;
    if(e.config.localRepair) {
      repairSource=(await c.query("SELECT * FROM assets WHERE id=$1 AND task_id=$2 AND sha256=$3 AND asset_role='REJECTED_PREVIEW'",
        [e.config.localRepair.baseAssetId,e.task_id,e.config.localRepair.baseSha256])).rows[0]??null;
      if(!repairSource)conflict('失败预览已变化或不可用，不能继续定向修复');
    }
    const page=Number(e.target_page);
    const run={...source.run,result:imageResultScopedToPage(source.run.result,page)};
    const executorSettings=imageSettingsScopedToPage(settings,source.run.result,page);
    return {...source,run,refs,settings:executorSettings,restored,imageEditPrompt,repairSource};
  }
  async function get(id) {
    const row=(await pool.query(`SELECT e.*,row_to_json(r) AS result,
      (SELECT json_agg(a ORDER BY a.id) FROM image_edit_events a WHERE a.edit_id=e.id) AS events
      FROM image_edit_requests e LEFT JOIN image_edit_results r ON r.request_id=e.id WHERE e.id=$1`,[normalizeUuid(id,'editId')])).rows[0];
    if(!row) throw new ControlPlaneNotFoundError('image edit not found');
    return row;
  }
  async function applyAction(c,id,action,input,actor) {
    const username=actorName(actor), requestId=normalizeUuid(input.requestId,'requestId'), version=boundedNumber(input.version,1,2147483647), reason=shortText(input.reason,1000);
    const e=(await c.query('SELECT * FROM image_edit_requests WHERE id=$1 FOR UPDATE',[id])).rows[0];
    const previous=(await c.query('SELECT * FROM image_edit_events WHERE task_id=$1 AND request_id=$2',[e.task_id,requestId])).rows[0];
    if(previous) { if(previous.edit_id !== id || previous.action !== action || previous.reason !== reason || previous.actor !== username
      || (action==='apply-suggestion' && (previous.detail?.suggestionId??null)!==(input.suggestionId??null))) conflict('requestId 已用于其他操作'); return e; }
    if(e.version !== version) conflict('编辑状态已更新，请刷新');
    const states={queue:['DRAFT'],retry:['FAILED'],'apply-suggestion':['FAILED'],cancel:['DRAFT','QUEUED','RUNNING','PREVIEW_READY','FAILED'],reject:['PREVIEW_READY'],accept:['PREVIEW_READY','FAILED']};
    if(!states[action]?.includes(e.status)) conflict('当前编辑状态不允许此操作');
    const usesBillableModel=e.operation==='TEXT'||e.operation.startsWith('AI_');
    const confirmsCost=e.config?.confirmation==='LIVE_IMAGE_COST_ACCEPTED'||input.confirmation==='LIVE_IMAGE_COST_ACCEPTED';
    if(['queue','retry','apply-suggestion'].includes(action)&&usesBillableModel&&!confirmsCost) throw new TypeError('请确认图片编辑或视觉校验模型费用');
    if(action==='retry'&&input.useRejectedPreview===true&&input.confirmation!=='LIVE_IMAGE_COST_ACCEPTED') {
      throw new TypeError('基于失败图定向修复会再次调用图片模型，请重新确认费用');
    }
    const editSource=['queue','retry','apply-suggestion','accept'].includes(action)
      ? await assertEditSource(c,Number(e.task_id),e.config,{allowCompatibleCurrentRun:true})
      : null;
    let retryResolution=null;
    if(action==='retry') {
      const result=(await c.query('SELECT * FROM image_edit_results WHERE request_id=$1',[e.id])).rows[0]??null;
      retryResolution=resolveImageEditRetry(e,result,input);
    }
    if(action==='apply-suggestion'&&e.operation!=='AI_LOCAL')conflict('只有局部修改可以采用建议描述');
    let acceptedRejectedPreview=false;
    if(action==='accept') {
      const r=(await c.query('SELECT * FROM image_edit_results WHERE request_id=$1',[id])).rows[0];
      acceptedRejectedPreview=e.status==='FAILED'&&r?.validation?.passed!==true;
      if(!r || r.validation?.mock === true) conflict('当前请求没有可采用的图片结果');
      if(acceptedRejectedPreview&&input.acceptRejectedResult!==true)conflict('请明确确认采用未通过自动验收的结果');
      if(!acceptedRejectedPreview&&r.validation?.passed!==true)conflict('图片校验未通过');
      const output=(await c.query('SELECT * FROM assets WHERE id=$1 AND task_id=$2',[r.asset_id,e.task_id])).rows[0];
      if(!output || imageHash(await readFile(editStoragePath(storageRoot,output.storage_path)))!==output.sha256 || output.sha256!==r.validation.integrity?.sha256) conflict('预览图片完整性校验失败');
      if(acceptedRejectedPreview)await c.query("UPDATE assets SET asset_role='DELIVERY' WHERE id=$1 AND task_id=$2",[output.id,e.task_id]);
      await withdrawReadyDeliveryEntries(c,e.task_id,'IMAGE_MANUAL_EDIT_ACCEPTED');
      let adoptedRunId=r.image_run_id;
      if(editSource.currentRun.id !== e.source_image_run_id) {
        const mergedRunId=randomUUID();
        const mergedResult=replaceImagePage(editSource.currentRun.result,e.target_page,output);
        mergedResult.images[e.target_page-1].imageEditRequiredText=r.validation.requiredText;
        mergedResult.images[e.target_page-1].imageEditDisclosure=r.validation.disclosure?.added??null;
        mergedResult.processing={type:e.operation,editId:e.id,parentRunId:editSource.currentRun.id,
          sourceRunId:e.source_image_run_id,previewRunId:r.image_run_id};
        mergedResult.imageEditValidation=r.validation;
        await c.query("INSERT INTO image_runs(id,task_id,copy_revision_id,status,image_production_chain_id,result,finished_at) VALUES($1,$2,$3,'COMPLETED',$1,$4,now())",[mergedRunId,e.task_id,e.copy_revision_id,mergedResult]);
        for(const assetId of imageAssetIds(mergedResult)) {
          const member=await c.query("INSERT INTO image_run_asset_members(image_run_id,asset_id) SELECT $1,id FROM assets WHERE id=$2 AND task_id=$3 AND asset_role='DELIVERY' RETURNING asset_id",[mergedRunId,assetId,e.task_id]);
          if(member.rowCount!==1)conflict('图集包含不属于当前任务的交付资产');
        }
        adoptedRunId=mergedRunId;
      } else if(acceptedRejectedPreview) {
        const promoted=await c.query("UPDATE image_runs SET status='COMPLETED' WHERE id=$1 AND task_id=$2 AND status='FAILED' RETURNING id",[adoptedRunId,e.task_id]);
        if(promoted.rowCount!==1)conflict('失败预览对应的图片版本不可采用');
      }
      await c.query('UPDATE image_edit_results SET adopted=true,image_run_id=$2 WHERE request_id=$1',[id,adoptedRunId]);
      await c.query(`UPDATE tasks SET
        current_image_run_id=$2,state='MANUAL_ARCHIVE',current_stage='MANUAL_ARCHIVE',
        image_qc_released_approval_event_id=NULL,image_qc_legacy_accepted=false,
        image_reviewed_at=NULL,image_reviewed_by_user_id=NULL,
        progress_message='图片修改已采用，请重新提交图片初审',updated_at=now() WHERE id=$1`,[e.task_id,adoptedRunId]);
    }
    const next={queue:'QUEUED',retry:'QUEUED','apply-suggestion':'QUEUED',cancel:'CANCELLED',reject:'REJECTED',accept:'ACCEPTED'}[action];
    let config=usesBillableModel&&input.confirmation==='LIVE_IMAGE_COST_ACCEPTED'?{...e.config,confirmation:'LIVE_IMAGE_COST_ACCEPTED'}:e.config;
    let auditDetail=acceptedRejectedPreview?{acceptedRejectedPreview:true,validationPassed:false}:{};
    if(action==='retry') {
      if(retryResolution.targetedRepair) {
        const localRepair=retryResolution.localRepair;
        config={...config,localRepair};
        auditDetail={targetedRepair:true,baseAssetId:localRepair.baseAssetId,attempt:localRepair.attempt,
          failureCodes:localRepair.failureCodes,repairInstruction:localRepair.repairInstruction,
          repairRegions:localRepair.repairRegions};
      } else if(config.localRepair) {
        const {localRepair:_discardedRepair,...originalRetryConfig}=config;
        config=originalRetryConfig;
      }
    }
    if(action==='apply-suggestion') {
      const choice=input.suggestionId==null?null:selectLocalEditAlternative(e,input.suggestionId);
      if(choice && (e.validation?.stage!=='LOCAL_EDIT_SUGGESTION'||e.validation.canEdit!==true)) {
        // Rewording a blocked request must re-run localization, never adopt its unsafe regions.
        const {localPlan:_oldPlan,localRepair:_oldRepair,...unplanned}=config;
        config={...unplanned,instruction:choice.instruction,mask:null};
        auditDetail={originalInstruction:e.config.instruction,suggestedInstruction:choice.instruction,requiresPreflight:true};
      } else {
        const plan=localSuggestionPlan(choice?{...e.validation,suggestedInstruction:choice.instruction}:e.validation,e.config.instruction);
        config={...config,instruction:plan.suggestedInstruction,mask:null,
          localPlan:{...plan,acceptedAt:new Date().toISOString(),acceptedBy:username}};
        auditDetail={originalInstruction:plan.originalInstruction,suggestedInstruction:plan.suggestedInstruction,
          operationType:plan.operationType,editRegions:plan.editRegions,model:plan.model};
      }
      if(choice) {
        config={...config,localAlternative:{id:choice.id,title:choice.title,
          originalInstruction:e.config.localAlternative?.originalInstruction??e.config.localPlan?.originalInstruction??e.config.instruction}};
        auditDetail={...auditDetail,suggestionId:choice.id,suggestionTitle:choice.title};
      }
    }
    const inheritedDisclosure=['retry','apply-suggestion'].includes(action)&&e.operation==='AI_LOCAL'
      ?imagePageDisclosure(editSource?.run?.result,Number(e.target_page)):null;
    if(inheritedDisclosure&&requestsDisclosureRemoval(config.instruction,inheritedDisclosure.text)) {
      config=disclosureRemovalConfig(config);
    }
    const updated=(await c.query("UPDATE image_edit_requests SET status=$2,config=$3,version=version+1,error=NULL,validation=CASE WHEN $2='QUEUED' THEN NULL ELSE validation END,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 RETURNING *",[id,next,config])).rows[0];
    if(action==='cancel'&&e.execution_id)await c.query(`UPDATE task_executions SET
      status='ABANDONED',stage='CANCELLED',progress_message='图片修改已取消',
      last_activity_at=now(),finished_at=now()
      WHERE id=$1 AND status='RUNNING'`,[e.execution_id]);
    await audit(c,e.task_id,id,action,username,reason,requestId,auditDetail);
    return updated;
  }
  return {
    get,
    async asset(id,taskId) { const a=(await pool.query('SELECT * FROM assets WHERE id=$1 AND task_id=$2',[normalizeTaskId(id),normalizeTaskId(taskId)])).rows[0];if(!a)throw new ControlPlaneNotFoundError('asset not found');return a; },
    async executorContext(executionId,editId,leaseToken) {
      return tx(async c=>loadContext(c,await lockedExecutorEdit(c,executionId,editId,leaseToken)));
    },
    async executorAsset(executionId,editId,leaseToken,assetId) {
      return tx(async c=>{
        const e=await lockedExecutorEdit(c,executionId,editId,leaseToken);
        const context=await loadContext(c,e);
        const allowed=new Set([Number(context.source.id),...context.refs.map(asset=>Number(asset.id))]);
        if(context.repairSource)allowed.add(Number(context.repairSource.id));
        if(context.restored)for(const image of context.restored.result?.images??[]) {
          const id=Number(image.deliveryAssetId??image.assetId);
          if(Number.isSafeInteger(id))allowed.add(id);
        }
        const normalized=normalizeTaskId(assetId);
        if(!allowed.has(normalized))throw new ControlPlaneAuthorizationError('该资产不属于当前图片修改执行');
        const asset=(await c.query('SELECT * FROM assets WHERE id=$1 AND task_id=$2',[normalized,e.task_id])).rows[0];
        if(!asset)throw new ControlPlaneNotFoundError('asset not found');
        const bytes=await readFile(editStoragePath(storageRoot,asset.storage_path));
        if(imageHash(bytes)!==asset.sha256)throw new Error('资产完整性校验失败');
        return {asset,bytes};
      });
    },
    async heartbeatExecutor(executionId,editId,leaseToken) {
      return tx(async c=>{
        const e=await lockedExecutorEdit(c,executionId,editId,leaseToken);
        await c.query("UPDATE image_edit_requests SET lease_expires_at=now()+interval '15 minutes' WHERE id=$1",[e.id]);
        await c.query("UPDATE task_executions SET heartbeat_at=now() WHERE id=$1 AND status='RUNNING'",[e.execution_id]);
        return true;
      });
    },
    async stageExecutorValidation(executionId,editId,leaseToken,validation) {
      if(!validation||typeof validation!=='object'||Array.isArray(validation)
        ||JSON.stringify(validation).length>2_000_000)throw new TypeError('图片修改校验结果无效');
      return tx(async c=>{
        const e=await lockedExecutorEdit(c,executionId,editId,leaseToken,{allowCompleted:true});
        if(e.status==='PREVIEW_READY')return e.validation;
        await c.query("UPDATE image_edit_requests SET validation=$2,updated_at=now() WHERE id=$1",[e.id,validation]);
        await c.query("UPDATE task_executions SET last_activity_at=now() WHERE id=$1 AND status='RUNNING'",[e.execution_id]);
        return validation;
      });
    },
    async completeExecutor(executionId,editId,leaseToken,bytes) {
      if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>20*1024*1024)throw new TypeError('图片修改结果无效');
      const prepared=await tx(async c=>{
        const e=await lockedExecutorEdit(c,executionId,editId,leaseToken,{allowCompleted:true});
        if(e.status==='PREVIEW_READY') {
          const result=(await c.query('SELECT * FROM image_edit_results WHERE request_id=$1',[e.id])).rows[0];
          if(!result)conflict('图片修改结果尚未完成');
          return {completed:{assetId:Number(result.asset_id),imageRunId:result.image_run_id}};
        }
        const context=await loadContext(c,e);
        return {e,validation:e.validation,originalResult:context.restored?.result??null};
      });
      if(prepared.completed)return prepared.completed;
      const mask=prepared.e.config.mask?await renderMask(prepared.e.config.mask):null;
      return this.complete(prepared.e,{bytes,mask,validation:prepared.validation,originalResult:prepared.originalResult});
    },
    async rejectExecutor(executionId,editId,leaseToken,bytes) {
      const prepared=await tx(async c=>{
        const e=await lockedExecutorEdit(c,executionId,editId,leaseToken,{allowFailed:true});
        if(e.status==='FAILED') {
          const result=(await c.query('SELECT * FROM image_edit_results WHERE request_id=$1',[e.id])).rows[0];
          if(!result)conflict('失败结果尚未保存');
          return {completed:{assetId:Number(result.asset_id),imageRunId:result.image_run_id,status:'FAILED'}};
        }
        return {e,validation:e.validation};
      });
      if(prepared.completed)return prepared.completed;
      if(!prepared.validation||prepared.validation.passed===true)throw new TypeError('失败图片校验记录无效');
      const failureMessage=String(prepared.validation.failureMessage??'图片修改结果未通过自动验收').slice(0,1000);
      const validation={...prepared.validation};delete validation.failureMessage;
      const error=Object.assign(new Error(failureMessage),{validation});
      return this.fail(prepared.e,error,{bytes});
    },
    async failExecutor(executionId,editId,leaseToken,input={}) {
      const e=await tx(c=>lockedExecutorEdit(c,executionId,editId,leaseToken,{allowCompleted:true}));
      if(e.status==='PREVIEW_READY')return e;
      const error=Object.assign(new Error(String(input.message??'图片修改失败').slice(0,1000)),{
        validation:input.validation??null,
        code:typeof input.code==='string'?input.code.slice(0,100):undefined,
        serviceCode:typeof input.serviceCode==='string'?input.serviceCode.slice(0,100):undefined,
        nonBillablePreflightFailure:input.nonBillablePreflightFailure===true,
      });
      await this.fail(e,error);
      return get(e.id);
    },
    async list(taskId, { pendingOnly = false } = {}) {
      return (await pool.query(`SELECT e.*,row_to_json(r) AS result,
        (SELECT json_agg(a ORDER BY a.id) FROM image_edit_events a WHERE a.edit_id=e.id) AS events
        FROM image_edit_requests e LEFT JOIN image_edit_results r ON r.request_id=e.id
        WHERE task_id=$1 ${pendingOnly ? 'AND e.status = ANY($2::text[])' : ''}
        ORDER BY e.created_at DESC, e.id ${pendingOnly ? '' : 'LIMIT 100'}`,
      pendingOnly ? [normalizeTaskId(taskId), PENDING_IMAGE_EDIT_STATUSES] : [normalizeTaskId(taskId)])).rows;
    },
    async resolvePending(taskId, input, actor) {
      taskId = normalizeTaskId(taskId);
      const username = actorName(actor);
      const requestId = normalizeUuid(input.requestId, 'requestId');
      const imageRunId = normalizeUuid(input.imageRunId, 'imageRunId');
      if (!Array.isArray(input.decisions) || !input.decisions.length || input.decisions.length > 500) {
        throw new TypeError('每次请选择 1 至 500 个图片修改');
      }
      const decisions = input.decisions.map(item => {
        if (!['accept', 'reject', 'cancel'].includes(item?.action)) throw new TypeError('无效的图片处理操作');
        return { id: normalizeUuid(item.id, 'editId'), version: boundedNumber(item.version, 1, 2147483647), action: item.action };
      }).sort((a, b) => a.id.localeCompare(b.id));
      if (new Set(decisions.map(item => item.id)).size !== decisions.length) throw new TypeError('图片修改不能重复提交');
      const snapshot = { imageRunId, decisions };
      return tx(async c => {
        await lockEditor(c, actor, taskId);
        const task = (await c.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [taskId])).rows[0];
        const prior = (await c.query('SELECT * FROM image_edit_events WHERE task_id=$1 AND request_id=$2', [taskId, requestId])).rows[0];
        if (prior) {
          if (prior.action !== 'RESOLVE_PENDING' || prior.actor !== username || !sameJson(prior.detail?.snapshot, snapshot)) {
            conflict('requestId 已用于其他操作');
          }
          return prior.detail.result;
        }
        if (!task || !['MANUAL_ARCHIVE', 'IMAGE_REWORK_PENDING', 'REVIEWED'].includes(task.state)
          || task.current_image_run_id !== imageRunId || task.current_execution_id || task.mandatory_copy_qc) {
          conflict('任务或图片版本已变化，请刷新待处理列表');
        }
        const rows = (await c.query('SELECT * FROM image_edit_requests WHERE task_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
          [taskId, decisions.map(item => item.id)])).rows;
        const edits = new Map(rows.map(row => [row.id, row]));
        const pages = new Set();
        for (const decision of decisions) {
          const edit = edits.get(decision.id);
          if (!edit || edit.version !== decision.version || !PENDING_IMAGE_EDIT_STATUSES.includes(edit.status)) {
            conflict('待处理图片修改已变化，请刷新后重新选择');
          }
          if (decision.action === 'accept') {
            if (pages.has(edit.target_page)) conflict(`第 ${edit.target_page} 页有多个采用结果，请只选择一个`);
            pages.add(edit.target_page);
          }
          if (decision.action !== 'cancel' && edit.status !== 'PREVIEW_READY') conflict('只有待确认的预览可以采用或拒绝');
        }
        // Reuse the single-edit checks and page merge inside one transaction. Any
        // stale source, invalid output or concurrent update rolls back the whole batch.
        for (const decision of decisions) {
          await applyAction(c, decision.id, decision.action, {
            version: decision.version, requestId: randomUUID(),
            reason: { accept: '初审前集中处理：预览符合要求，采用修改', reject: '初审前集中处理：拒绝修改，保留当前图片', cancel: '初审前集中处理：取消未完成的修改' }[decision.action],
          }, actor);
        }
        const current = (await c.query('SELECT current_image_run_id FROM tasks WHERE id=$1', [taskId])).rows[0];
        const result = { imageRunId: current.current_image_run_id, processed: decisions.length };
        await audit(c, taskId, null, 'RESOLVE_PENDING', username, '初审前集中处理图片修改', requestId, { snapshot, result });
        return result;
      });
    },
    async upload(taskId,input,actor) {
      const username=actorName(actor); taskId=normalizeTaskId(taskId);
      if(typeof input?.base64 !== 'string' || input.base64.length > 7_000_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(input.base64)) throw new TypeError('图片编码无效');
      const purpose=shortText(input.purpose,200), source=shortText(input.source,1000);
      const decoded=await decodeReference(Buffer.from(input.base64,'base64'),input.mediaType);
      return tx(async c=> {
        await lockEditor(c,actor,taskId);
        const task=(await c.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[taskId])).rows[0];
        if(!task?.current_image_run_id || !['MANUAL_ARCHIVE','IMAGE_REWORK_PENDING','REVIEWED'].includes(task.state)) conflict('当前任务无可编辑图片');
        const quota=(await c.query("SELECT count(*)::integer AS count, COALESCE(sum(byte_size),0)::bigint AS bytes FROM assets WHERE task_id=$1 AND asset_role='REFERENCE'",[taskId])).rows[0];
        if(quota.count >= 20 || Number(quota.bytes)+decoded.bytes.length > 50*1024*1024) throw new TypeError('任务参考图存储已达上限');
        const run=(await c.query('SELECT * FROM image_runs WHERE id=$1',[task.current_image_run_id])).rows[0];
        const asset=await storeAsset(c,taskId,run,decoded.bytes,'REFERENCE',{ ...decoded,bytes:undefined,uploadedBy:username,purpose,source });
        await audit(c,taskId,null,'UPLOAD_REFERENCE',username,source,null,{assetId:Number(asset.id),sha256:asset.sha256});
        return { id:Number(asset.id),sha256:asset.sha256,width:decoded.width,height:decoded.height,url:`/v1/assets/${asset.id}` };
      });
    },
    async create(taskId,input,actor) {
      const username=actorName(actor), requestedConfig=normalizeEdit(input); taskId=normalizeTaskId(taskId);
      return tx(async c=> {
        await lockEditor(c,actor,taskId);
        await c.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[taskId]);
        const prior=(await c.query('SELECT * FROM image_edit_requests WHERE task_id=$1 AND request_id=$2',[taskId,requestedConfig.requestId])).rows[0];
        if(prior) { if(JSON.stringify(requestEditConfig(prior.config)) !== JSON.stringify(JSON.parse(JSON.stringify(requestedConfig)))) {
          // jsonb key order differs: compare normalized content structurally.
          if(!sameJson(requestEditConfig(prior.config),requestedConfig)) conflict('requestId 已用于不同请求');
        } return prior; }
        const productionSettings=(await c.query("SELECT value FROM global_settings WHERE key='production'")).rows[0]?.value ?? {};
        const usesImageModel=requestedConfig.operation==='TEXT'||requestedConfig.operation.startsWith('AI_');
        const imageEditPrompt=usesImageModel?await publishedImageEditPrompt(c):null;
        const config={...requestedConfig,
          imageEditRepairMaxAttempts:normalizeImageEditRepairMaxAttempts(productionSettings.imageEditRepairMaxAttempts),
          ...(imageEditPrompt?{imageEditPrompt}:{}),
        };
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
        // Drafts and previews leave the approved version deliverable until acceptance.
        await audit(c,taskId,id,'CREATE',username,config.instruction || config.operation);
        return row;
      });
    },
    async action(id,action,input,actor) {
      const initial=await get(id);
      return tx(async c=> {
        await lockEditor(c,actor,initial.task_id);
        await c.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[initial.task_id]);
        return applyAction(c,initial.id,action,input,actor);
      });
    },
    async claim(worker) {
      shortText(worker,128);
      return tx(async c=> {
        // Expired attempts fail visibly; model calls are never silently replayed.
        const expired=await c.query("UPDATE image_edit_requests SET status='FAILED',error='执行租约过期，请确认后重试',version=version+1,lease_token=NULL,lease_expires_at=NULL WHERE status='RUNNING' AND lease_expires_at < now() RETURNING *");
        for(const item of expired.rows){
          if(item.execution_id)await c.query("UPDATE task_executions SET status='FAILED',stage='FAILED',progress_message='图片修改执行租约过期',error='图片修改执行租约过期',finished_at=now() WHERE id=$1 AND status='RUNNING'",[item.execution_id]);
          await audit(c,item.task_id,item.id,'LEASE_EXPIRED',worker,'执行租约过期');
        }
        const e=(await c.query(`SELECT edit.* FROM image_edit_requests edit
          JOIN tasks task ON task.id=edit.task_id
          WHERE edit.status='QUEUED' AND task.priority_paused=false
          ORDER BY task.priority_sort_at,task.id,edit.created_at,edit.id
          FOR UPDATE OF edit SKIP LOCKED LIMIT 1`)).rows[0];
        if(!e) return null;
        const row=(await c.query("UPDATE image_edit_requests SET status='RUNNING',attempts=attempts+1,version=version+1,claimed_by=$2,execution_id=NULL,lease_token=$3,lease_expires_at=now()+interval '15 minutes',updated_at=now() WHERE id=$1 RETURNING *",[e.id,worker,randomUUID()])).rows[0];
        await audit(c,e.task_id,e.id,'EXECUTE',worker,`attempt ${row.attempts}`); return row;
      });
    },
    async heartbeat(e) { return tx(async c=> {
      const updated=await c.query("UPDATE image_edit_requests SET lease_expires_at=now()+interval '15 minutes' WHERE id=$1 AND lease_token=$2 AND status='RUNNING' AND lease_expires_at>now() RETURNING execution_id",[e.id,e.lease_token]);
      if(updated.rows[0]?.execution_id)await c.query("UPDATE task_executions SET heartbeat_at=now() WHERE id=$1 AND status='RUNNING'",[updated.rows[0].execution_id]);
      return updated.rowCount===1;
    }); },
    async context(e) {
      return tx(c=>loadContext(c,e));
    },
    async readAsset(asset) { const bytes=await readFile(editStoragePath(storageRoot,asset.storage_path)); if(imageHash(bytes)!==asset.sha256) throw new Error('资产完整性校验失败'); return bytes; },
    async complete(e,{bytes,mask,validation,originalResult}) {
      return tx(async c=> {
        const source=await assertEditSource(c,Number(e.task_id),e.config,{allowCompatibleCurrentRun:true});
        const locked=(await c.query('SELECT * FROM image_edit_requests WHERE id=$1 FOR UPDATE',[e.id])).rows[0];
        if(!locked||locked.status!=='RUNNING' || locked.lease_token!==e.lease_token || new Date(locked.lease_expires_at)<=new Date()) conflict('执行已取消或租约过期');
        if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>20*1024*1024)throw new TypeError('图片修改结果无效');
        await previewMetadata(bytes);
        if(validation?.integrity?.sha256!==imageHash(bytes))throw new TypeError('图片修改结果与校验哈希不一致');
        if(validation?.passed!==true) throw new TypeError('校验未通过');
        const run=(await c.query("INSERT INTO image_runs(id,task_id,execution_id,copy_revision_id,status,image_production_chain_id,finished_at) VALUES($1,$2,$3,$4,'COMPLETED',$1,now()) RETURNING *",[randomUUID(),e.task_id,e.execution_id??null,e.copy_revision_id])).rows[0];
        const asset=await storeAsset(c,Number(e.task_id),run,bytes,'DELIVERY',{operation:e.operation,editId:e.id,targetPage:Number(e.target_page),disclosure:e.config.overlay?.disclosureType?{type:e.config.overlay.disclosureType,text:e.config.overlay.text}:null,validation},e.source_asset_id,
          orderedImageFileName(source.source.original_name,e.target_page,'image/png'));
        const maskAsset=mask?await storeAsset(c,Number(e.task_id),run,mask,'MASK',{editId:e.id},e.source_asset_id):null;
        const result=replaceImagePage(originalResult??source.run.result,e.target_page,asset);
        result.images[e.target_page-1].imageEditRequiredText=validation.requiredText;
        result.images[e.target_page-1].imageEditDisclosure=validation.disclosure?.added??null;
        result.processing={type:e.operation,editId:e.id,parentRunId:e.source_image_run_id};
        result.imageEditValidation=validation;
        await c.query('UPDATE image_runs SET result=$2 WHERE id=$1',[run.id,result]);
        for(const id of imageAssetIds(result)) {
          const member=await c.query("INSERT INTO image_run_asset_members(image_run_id,asset_id) SELECT $1,id FROM assets WHERE id=$2 AND task_id=$3 AND asset_role='DELIVERY' RETURNING asset_id",[run.id,id,e.task_id]);
          if(member.rowCount!==1)conflict('图集包含不属于当前任务的交付资产');
        }
        await c.query(`INSERT INTO image_edit_results(request_id,asset_id,image_run_id,mask_asset_id,validation,adopted)
          VALUES($1,$2,$3,$4,$5,false) ON CONFLICT(request_id) DO UPDATE SET
          asset_id=EXCLUDED.asset_id,image_run_id=EXCLUDED.image_run_id,mask_asset_id=EXCLUDED.mask_asset_id,
          validation=EXCLUDED.validation,adopted=false`,[e.id,asset.id,run.id,maskAsset?.id??null,validation]);
        await c.query("UPDATE image_edit_requests SET status='PREVIEW_READY',validation=$2,version=version+1,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",[e.id,validation]);
        if(e.execution_id)await c.query(`UPDATE task_executions SET
          status='SUCCEEDED',stage='COMPLETED',progress_percent=100,
          progress_message='图片修改预览已生成',last_activity_at=now(),finished_at=now()
          WHERE id=$1 AND status='RUNNING'`,[e.execution_id]);
        await audit(c,e.task_id,e.id,'PREVIEW_READY',e.claimed_by,'图片校验通过');
        return {assetId:Number(asset.id),imageRunId:run.id};
      });
    },
    async fail(e,error,preview={}) {
      if(preview?.bytes) return tx(async c=> {
        const source=await assertEditSource(c,Number(e.task_id),e.config,{allowCompatibleCurrentRun:true});
        const locked=(await c.query('SELECT * FROM image_edit_requests WHERE id=$1 FOR UPDATE',[e.id])).rows[0];
        if(!locked||locked.status!=='RUNNING'||locked.lease_token!==e.lease_token||new Date(locked.lease_expires_at)<=new Date())conflict('执行已取消或租约过期');
        const safeError=String(error?.message??'图片修改失败').replace(/sk-[\w-]+|Bearer\s+\S+/gu,'[REDACTED]').slice(0,1000);
        const {sha256}=await previewMetadata(preview.bytes);
        const validation={...(error?.validation??{}),passed:false,billedImageGeneration:true,
          integrity:{...(error?.validation?.integrity??{}),sha256}};
        const run=(await c.query("INSERT INTO image_runs(id,task_id,execution_id,copy_revision_id,status,image_production_chain_id,result,finished_at) VALUES($1,$2,$3,$4,'FAILED',$1,$5,now()) RETURNING *",
          [randomUUID(),e.task_id,e.execution_id??null,e.copy_revision_id,{failure:safeError}])).rows[0];
        const asset=await storeAsset(c,Number(e.task_id),run,preview.bytes,'REJECTED_PREVIEW',{
          operation:e.operation,editId:e.id,targetPage:Number(e.target_page),rejected:true,validation,
        },e.source_asset_id,orderedImageFileName(source.source.original_name,e.target_page,'image/png'));
        const result=replaceImagePage(source.run.result,e.target_page,asset);
        if(Array.isArray(validation.requiredText))result.images[e.target_page-1].imageEditRequiredText=validation.requiredText;
        if(validation.disclosure)result.images[e.target_page-1].imageEditDisclosure=validation.disclosure.added??null;
        result.processing={type:e.operation,editId:e.id,parentRunId:e.source_image_run_id,rejectedPreview:true};
        result.imageEditValidation=validation;
        await c.query('UPDATE image_runs SET result=$2 WHERE id=$1',[run.id,result]);
        for(const assetId of imageAssetIds(result)) {
          const member=await c.query("INSERT INTO image_run_asset_members(image_run_id,asset_id) SELECT $1,id FROM assets WHERE id=$2 AND task_id=$3 RETURNING asset_id",[run.id,assetId,e.task_id]);
          if(member.rowCount!==1)conflict('失败预览图集包含不属于当前任务的资产');
        }
        await c.query(`INSERT INTO image_edit_results(request_id,asset_id,image_run_id,mask_asset_id,validation,adopted)
          VALUES($1,$2,$3,NULL,$4,false) ON CONFLICT(request_id) DO UPDATE SET
          asset_id=EXCLUDED.asset_id,image_run_id=EXCLUDED.image_run_id,mask_asset_id=NULL,
          validation=EXCLUDED.validation,adopted=false`,[e.id,asset.id,run.id,validation]);
        await c.query("UPDATE image_edit_requests SET status='FAILED',error=$2,validation=$3,version=version+1,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",
          [e.id,safeError,validation]);
        if(e.execution_id)await c.query(`UPDATE task_executions SET
          status='FAILED',stage='FAILED',progress_message=$2::text,error=$2::text,
          last_activity_at=now(),finished_at=now()
          WHERE id=$1 AND status='RUNNING'`,[e.execution_id,safeError]);
        await audit(c,e.task_id,e.id,'FAILED',e.claimed_by,'执行或校验失败，已保留结果',null,
          {attemptRefunded:false,attempts:Number(locked.attempts),previewAssetId:Number(asset.id)});
        return {assetId:Number(asset.id),imageRunId:run.id,status:'FAILED'};
      });
      return tx(async c=> {
        const attemptRefunded=error?.nonBillablePreflightFailure===true;
        const safeError=String(error?.message??'图片修改失败').replace(/sk-[\w-]+|Bearer\s+\S+/gu,'[REDACTED]').slice(0,1000);
        const updated=await c.query("UPDATE image_edit_requests SET status='FAILED',error=$3,validation=$4,attempts=CASE WHEN $5 THEN GREATEST(attempts-1,0) ELSE attempts END,version=version+1,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2 AND status='RUNNING' RETURNING id,attempts,execution_id",[e.id,e.lease_token,safeError,error?.validation??null,attemptRefunded]);
        if(updated.rows[0]?.execution_id)await c.query(`UPDATE task_executions SET
          status='FAILED',stage='FAILED',progress_message=$2::text,error=$2::text,
          last_activity_at=now(),finished_at=now()
          WHERE id=$1 AND status='RUNNING'`,[updated.rows[0].execution_id,safeError]);
        const preflightServiceFailure=attemptRefunded&&(
          String(error?.validation?.stage??'').includes('SERVICE')
          || ['ALIGNMENT_SERVICE_FAILED','VISION_SERVICE_FAILED'].includes(String(error?.code??''))
        );
        const failureReason=attemptRefunded
          ?(preflightServiceFailure?'前置视觉服务失败，未计入执行次数':'前置视觉校验未通过，未计入执行次数')
          :'执行或校验失败';
        if(updated.rowCount) await audit(c,e.task_id,e.id,'FAILED',e.claimed_by,failureReason,null,
          {attemptRefunded,attempts:Number(updated.rows[0].attempts),code:error?.code??null,serviceCode:error?.serviceCode??null});
      });
    },
  };
}
function sameJson(a,b) {
  if(a===b)return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
  const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&sameJson(a[k],b[k]));
}
