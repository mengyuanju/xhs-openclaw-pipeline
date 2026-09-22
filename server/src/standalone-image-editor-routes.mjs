import { createStandaloneImageEditor } from './standalone-image-editor.mjs';

export function installStandaloneImageEditorRoutes(router,repository,storageRoot,{requestActor,requireJson,json}) {
  const service=createStandaloneImageEditor({pool:repository.pool,storageRoot});
  const actor=ctx=>requestActor(ctx,['ADMIN','USER']);
  const base='/v1/image-editor';
  router.get(`${base}/limits`,ctx=>{actor(ctx);json(ctx,200,service.limits);});
  router.get(`${base}/workspaces`,async ctx=>json(ctx,200,await service.list(actor(ctx),{
    offset:ctx.query.offset??0,limit:ctx.query.limit??20,queue:ctx.query.queue==='true',
  })));
  router.post(`${base}/workspaces/delete`,async ctx=>json(ctx,200,await service.remove(requireJson(ctx),actor(ctx))));
  router.post(`${base}/workspaces`,async ctx=>json(ctx,201,await service.create(requireJson(ctx),actor(ctx))));
  router.get(`${base}/workspaces/:workspaceId`,async ctx=>json(ctx,200,await service.detail(ctx.params.workspaceId,actor(ctx))));
  router.get(`${base}/workspaces/:workspaceId/image-edits`,async ctx=>json(ctx,200,await service.listEdits(ctx.params.workspaceId,actor(ctx))));
  router.post(`${base}/workspaces/:workspaceId/image-edits/batch`,async ctx=>json(ctx,201,await service.createBatch(ctx.params.workspaceId,requireJson(ctx),actor(ctx))));
  router.post(`${base}/workspaces/:workspaceId/image-edits`,async ctx=>json(ctx,201,await service.createEdit(ctx.params.workspaceId,requireJson(ctx),actor(ctx))));
  router.post(`${base}/workspaces/:workspaceId/image-edit-references`,async ctx=>json(ctx,201,await service.uploadReference(ctx.params.workspaceId,requireJson(ctx),actor(ctx))));
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
