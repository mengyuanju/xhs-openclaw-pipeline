/** Shares covered refreshes and retains one follow-up for changes received in flight. */
export function createListRefreshCoordinator() {
  type Read = () => Promise<void>;
  type Flight = { revision: number; read: Read; promise: Promise<void>; queued: { revision: number; read: Read } | null };
  let active: Flight | null = null;
  let coveredRevision = -1;

  function request(read: Read, { revision, invalidation = false }: { revision: number; invalidation?: boolean }) {
    if (active) {
      if (revision > Math.max(active.revision, active.queued?.revision ?? -1)) active.queued = { revision, read };
      return active.promise;
    }
    if (invalidation && revision <= coveredRevision) return Promise.resolve();
    const flight: Flight = { revision, read, queued: null, promise: Promise.resolve() };
    active = flight;
    flight.promise = (async () => {
      try {
        do {
          const queued = flight.queued;
          if (queued) { flight.revision = queued.revision; flight.read = queued.read; flight.queued = null; }
          await flight.read();
          if (active !== flight) return;
          coveredRevision = Math.max(coveredRevision, flight.revision);
        } while (flight.queued);
      } finally { if (active === flight) active = null; }
    })();
    return flight.promise;
  }
  return { request, reset() { active = null; coveredRevision = -1; } };
}
