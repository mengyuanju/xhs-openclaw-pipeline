const DATABASE_NAME = 'xhs:session-coordination:v1';
const STORE_NAME = 'leases';
const OPERATION_TIMEOUT_MS = 10_000;

/** A readwrite transaction atomically checks and replaces a lease across tabs. */
export function createIndexedSessionLeaseStore(indexedDB) {
  if (!indexedDB) return undefined;
  let databasePromise;
  let opened = false;
  let unavailableError;

  function openDatabase() {
    if (unavailableError) return Promise.reject(unavailableError);
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        let reason = error ?? new Error('Session coordination database is unavailable');
        if (!opened && ['SecurityError', 'NotAllowedError'].includes(reason.name)) {
          unavailableError = new Error('Cross-tab session coordination is unavailable', { cause: reason });
          unavailableError.code = 'SESSION_LOCK_UNAVAILABLE';
          reason = unavailableError;
        }
        reject(reason);
      };
      const timeout = setTimeout(() => fail(new Error('Session coordination database timed out')), OPERATION_TIMEOUT_MS);
      let request;
      try { request = indexedDB.open(DATABASE_NAME, 1); }
      catch (error) { fail(error); return; }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: 'name' });
        }
      };
      request.onerror = () => fail(request.error);
      request.onblocked = () => fail(new Error('Session coordination database is blocked'));
      request.onsuccess = () => {
        const database = request.result;
        if (settled) { database.close(); return; }
        settled = true;
        opened = true;
        clearTimeout(timeout);
        database.onversionchange = () => {
          database.close();
          databasePromise = undefined;
        };
        database.onclose = () => { databasePromise = undefined; };
        resolve(database);
      };
    });
    databasePromise.catch(() => { databasePromise = undefined; });
    return databasePromise;
  }

  async function changeLease(name, change) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      let changed = false;
      let settled = false;
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(changed);
      };
      const timeout = setTimeout(() => {
        try { transaction.abort(); } catch { /* It may already have completed. */ }
        finish(new Error('Session coordination transaction timed out'));
      }, OPERATION_TIMEOUT_MS);
      transaction.oncomplete = () => finish();
      transaction.onabort = () => finish(transaction.error ?? new Error('Session coordination transaction aborted'));
      transaction.onerror = () => finish(transaction.error ?? new Error('Session coordination transaction failed'));
      const request = store.get(name);
      request.onsuccess = () => {
        try {
          const update = change(request.result);
          changed = update !== undefined;
          if (update === null) store.delete(name);
          else if (update) store.put({ name, ...update });
        } catch (error) {
          try { transaction.abort(); } catch { /* Preserve the original failure. */ }
          finish(error);
        }
      };
    });
  }

  return {
    acquire(name, owner, nowMs, leaseMs) {
      return changeLease(name, lease => {
        if (typeof lease?.owner === 'string' && Number.isFinite(lease.expiresAt) && lease.expiresAt > nowMs) return;
        return { owner, expiresAt: nowMs + leaseMs };
      });
    },
    touch(name, owner, nowMs, leaseMs) {
      return changeLease(name, lease => lease?.owner === owner
        ? { owner, expiresAt: nowMs + leaseMs } : undefined);
    },
    release(name, owner) {
      return changeLease(name, lease => lease?.owner === owner ? null : undefined);
    },
  };
}
