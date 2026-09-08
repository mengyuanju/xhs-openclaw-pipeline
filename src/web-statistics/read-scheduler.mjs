// One shared Web-process budget for statistics only. No effect on normal task requests.
export function createReadScheduler({ now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  intervalMs = 1000, maxQueued = 8, maxWaitMs = 10_000, maxConcurrent = 1 } = {}) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new TypeError('统计读取并发数无效');
  let nextStart = 0, queued = 0, active = 0, draining = false;
  const pending = [];

  function drain() {
    if (draining) return;
    draining = true;
    void (async () => {
      try {
        while (pending.length && active < maxConcurrent) {
          const waitMs = Math.max(0, nextStart - now());
          if (waitMs) await sleep(waitMs);
          const job = pending.shift();
          if (now() - job.enqueuedAt > maxWaitMs) {
            queued--;
            job.reject(new Error('统计读取繁忙，请稍后刷新'));
            continue;
          }
          nextStart = now() + Math.max(0, intervalMs);
          active++;
          Promise.resolve().then(job.read).then(job.resolve, job.reject).finally(() => {
            active--;
            queued--;
            drain();
          });
        }
      } finally {
        draining = false;
        if (pending.length && active < maxConcurrent) drain();
      }
    })();
  }

  return async function schedule(read) {
    if (queued >= maxQueued) throw new Error('统计读取繁忙，请稍后刷新');
    queued++;
    const result = new Promise((resolve, reject) => {
      pending.push({ read, resolve, reject, enqueuedAt: now() });
      drain();
    });
    return result;
  };
}
