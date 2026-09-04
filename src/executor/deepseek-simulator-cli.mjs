#!/usr/bin/env node
import { resolve } from 'node:path';

import { createControlPlaneClient } from '../control-plane/client.mjs';
import { assertDeepSeekSimulationEnvironment } from '../deepseek-responses-client.mjs';
import { createExecutorAgent } from './agent.mjs';
import { executeDeepSeekCopySimulation } from './deepseek-copy-simulator.mjs';
import { executeDeepSeekImageSimulation } from './deepseek-image-simulator.mjs';

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function imageWorkerEnabled(environment = process.env) {
  if (hasFlag('enable-image-worker') && hasFlag('disable-image-worker')) {
    throw new Error('--enable-image-worker and --disable-image-worker cannot be used together');
  }
  if (hasFlag('enable-image-worker')) return true;
  if (hasFlag('disable-image-worker')) return false;
  if (environment.IMAGE_WORKER_ENABLED === undefined) return false;
  if (environment.IMAGE_WORKER_ENABLED === 'true') return true;
  if (environment.IMAGE_WORKER_ENABLED === 'false') return false;
  throw new Error('IMAGE_WORKER_ENABLED must be true or false');
}

function configuration(environment = process.env) {
  const serverUrl = option('server-url') ?? environment.CONTROL_PLANE_URL;
  const baseNodeId = environment.EXECUTOR_NODE_ID?.trim() || 'local';
  const nodeId = option('node-id') ?? environment.DEEPSEEK_SIM_NODE_ID ?? `${baseNodeId.slice(0, 50)}-deepseek-sim`;
  const nodeName = option('node-name') ?? environment.DEEPSEEK_SIM_NODE_NAME ?? `${nodeId}（DeepSeek 模拟）`;
  const pollMs = Number(option('poll-ms') ?? environment.EXECUTOR_POLL_MS ?? 5_000);
  if (!serverUrl) throw new Error('CONTROL_PLANE_URL or --server-url is required');
  if (!Number.isInteger(pollMs) || pollMs < 1_000 || pollMs > 60_000) {
    throw new Error('poll interval must be an integer from 1000 to 60000 milliseconds');
  }
  return {
    serverUrl,
    nodeId,
    nodeName,
    pollMs,
    once: hasFlag('once'),
    imageWorkerEnabled: imageWorkerEnabled(environment),
    workRoot: resolve(environment.EXECUTOR_WORK_ROOT || 'data/executor-work'),
  };
}

async function main() {
  assertDeepSeekSimulationEnvironment();
  const config = configuration();
  const controlPlane = createControlPlaneClient({ baseUrl: config.serverUrl });
  const agent = createExecutorAgent({
    controlPlane,
    nodeId: config.nodeId,
    nodeName: config.nodeName,
    imageWorkerEnabled: config.imageWorkerEnabled,
    workRoot: config.workRoot,
    executeCopy: executeDeepSeekCopySimulation,
    executeImage: executeDeepSeekImageSimulation,
  });
  console.log(`DeepSeek simulation executor ${config.nodeId} is checking readiness...`);
  await agent.prepare();
  await agent.register();
  console.log(
    `DeepSeek simulation executor ${config.nodeId} is ready; image worker: ${config.imageWorkerEnabled ? 'enabled' : 'disabled'}.`,
  );

  let stopping = false;
  process.once('SIGINT', () => { stopping = true; });
  process.once('SIGTERM', () => { stopping = true; });
  const heartbeatTimer = setInterval(() => {
    void agent.heartbeat().catch((error) => {
      console.error(`Executor heartbeat failed: ${error instanceof Error ? error.message : error}`);
    });
  }, 15_000);
  heartbeatTimer.unref();

  async function runLane(kind, runOnce) {
    while (!stopping) {
      let outcome;
      try {
        outcome = await runOnce();
      } catch (error) {
        console.error(`${kind} polling failed; retrying: ${error instanceof Error ? error.message : error}`);
        if (!stopping) await new Promise((resolvePromise) => setTimeout(resolvePromise, config.pollMs));
        continue;
      }
      if (outcome) console.log(`${kind} simulation task ${outcome.taskId}: ${outcome.status}`);
      if (config.once || stopping) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, outcome ? 0 : config.pollMs));
    }
  }

  try {
    const lanes = [runLane('COPY', () => agent.runCopyOnce())];
    if (config.imageWorkerEnabled) lanes.push(runLane('IMAGE', () => agent.runImageOnce()));
    await Promise.all(lanes);
  } finally {
    clearInterval(heartbeatTimer);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
