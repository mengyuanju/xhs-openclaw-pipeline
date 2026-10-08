import { createStandaloneImageEditor } from './standalone-image-editor.mjs';
import { STANDALONE_IMAGE_EDITOR_LIMITS } from '../../src/standalone-image-editor-config.mjs';

export function installStandaloneImageEditorRoutes(router,repository,storageRoot,{requestActor,requireJson,json,onProgrammaticReady,readBody}) {
  const service=createStandaloneImageEditor({pool:repository.pool,storageRoot,onProgrammaticReady});
  const actor=ctx=>requestActor(ctx,['ADMIN','USER']);
  const base='/v1/image-editor';
  router.get(`${base}/limits`,ctx=>{actor(ctx);json(ctx,200,{...service.limits,binaryUploadVersion:1});});
  router.post(`${base}/uploads/:requestId/:index`,async ctx=>{
    const current=actor(ctx);
    const mediaType=String(ctx.get('Content-Type')).split(';')[0].trim();
    if(!STANDALONE_IMAGE_EDITOR_LIMITS.formats.includes(mediaType))throw new TypeError('仅支持 PNG/JPEG/WebP');
    const controller=new AbortController();
    const aborted=()=>controller.abort(new DOMException('Upload disconnected','AbortError'));
    const closed=()=>{if(!ctx.res.writableEnded)aborted();};
    ctx.req.once('aborted',aborted);ctx.res.once('close',closed);
    if(ctx.req.aborted||ctx.res.destroyed)aborted();
    try {
      const result=await service.uploads.run(async()=>{
        const bytes=await readBody(ctx.req,STANDALONE_IMAGE_EDITOR_LIMITS.maxUploadBytes);
        return service.uploads.stage(ctx.params.requestId,ctx.params.index,bytes,mediaType,current,{signal:controller.signal});
      },{signal:controller.signal});
      json(ctx,201,result);
    } finally {ctx.req.off('aborted',aborted);ctx.res.off('close',closed);}
  });
  router.delete(`${base}/uploads/:requestId`,async ctx=>json(ctx,200,await service.uploads.cancel(ctx.params.requestId,actor(ctx))));
  router.get(`${base}/workspaces`,async ctx=>json(ctx,200,await service.list(actor(ctx),{
    offset:ctx.query.offset??0,limit:ctx.query.limit??20,queue:ctx.query.queue==='true',
  })));
  router.post(`${base}/workspaces/delete`,async ctx=>json(ctx,200,await service.remove(requireJson(ctx),actor(ctx))));
  router.post(`${base}/workspaces`,async ctx=>{
    const current=actor(ctx),input=requireJson(ctx),controller=new AbortController();
    const aborted=()=>controller.abort(new DOMException('Upload disconnected','AbortError'));
    const closed=()=>{if(!ctx.res.writableEnded)aborted();};
    ctx.req.once('aborted',aborted);ctx.res.once('close',closed);
    if(ctx.req.aborted||ctx.res.destroyed)aborted();
    try {json(ctx,201,await service.uploads.run(()=>service.create(input,current),{signal:controller.signal}));}
    finally {ctx.req.off('aborted',aborted);ctx.res.off('close',closed);}
  });
  router.get(`${base}/workspaces/:workspaceId`,async ctx=>json(ctx,200,await service.detail(ctx.params.workspaceId,actor(ctx))));
  router.get(`${base}/workspaces/:workspaceId/image-edits`,async ctx=>json(ctx,200,await service.listEdits(ctx.params.workspaceId,actor(ctx))));
  router.get(`${base}/workspaces/:workspaceId/image-edits/state`,async ctx=>json(ctx,200,await service.editState(ctx.params.workspaceId,actor(ctx),{
    ids:ctx.query.ids?String(ctx.query.ids).split(','):[],
  })));
  router.post(`${base}/workspaces/:workspaceId/image-edits/batch`,async ctx=>json(ctx,201,await service.createBatch(ctx.params.workspaceId,requireJson(ctx),actor(ctx))));
  router.post(`${base}/workspaces/:workspaceId/image-edits/batch/:batchId/accept`,async ctx=>json(ctx,200,await service.acceptBatch(ctx.params.workspaceId,ctx.params.batchId,requireJson(ctx),actor(ctx))));
  router.post(`${base}/workspaces/:workspaceId/image-edits`,async ctx=>json(ctx,201,await service.createEdit(ctx.params.workspaceId,requireJson(ctx),actor(ctx))));
  router.post(`${base}/workspaces/:workspaceId/image-edit-references`,async ctx=>json(ctx,201,await service.uploadReference(ctx.params.workspaceId,requireJson(ctx),actor(ctx))));
  router.delete(`${base}/workspaces/:workspaceId/image-edit-references/:assetId`,async ctx=>json(ctx,200,await service.deleteReference(ctx.params.workspaceId,ctx.params.assetId,actor(ctx))));
  router.post(`${base}/workspaces/:workspaceId/image-versions/:runId/restore`,async ctx=>json(ctx,201,await service.createEdit(ctx.params.workspaceId,
    {...requireJson(ctx),operation:'RESTORE',restoreRunId:ctx.params.runId},actor(ctx))));
  router.get(`${base}/edits/:editId`,async ctx=>json(ctx,200,await service.getEdit(ctx.params.editId,actor(ctx))));
  for(const action of ['queue','retry','apply-suggestion','cancel','accept','reject']) {
    router.post(`${base}/edits/:editId/${action}`,async ctx=>json(ctx,200,await service.action(ctx.params.editId,action,requireJson(ctx),actor(ctx))));
  }
  router.get(`${base}/assets/:assetId`,async ctx=>{
    const {asset,bytes}=await service.asset(ctx.params.assetId,actor(ctx));
    ctx.type='image/png';ctx.set('Cache-Control','private, no-store');
    ctx.set('X-Content-Type-Options','nosniff');
    if(ctx.query.download==='true')ctx.set('Content-Disposition',`attachment; filename="edited-image-${asset.id}.png"`);
    ctx.body=bytes;
  });
  return service;
}
