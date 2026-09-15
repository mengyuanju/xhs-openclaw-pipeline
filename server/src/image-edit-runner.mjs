import { processImageEdit } from './image-edit-renderer.mjs';

function safeLog(log, method, message) {
  const safeMessage=String(message??'')
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/gu,'[REDACTED_API_KEY]')
    .replace(/\bBearer\s+\S+/giu,'Bearer [REDACTED_TOKEN]')
    .slice(0,2000);
  try { log?.[method]?.(safeMessage); } catch { /* Logging cannot stop queue processing. */ }
}

export function startImageEditProcessing({service,storageRoot},{
  intervalMs=2000,
  workerId=`control-plane-image-edit-${process.pid}`,
  processEdit=processImageEdit,
  log=console,
  runImmediately=true,
}={}) {
  if(!service||typeof service.claim!=='function')throw new TypeError('image editing service is required');
  if(typeof storageRoot!=='string'||!storageRoot)throw new TypeError('image edit storage root is required');
  if(!Number.isInteger(intervalMs)||intervalMs<100||intervalMs>60_000)throw new RangeError('image edit interval must be 100 to 60000 milliseconds');
  if(typeof processEdit!=='function')throw new TypeError('image edit processor is required');
  if(typeof runImmediately!=='boolean')throw new TypeError('runImmediately must be a boolean');
  let running=null,stopped=false;
  const tick=()=>{
    if(stopped||running)return running;
    running=Promise.resolve()
      .then(()=>processEdit({service,storageRoot,workerId}))
      .then(result=>{
        if(result?.status==='PREVIEW_READY')safeLog(log,'log','Image edit preview is ready.');
        else if(result?.status==='FAILED')safeLog(log,'error',`Image edit failed: ${result.error??'unknown error'}`);
        return result;
      })
      .catch(error=>{safeLog(log,'error',`Image edit queue failed: ${error?.message??error}`);return null;})
      .finally(()=>{running=null;});
    return running;
  };
  const timer=setInterval(()=>{void tick();},intervalMs);
  timer.unref();
  if(runImmediately)void tick();
  return async()=>{stopped=true;clearInterval(timer);await running;};
}
