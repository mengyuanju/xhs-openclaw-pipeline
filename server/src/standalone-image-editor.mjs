import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createImageEditingService, editTransaction, editStoragePath } from './image-editing.mjs';
import { decodeReference, imageHash, shortText } from '../../src/image-edit-pixels.mjs';
import { STANDALONE_IMAGE_EDITOR_LIMITS as LIMITS } from '../../src/standalone-image-editor-config.mjs';
import { normalizeTaskId, normalizeUuid, ControlPlaneAuthorizationError, ControlPlaneNotFoundError, ControlPlaneConflictError } from './domain.mjs';

const assetUrl = id => `/v1/image-editor/assets/${id}`;
const visibleWorkspace = alias => `NOT EXISTS (SELECT 1 FROM image_edit_events removed WHERE removed.task_id=${alias}.task_id AND removed.action='DELETE_WORKSPACE')`;
async function currentActor(c, actor) {
  if (!['ADMIN','USER'].includes(actor?.role)) throw new ControlPlaneAuthorizationError();
  const user = (await c.query(`SELECT id FROM app_users WHERE id=$1 AND username=$2 AND role=$3
    AND status='ACTIVE' AND credential_version=$4 FOR SHARE`,
  [actor.userId, actor.username, actor.role, actor.credentialVersion])).rows[0];
  if (!user) throw new ControlPlaneAuthorizationError('账号已失效，请重新登录');
}
export function createStandaloneImageEditor({ pool, storageRoot }) {
  const edits = createImageEditingService({ pool, storageRoot });
  async function access(id, actor, c = pool) {
    const row = (await c.query(`SELECT w.*,t.current_image_run_id,t.current_copy_revision_id
      FROM standalone_image_workspaces w JOIN tasks t ON t.id=w.task_id
      JOIN app_users u ON u.id=$2 AND u.username=$3 AND u.role=$4 AND u.status='ACTIVE' AND u.credential_version=$5
      WHERE w.task_id=$1 AND t.task_kind='STANDALONE_IMAGE_EDIT' AND ${visibleWorkspace('w')}`,
    [normalizeTaskId(id),actor.userId,actor.username,actor.role,actor.credentialVersion])).rows[0];
    if (!row) throw new ControlPlaneNotFoundError('图片编辑记录不存在或账号已失效');
    if (!['ADMIN','USER'].includes(actor?.role) || Number(row.owner_id) !== actor.userId) {
      throw new ControlPlaneAuthorizationError('不能访问其他账号的图片编辑记录');
    }
    return row;
  }
  async function workspaceStatus(id, c=pool) {
    const row=(await c.query(`SELECT status FROM image_edit_requests WHERE task_id=$1
      ORDER BY CASE status WHEN 'RUNNING' THEN 0 WHEN 'QUEUED' THEN 1 WHEN 'DRAFT' THEN 3 ELSE 2 END,
        created_at DESC,id DESC LIMIT 1`,[id])).rows[0];
    return row?.status??'UPLOADED';
  }
  // The original editor owns its transaction and staged-file cleanup. This
  // scoped pool adds our workspace guard immediately after BEGIN, holding the
  // same task lock as executor claims until the original transaction ends.
  function writablePool(id,actor) {
    const guardedPool={
      query:pool.query.bind(pool),
      async connect() {
        const c=await pool.connect();
        return {
          release:()=>c.release(),
          async query(sql,values) {
            const result=await c.query(sql,values);
            if(sql==='BEGIN') {
              // Keep the legacy editor's user -> task lock order.
              await c.query('SELECT id FROM app_users WHERE id=$1 FOR UPDATE',[actor.userId]);
              await c.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[normalizeTaskId(id)]);
              await access(id,actor,c);
              if(await workspaceStatus(id,c)==='RUNNING') {
                throw new ControlPlaneConflictError('IMAGE_EDITOR_RUNNING','图片正在生图中，仅支持查看，请完成后再编辑');
              }
            }
            return result;
          },
        };
      },
    };
    return guardedPool;
  }
  const writableEdits=(id,actor)=>createImageEditingService({pool:writablePool(id,actor),storageRoot});
  async function createBatch(id,input,actor) {
    if(!Array.isArray(input.edits)||!input.edits.length||input.edits.length>LIMITS.maxImages)throw new TypeError('请选择 1 至 5 张图片');
    if(new Set(input.edits.map(item=>Number(item.targetPage))).size!==input.edits.length)throw new TypeError('同一批次不能重复提交同一张图片');
    return editTransaction(writablePool(id,actor),async c=>{
      // create() writes only database rows. Join all child creates to this
      // transaction so no executor can claim a partially submitted image set.
      const joined={query:c.query.bind(c),release(){}};
      const joinedPool={query:joined.query,connect:async()=>({...joined,query:(sql,values)=>
        ['BEGIN','COMMIT','ROLLBACK'].includes(sql)?Promise.resolve({rows:[]}):joined.query(sql,values)})};
      const service=createImageEditingService({pool:joinedPool,storageRoot}),created=[];
      for(const item of input.edits)created.push(await service.create(id,item,actor));
      return created;
    });
  }
  async function detail(id, actor) {
    const workspace = await access(id, actor);
    const runs = (await pool.query(`SELECT id,result FROM image_runs WHERE task_id=$1
      AND status='COMPLETED' ORDER BY created_at DESC,id`, [workspace.task_id])).rows;
    const run = runs.find(value => value.id === workspace.current_image_run_id);
    const ids = (run?.result?.images ?? []).map(image => image.deliveryAssetId ?? image.assetId);
    const assets = (await pool.query('SELECT id,sha256 FROM assets WHERE task_id=$1 AND id=ANY($2::bigint[])', [workspace.task_id,ids])).rows;
    return { id:Number(workspace.task_id),title:workspace.title,limits:workspace.limits,status:await workspaceStatus(workspace.task_id),
      runId:workspace.current_image_run_id,copyRevisionId:Number(workspace.current_copy_revision_id),runs,
      assets:ids.map(id => { const a=assets.find(item=>Number(item.id)===Number(id));
        if (!a) throw new Error('上传图片记录不完整');
        return {id:Number(a.id),sha256:a.sha256,url:assetUrl(a.id)}; }) };
  }
  async function create(input, actor) {
    const requestId=normalizeUuid(input.requestId,'requestId');
    const title=shortText(input.title??'上传图片',200);
    if (!Array.isArray(input.images)||!input.images.length||input.images.length>LIMITS.maxImages) throw new TypeError('请上传 1 至 5 张图片');
    const images=[];
    for (const image of input.images) {
      if (typeof image.base64!=='string'||image.base64.length>Math.ceil(LIMITS.maxUploadBytes/3)*4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(image.base64)) throw new TypeError('上传图片编码或大小无效');
      const decoded=await decodeReference(Buffer.from(image.base64,'base64'),image.mediaType);
      if (decoded.width!==LIMITS.width||decoded.height!==LIMITS.height) throw new TypeError('原图必须为 1086×1448，不会自动拉伸或裁切');
      images.push(decoded);
    }
    const hash=imageHash(Buffer.from(JSON.stringify({title,images:images.map(image=>image.sha256)})));
    const paths=[];
    let id;
    try {
      id=await editTransaction(pool,async c=>{
        await currentActor(c,actor);
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`image-editor:${actor.userId}:${requestId}`]);
        const prior=(await c.query('SELECT task_id,upload_hash FROM standalone_image_workspaces WHERE owner_id=$1 AND request_id=$2',[actor.userId,requestId])).rows[0];
        if(prior) {
          if(prior.upload_hash!==hash)throw new ControlPlaneConflictError('UPLOAD_CONFLICT','相同请求编号对应不同上传内容');
          return Number(prior.task_id);
        }
        await c.query(`INSERT INTO executor_nodes(id,name,image_worker_enabled,last_seen_at)
          VALUES('standalone-image-upload','图片编辑上传入口',false,'epoch') ON CONFLICT(id) DO NOTHING`);
        // Protocol carrier, excluded from every business task list and workflow.
        const task=(await c.query(`INSERT INTO tasks(query,input,state,task_kind,created_by_node_id,
          created_by_user_id,assigned_to_user_id,assignment_source,assigned_at,current_stage)
          VALUES($1,$2,'MANUAL_ARCHIVE','STANDALONE_IMAGE_EDIT','standalone-image-upload',$3,$3,'MANUAL',now(),'STANDALONE_IMAGE_EDIT') RETURNING id`,
        [title,{source:'USER_UPLOAD'},actor.username])).rows[0];
        const taskId=Number(task.id),runId=randomUUID();
        // Empty page metadata is only the legacy execution envelope, not generated business copy.
        const revision=(await c.query(`INSERT INTO copy_revisions(task_id,revision,content,approved_at)
          VALUES($1,1,$2,now()) RETURNING id`,[taskId,{source:'USER_UPLOAD',imagePlan:images.map(()=>({kind:'detail',headline:'',subtitle:'',bullets:[],labels:[]}))}])).rows[0];
        await c.query(`INSERT INTO image_runs(id,task_id,copy_revision_id,status,image_production_chain_id)
          VALUES($1,$2,$3,'COMPLETED',$1)`,[runId,taskId,revision.id]);
        const directory=resolve(storageRoot,'standalone-image-editor',String(taskId));
        await mkdir(directory,{recursive:true});
        const members=[];
        for(const [index,image] of images.entries()) {
          const path=resolve(directory,`${randomUUID()}.png`);
          await writeFile(path,image.bytes,{flag:'wx'});paths.push(path);
          const a=(await c.query(`INSERT INTO assets(task_id,image_run_id,media_type,byte_size,sha256,storage_path,
            original_name,image_production_chain_id,artifact_key,origin_image_run_id,asset_role,edit_metadata)
            VALUES($1,$2,'image/png',$3,$4,$5,$6,$2,$7,$2,'DELIVERY',$8) RETURNING id`,
          [taskId,runId,image.bytes.length,image.sha256,path,`upload-${index+1}.png`,randomUUID(),
            {source:'USER_UPLOAD',uploadedBy:actor.username,originalSha256:image.originalSha256,originalMediaType:image.originalMediaType}])).rows[0];
          members.push({pageIndex:index+1,assetId:Number(a.id),deliveryAssetId:Number(a.id),url:assetUrl(a.id),sha256:image.sha256});
        }
        await c.query('UPDATE image_runs SET result=$2,finished_at=now() WHERE id=$1',[runId,{images:members,source:'USER_UPLOAD'}]);
        await c.query('UPDATE tasks SET current_copy_revision_id=$2,current_image_run_id=$3 WHERE id=$1',[taskId,revision.id,runId]);
        await c.query(`INSERT INTO standalone_image_workspaces(task_id,owner_id,request_id,upload_hash,title,limits)
          VALUES($1,$2,$3,$4,$5,$6)`,[taskId,actor.userId,requestId,hash,title,LIMITS]);
        return taskId;
      });
    } catch(error) {await Promise.all(paths.map(path=>unlink(path).catch(()=>{})));throw error;}
    return detail(id,actor);
  }
  async function editAccess(id,actor) {const edit=await edits.get(id);await access(edit.task_id,actor);return edit;}
  async function remove(input,actor) {
    if(!Array.isArray(input.workspaceIds)||!input.workspaceIds.length||input.workspaceIds.length>100)throw new TypeError('请选择 1 至 100 条图片编辑记录');
    const ids=[...new Set(input.workspaceIds.map(normalizeTaskId))].sort((a,b)=>a-b);
    const requestId=normalizeUuid(input.requestId,'requestId');
    return editTransaction(pool,async c=>{
      await c.query('SELECT id FROM app_users WHERE id=$1 FOR UPDATE',[actor.userId]);
      await currentActor(c,actor);
      const rows=(await c.query(`SELECT w.task_id,w.owner_id,${visibleWorkspace('w')} AS visible
        FROM standalone_image_workspaces w JOIN tasks t ON t.id=w.task_id
        WHERE w.task_id=ANY($1::bigint[]) AND t.task_kind='STANDALONE_IMAGE_EDIT'
        ORDER BY t.id FOR UPDATE OF t`,[ids])).rows;
      if(rows.length!==ids.length)throw new ControlPlaneNotFoundError('图片编辑记录不存在');
      if(rows.some(row=>Number(row.owner_id)!==actor.userId))throw new ControlPlaneAuthorizationError('只能删除自己创建的图片编辑记录');
      const active=(await c.query("SELECT id FROM image_edit_requests WHERE task_id=ANY($1::bigint[]) AND status='RUNNING' LIMIT 1",[ids])).rows[0];
      if(active)throw new ControlPlaneConflictError('IMAGE_EDITOR_RUNNING','所选图片正在生图中，仅支持查看，完成后才能删除');
      for(const row of rows.filter(item=>item.visible)) {
        // Audit-backed removal keeps assets/history intact while preventing
        // every user-facing access and any later executor claim.
        await c.query('UPDATE tasks SET priority_paused=true WHERE id=$1',[row.task_id]);
        await c.query(`UPDATE image_edit_requests SET status='CANCELLED',version=version+1,
          lease_token=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE task_id=$1 AND status IN ('DRAFT','QUEUED')`,[row.task_id]);
        await c.query(`INSERT INTO image_edit_events(task_id,action,actor,reason,request_id,detail)
          VALUES($1,'DELETE_WORKSPACE',$2,'删除图片编辑',$3,$4)`,[row.task_id,actor.username,requestId,{workspaceIds:ids}]);
      }
      return {deletedIds:ids};
    });
  }
  return {
    limits:LIMITS,access,detail,create,remove,createBatch,
    async list(actor,{offset=0,limit=20,queue=false}={}) {
      if(!['ADMIN','USER'].includes(actor?.role))throw new ControlPlaneAuthorizationError();
      offset=Number(offset);limit=Number(limit);
      if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new TypeError('分页参数无效');
      await currentActor(pool,actor);
      const filter=`w.owner_id=$1 AND ${visibleWorkspace('w')} ${queue?"AND EXISTS(SELECT 1 FROM image_edit_requests e WHERE e.task_id=w.task_id AND e.status<>'DRAFT')":''}`;
      const values=[actor.userId];
      const total=Number((await pool.query(`SELECT count(*) FROM standalone_image_workspaces w WHERE ${filter}`,values)).rows[0].count);
      const rows=(await pool.query(`SELECT w.task_id,w.title,w.created_at,u.display_name AS owner,
        e.status,e.error,x.node_id,
        (SELECT count(*) FROM image_edit_requests a WHERE a.task_id=w.task_id AND a.status='QUEUED') AS queued,
        (SELECT count(*) FROM image_edit_requests a WHERE a.task_id=w.task_id AND a.status='RUNNING') AS running
        FROM standalone_image_workspaces w JOIN app_users u ON u.id=w.owner_id
        LEFT JOIN LATERAL (SELECT * FROM image_edit_requests e WHERE e.task_id=w.task_id ORDER BY CASE e.status WHEN 'RUNNING' THEN 0 WHEN 'QUEUED' THEN 1 WHEN 'DRAFT' THEN 3 ELSE 2 END,e.created_at DESC,e.id DESC LIMIT 1) e ON true
        LEFT JOIN task_executions x ON x.id=e.execution_id
        WHERE ${filter} ORDER BY w.task_id DESC LIMIT $2 OFFSET $3`,[...values,limit,offset])).rows;
      return {total,items:rows.map(row=>({id:Number(row.task_id),title:row.title,owner:row.owner,createdAt:row.created_at,
        status:Number(row.running)>0?'RUNNING':Number(row.queued)>0?'QUEUED':row.status??'UPLOADED',error:row.error,nodeId:row.node_id}))};
    },
    async listEdits(id,actor) {
      await access(id,actor);
      const items=await edits.list(id);
      const refs=(await pool.query("SELECT id,sha256 FROM assets WHERE task_id=$1 AND asset_role='REFERENCE'",[id])).rows;
      return items.map(edit=>({...edit,referenceAssets:refs.filter(ref=>edit.config.references.some(value=>Number(value.assetId)===Number(ref.id)))
        .map(ref=>({id:Number(ref.id),sha256:ref.sha256,url:assetUrl(ref.id),purpose:edit.config.references.find(value=>Number(value.assetId)===Number(ref.id)).purpose}))}));
    },
    async getEdit(id,actor) {return editAccess(id,actor);},
    async createEdit(id,input,actor) {await access(id,actor);return writableEdits(id,actor).create(id,input,actor);},
    async uploadReference(id,input,actor) {await access(id,actor);const a=await writableEdits(id,actor).upload(id,input,actor);return {...a,url:assetUrl(a.id)};},
    async action(id,action,input,actor) {const edit=await editAccess(id,actor);return writableEdits(edit.task_id,actor).action(id,action,input,actor);},
    async asset(id,actor) {
      const asset=(await pool.query('SELECT * FROM assets WHERE id=$1',[normalizeTaskId(id)])).rows[0];
      if(!asset)throw new ControlPlaneNotFoundError('图片不存在');
      await access(asset.task_id,actor);
      const bytes=await readFile(editStoragePath(storageRoot,asset.storage_path));
      if(imageHash(bytes)!==asset.sha256)throw new Error('图片完整性校验失败');
      return {asset,bytes};
    },
  };
}
