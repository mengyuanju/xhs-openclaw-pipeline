import { createExecutorScheduler } from './scheduler.mjs';

export async function runExecutor({ agent, configuration, host = process, log = console, heartbeatMs = 15000 }) {
  log.log(`Executor ${configuration.nodeId} is checking readiness...`);
  await agent.prepare();
  await agent.register();
  log.log(`Executor ${configuration.nodeId} is ready; copy concurrency: ${configuration.copyConcurrency}; image concurrency: ${configuration.imageWorkerEnabled ? configuration.imageConcurrency : 0}.`);
  const scheduler = createExecutorScheduler({ agent, ...configuration,
    onOutcome: outcome => log.log(`${outcome.kind} task ${outcome.taskId}: ${outcome.status}`),
    onError: (kind, error, context) => log.error(`${kind}${context ? ` task ${context.taskId} execution ${context.executionId}` : ' claim'} failed; retrying: ${error instanceof Error ? error.message : error}`),
  });
  const stop = () => scheduler.stop();
  host.once('SIGINT', stop);
  host.once('SIGTERM', stop);
  let heartbeatRunning = false;
  const heartbeatTimer = setInterval(() => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    void agent.heartbeat().catch(error => log.error(`Executor heartbeat failed: ${error instanceof Error ? error.message : error}`))
      .finally(() => { heartbeatRunning = false; });
  }, heartbeatMs);
  heartbeatTimer.unref();
  try {
    await scheduler.start();
  } finally {
    clearInterval(heartbeatTimer);
    host.removeListener('SIGINT', stop);
    host.removeListener('SIGTERM', stop);
  }
}
