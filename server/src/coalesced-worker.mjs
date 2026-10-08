// Timer/notification bursts share the current drain and reserve one follow-up.
export function createCoalescedWorker(run, { onError = () => {} } = {}) {
  const controller = new AbortController();
  let inFlight = null;
  let requested = false;
  let stopping = false;
  return {
    wake() {
      if (stopping) return inFlight ?? Promise.resolve();
      requested = true;
      if (inFlight) return inFlight;
      inFlight = Promise.resolve().then(async () => {
        try {
          do {
            requested = false;
            try { await run(controller.signal); }
            catch (error) { try { onError(error); } catch { /* Logging must not rerun work. */ } }
          } while (requested && !stopping);
        } finally { inFlight = null; }
      });
      return inFlight;
    },
    async dispose() {
      stopping = true;
      requested = false;
      controller.abort();
      // The drain settles durable acknowledgements before returning.
      await inFlight;
    },
  };
}
