// Fence callbacks from work that finishes after the center revoked its execution.
export function guardExecutionCalls(target, signal, { model = false } = {}) {
  return new Proxy(target, {
    get(object, key) {
      if (typeof object[key] !== 'function') return object[key];
      return (...args) => {
        signal.throwIfAborted();
        if (model && String(key).startsWith('run')) {
          const input = args[0] ?? {};
          args[0] = { ...input, signal: input.signal ? AbortSignal.any([signal, input.signal]) : signal };
        }
        return object[key](...args);
      };
    },
  });
}

export async function runWithExecutionSignal(signal, operation) {
  signal.throwIfAborted();
  let abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([interrupted, Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}
