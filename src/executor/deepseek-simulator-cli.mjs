#!/usr/bin/env node
import { createControlPlaneClient } from '../control-plane/client.mjs';
import { assertDeepSeekSimulationEnvironment } from '../deepseek-responses-client.mjs';
import { createExecutorAgent } from './agent.mjs';
import { executeDeepSeekCopySimulation } from './deepseek-copy-simulator.mjs';
import { executeDeepSeekImageSimulation } from './deepseek-image-simulator.mjs';
import { executorConfig } from './config.mjs';
import { runExecutor } from './runtime.mjs';

async function main() {
  const configuration = executorConfig(process.env, process.argv.slice(2), { simulation: true });
  assertDeepSeekSimulationEnvironment();
  const controlPlane = createControlPlaneClient({ baseUrl: configuration.serverUrl });
  const agent = createExecutorAgent({ controlPlane, ...configuration, concurrencyEnabled: true,
    executeCopy: executeDeepSeekCopySimulation,
    executeImage: executeDeepSeekImageSimulation,
  });
  await runExecutor({ agent, configuration });
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
