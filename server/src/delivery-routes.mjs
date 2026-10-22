import { createReadStream } from 'node:fs';
import { once } from 'node:events';
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
  router.head('/v1/delivery-archives/:id/download/:part',async ctx=>{
    const actor=actorFor(ctx),artifact=await service.describeDownload(ctx.params.id,ctx.params.part,actor);
    await assertCurrentActorIdentity(repository,actor);
    ctx.status=200;ctx.type='application/zip';
    ctx.set('Content-Disposition',`attachment; filename="delivery.zip"; filename*=UTF-8''${encodeURIComponent(artifact.fileName)}`);
  });
  router.get('/v1/delivery-archives/:id/download/:part',async ctx=>{
    const actor=actorFor(ctx),controller=new AbortController();
    let artifact,source,cleanupFlight;
    const cleanup=()=>cleanupFlight??=Promise.resolve().then(async()=>{
      ctx.req.off('aborted',onAborted);ctx.res.off('close',onClosed);
      if(source&&!source.closed){const closed=once(source,'close').catch(()=>{});source.destroy();await closed;}
      await artifact?.cleanup();
    });
    const cleanInBackground=()=>{void cleanup().catch(error=>console.error('delivery download cleanup:',error.message));};
    const onAborted=()=>controller.abort(new DOMException('delivery client disconnected','AbortError'));
    const onClosed=()=>{if(!ctx.res.writableFinished)onAborted();cleanInBackground();};
    ctx.req.once('aborted',onAborted);ctx.res.once('close',onClosed);
    try {
      await assertCurrentActorIdentity(repository,actor);
      artifact=await service.download(ctx.params.id,ctx.params.part,actor,{signal:controller.signal});
      await assertCurrentActorIdentity(repository,actor);
      controller.signal.throwIfAborted();artifact.signal.throwIfAborted();
      source=createReadStream(artifact.path,{signal:artifact.signal});
      source.once('close',cleanInBackground);
      ctx.res.once('finish',()=>{
        void artifact.record().catch(error=>console.error('delivery download record:',error.message));
        cleanInBackground();
      });
      ctx.status=200;ctx.type='application/zip';ctx.length=artifact.byteSize;
      ctx.set('Content-Disposition',`attachment; filename="delivery.zip"; filename*=UTF-8''${encodeURIComponent(artifact.fileName)}`);
      ctx.body=source;
    } catch(error) {await cleanup();throw error;}
  });
  return ()=>service.dispose();
}
