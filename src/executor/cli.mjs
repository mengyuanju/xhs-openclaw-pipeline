#!/usr/bin/env node
import { resolve } from 'node:path';

import { createControlPlaneClient } from '../control-plane/client.mjs';
import { createExecutorAgent } from './agent.mjs';

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function booleanOption({ enabledFlag, disabledFlag, environmentValue, fallback = false }) {
  if (hasFlag(enabledFlag) && hasFlag(disabledFlag)) {
    throw new Error(`--${enabledFlag} and --${disabledFlag} cannot be used together`);
  }
  if (hasFlag(enabledFlag)) return true;
  if (hasFlag(disabledFlag)) return false;
  if (environmentValue === undefined) return fallback;
  if (environmentValue === 'true') return true;
  if (environmentValue === 'false') return false;
  throw new Error('IMAGE_WORKER_ENABLED must be true or false');
}

function config(environment = process.env) {
  const serverUrl = option('server-url') ?? environment.CONTROL_PLANE_URL;
  const nodeId = option('node-id') ?? environment.EXECUTOR_NODE_ID;
  const nodeName = option('node-name') ?? environment.EXECUTOR_NODE_NAME ?? nodeId;
  if (!serverUrl) throw new Error('CONTROL_PLANE_URL or --server-url is required');
  if (!nodeId) throw new Error('EXECUTOR_NODE_ID or --node-id is required');
  const pollMs = Number(option('poll-ms') ?? environment.EXECUTOR_POLL_MS ?? 5_000);
  if (!Number.isInteger(pollMs) || pollMs < 1_000 || pollMs > 60_000) {
    throw new Error('poll interval must be an integer from 1000 to 60000 milliseconds');
  }
  return {
    serverUrl,
    nodeId,
    nodeName,
    pollMs,
    once: hasFlag('once'),
    imageWorkerEnabled: booleanOption({
      enabledFlag: 'enable-image-worker',
      disabledFlag: 'disable-image-worker',
      environmentValue: environment.IMAGE_WORKER_ENABLED,
    }),
    workRoot: resolve(environment.EXECUTOR_WORK_ROOT || 'data/executor-work'),
  };
}

async function main() {
  const configuration = config();
  const controlPlane = createControlPlaneClient({ baseUrl: configuration.serverUrl });
  const agent = createExecutorAgent({ controlPlane, ...configuration });
  console.log(`Executor ${configuration.nodeId} is checking work directory and control plane readiness...`);
  await agent.prepare();
  await agent.register();
  console.log(
    `Executor ${configuration.nodeId} is ready and connected; image worker: ${configuration.imageWorkerEnabled ? 'enabled' : 'disabled'}.`,
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
        if (!stopping) await new Promise((resolvePromise) => setTimeout(resolvePromise, configuration.pollMs));
        continue;
      }
      if (outcome) {
        console.log(`${kind} task ${outcome.taskId}: ${outcome.status}`);
      }
      if (configuration.once || stopping) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, outcome ? 0 : configuration.pollMs));
    }
  }

  try {
    const lanes = [runLane('COPY', () => agent.runCopyOnce())];
    if (configuration.imageWorkerEnabled) {
      lanes.push(runLane('IMAGE', () => agent.runImageOnce()));
    }
    await Promise.all(lanes);
  } finally {
    clearInterval(heartbeatTimer);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
