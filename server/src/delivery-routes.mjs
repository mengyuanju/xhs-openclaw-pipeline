import { createReadStream } from 'node:fs';
import { listDeliveryItems, confirmDeliveryItems } from './delivery-ledger.mjs';
import { createDeliveryArchiveService } from './delivery-archives.mjs';
import { ControlPlaneConflictError } from './domain.mjs';

export function installSharedDeliveryRoutes(router, repository, storageRoot, {requestActor,requireJson,json,assertCurrentActorIdentity}) {
  const service=createDeliveryArchiveService({pool:repository.pool,storageRoot});
  if (repository.pool?.connect) void service.kick();
  const actorFor=ctx=>{
    const actor=requestActor(ctx,['ADMIN','USER']);
    if(!repository.pool?.connect)throw new ControlPlaneConflictError('SHARED_DELIVERY_UNAVAILABLE','中心服务尚未启用共享交付，请升级后重试');
    ctx.set('Cache-Control','private, no-store');
    return actor;
  };
  router.get('/v1/delivery-items',async ctx=>{
    const actor=actorFor(ctx);json(ctx,200,await listDeliveryItems(repository.pool,ctx.query,actor));
  });
  router.post('/v1/delivery-items/confirm',async ctx=>{
    const actor=actorFor(ctx);await assertCurrentActorIdentity(repository,actor);
    json(ctx,200,await confirmDeliveryItems(repository.pool,requireJson(ctx),actor));
  });
  router.post('/v1/delivery-archives/preview',async ctx=>{
    const actor=actorFor(ctx);json(ctx,200,await service.preview(requireJson(ctx),actor));
  });
  router.post('/v1/delivery-archives',async ctx=>{
    const actor=actorFor(ctx);await assertCurrentActorIdentity(repository,actor);
    json(ctx,201,await service.create(requireJson(ctx),actor));
  });
  router.get('/v1/delivery-archives',async ctx=>{
    const actor=actorFor(ctx);json(ctx,200,await service.list(ctx.query,actor));
  });
  router.get('/v1/delivery-archives/:id',async ctx=>{
    const actor=actorFor(ctx);json(ctx,200,await service.get(ctx.params.id,actor));
  });
  router.post('/v1/delivery-archives/:id/retry',async ctx=>{
    const actor=actorFor(ctx);await assertCurrentActorIdentity(repository,actor);
    json(ctx,200,await service.retry(ctx.params.id,actor));
  });
  router.get('/v1/delivery-archives/:id/download/:part',async ctx=>{
    const actor=actorFor(ctx),artifact=await service.download(ctx.params.id,ctx.params.part,actor);
    await assertCurrentActorIdentity(repository,actor);
    if(ctx.method!=='HEAD')ctx.res.once('finish',()=>{void artifact.record().catch(error=>console.error('delivery download record:',error.message));});
    ctx.status=200;ctx.type='application/zip';ctx.length=artifact.byteSize;
    ctx.set('Content-Disposition',`attachment; filename="delivery.zip"; filename*=UTF-8''${encodeURIComponent(artifact.fileName)}`);
    ctx.body=createReadStream(artifact.path);
  });
  return ()=>service.dispose();
}
