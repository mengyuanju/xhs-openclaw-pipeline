import { processImageEdit } from './image-edit-renderer.mjs';
import { normalizeUuid } from './domain.mjs';

export function programmaticConcurrency(value = 2) {
  const concurrency = Number(value);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) {
    throw new RangeError('PROGRAMMATIC_IMAGE_CONCURRENCY must be 1 or 2');
  }
  return concurrency;
}

export function safeProgrammaticLog(log, method, message) {
  const safe = String(message ?? '')
    .replace(/\b(postgres(?:ql)?:\/\/)[^@\s]+@/giu, '$1[REDACTED]@')
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/gu, '[REDACTED_API_KEY]')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [REDACTED_TOKEN]')
    .slice(0, 2000);
  try { log?.[method]?.(safe); } catch { /* Logging cannot stop processing. */ }
}

export function startProgrammaticImageEditProcessing({ service, storageRoot }, {
  concurrency = 2,
  intervalMs = 2000,
  workerId = `programmatic-image-edit-${process.pid}`,
  processEdit = processImageEdit,
  log = console,
  runImmediately = true,
} = {}) {
  concurrency = programmaticConcurrency(concurrency);
  if (typeof service?.claimProgrammatic !== 'function' || typeof service?.recoverProgrammatic !== 'function') {
    throw new TypeError('programmatic image editing service is required');
  }
  if (typeof storageRoot !== 'string' || !storageRoot) throw new TypeError('storage root is required');
  if (typeof processEdit !== 'function') throw new TypeError('programmatic processor is required');
  if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000) {
    throw new RangeError('programmatic scan interval must be 100 to 60000 milliseconds');
  }
  const requested = new Set();
  const active = new Map();
  let stopped = false, pumping = null, revision = 0, lastRecovery = 0;

  function schedule() {
    if (!stopped) queueMicrotask(() => { void pump(); });
  }
  function launch(edit) {
    const work = Promise.resolve().then(async () => {
      // This guard also protects against accidental use of a generic claim method.
      if (edit.operation !== 'SVG_DISCLOSURE' || edit.status !== 'RUNNING' || edit.execution_id != null) {
        throw new TypeError('only locally claimed programmatic disclosures may run here');
      }
      return processEdit({ service, storageRoot, workerId, edit });
    }).then(result => {
      if (result?.status === 'PREVIEW_READY') safeProgrammaticLog(log, 'log', 'Programmatic image edit preview is ready.');
      else if (result?.status === 'FAILED') safeProgrammaticLog(log, 'error', `Programmatic image edit failed: ${result.error}`);
    }).catch(error => {
      safeProgrammaticLog(log, 'error', `Programmatic image edit failed: ${error.message}`);
    }).finally(() => {
      active.delete(edit.id);
      revision += 1;
      schedule();
    });
    active.set(edit.id, work);
  }
  function pump() {
    if (stopped || pumping || active.size >= concurrency) return pumping;
    const startedRevision = revision;
    pumping = Promise.resolve().then(async () => {
      if (Date.now() - lastRecovery >= 15_000) {
        await service.recoverProgrammatic(workerId);
        lastRecovery = Date.now();
      }
      while (!stopped && active.size < concurrency) {
        const editId = requested.values().next().value;
        if (editId) requested.delete(editId);
        const edit = await service.claimProgrammatic(workerId, { editId: editId ?? null, maxConcurrency: concurrency });
        if (edit) launch(edit);
        else if (!editId) break;
      }
    }).catch(error => {
      safeProgrammaticLog(log, 'error', `Programmatic image edit queue failed: ${error.message}`);
    }).finally(() => {
      pumping = null;
      if (revision !== startedRevision && active.size < concurrency) schedule();
    });
    return pumping;
  }
  function wake(editIds = []) {
    if (stopped) return false;
    if (!Array.isArray(editIds) || editIds.length > 500) throw new TypeError('at most 500 programmatic edit IDs are allowed');
    for (const id of editIds) {
      const normalized = normalizeUuid(id, 'editId');
      if (!active.has(normalized)) requested.add(normalized);
    }
    revision += 1;
    schedule();
    return true;
  }
  const timer = setInterval(() => { wake(); }, intervalMs);
  timer.unref();
  if (runImmediately) wake();
  let stopping;
  function stop() {
    if (!stopping) {
      stopped = true;
      clearInterval(timer);
      stopping = (async () => {
        await pumping;
        await Promise.allSettled([...active.values()]);
      })();
    }
    return stopping;
  }
  return { wake, stop };
}
