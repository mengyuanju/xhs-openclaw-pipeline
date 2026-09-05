#!/usr/bin/env node
import { createControlPlaneClient } from '../control-plane/client.mjs';
import { createExecutorAgent } from './agent.mjs';
import { executorConfig } from './config.mjs';
import { runExecutor } from './runtime.mjs';

async function main() {
  const configuration = executorConfig();
  const controlPlane = createControlPlaneClient({ baseUrl: configuration.serverUrl });
  const agent = createExecutorAgent({ controlPlane, ...configuration, concurrencyEnabled: true });
  await runExecutor({ agent, configuration });
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
