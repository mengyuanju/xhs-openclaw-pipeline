// One shared Web-process budget for statistics only. No effect on normal task requests.
export function createReadScheduler({ now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  intervalMs = 1000, maxQueued = 8, maxWaitMs = 10_000 } = {}) {
  let tail = Promise.resolve(), nextStart = 0, queued = 0;
  return async function schedule(read) {
    if (queued >= maxQueued) throw new Error('统计读取繁忙，请稍后刷新');
    queued++;
    const enqueuedAt = now();
    const job = tail.then(async () => {
      await sleep(Math.max(0, nextStart - now()));
      if (now() - enqueuedAt > maxWaitMs) throw new Error('统计读取繁忙，请稍后刷新');
      nextStart = now() + Math.max(1000, intervalMs);
      return read();
    });
    tail = job.then(() => {}, () => {});
    try { return await job; } finally { queued--; }
  };
}
