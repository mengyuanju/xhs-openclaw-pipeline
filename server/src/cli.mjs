#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createControlPlaneApp } from './http-server.mjs';
import { createPostgresControlPlaneRepository } from './postgres-repository.mjs';
import { DEFAULT_PRODUCTION_SETTINGS, loadDefaultPrompts } from './defaults.mjs';
import { startExecutionRecovery } from './execution-recovery.mjs';
import { applyServerEnvironment, loadServerEnvironment } from './server-environment.mjs';
import { startAutoAssignmentReplenishment } from './task-auto-assignment-runner.mjs';
import { createImageEditingService } from './image-editing.mjs';
import { processImageEdit } from './image-edit-renderer.mjs';
import { startImageEditProcessing } from './image-edit-runner.mjs';

function optionalBoolean(value,name,fallback) {
  if(value===undefined||value==='')return fallback;
  if(!['true','false'].includes(value))throw new Error(`${name} must be true or false`);
  return value==='true';
}

function boundedInterval(value,name,fallback) {
  if(value===undefined||value==='')return fallback;
  const parsed=Number(value);
  if(!Number.isInteger(parsed)||parsed<100||parsed>60_000)throw new Error(`${name} must be an integer from 100 to 60000`);
  return parsed;
}

export function configuration(environment = process.env) {
  const connectionString = environment.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const port = Number(environment.CONTROL_PLANE_PORT ?? 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('CONTROL_PLANE_PORT must be an integer from 1 to 65535');
  }
  return {
    connectionString,
    host: environment.CONTROL_PLANE_HOST?.trim() || '127.0.0.1',
    port,
    storageRoot: resolve(environment.CONTROL_PLANE_STORAGE_ROOT || 'server-storage'),
    imageEditWorkerEnabled:optionalBoolean(environment.CONTROL_PLANE_IMAGE_EDIT_WORKER_ENABLED,'CONTROL_PLANE_IMAGE_EDIT_WORKER_ENABLED',environment.XHS_SERVER_ENV!=='production'),
    imageEditPollMs:boundedInterval(environment.CONTROL_PLANE_IMAGE_EDIT_POLL_MS,'CONTROL_PLANE_IMAGE_EDIT_POLL_MS',2000),
  };
}

async function main() {
  const command = process.argv[2];
  if (!['init', 'serve', 'image-edit-once'].includes(command)) {
    throw new Error('usage: node src/cli.mjs <init|serve|image-edit-once>');
  }
  const args = process.argv.slice(3);
  if (args.some((arg) => !arg.startsWith('--environment='))) {
    throw new Error('usage: node src/cli.mjs <init|serve|image-edit-once> [--environment=development|production]');
  }
  const selectedEnvironment = loadServerEnvironment({ args });
  applyServerEnvironment(selectedEnvironment.environment);
  const config = configuration(selectedEnvironment.environment);
  const repository = createPostgresControlPlaneRepository(config);
  if (command === 'image-edit-once') {
    try {
      const service = createImageEditingService({ pool: repository.pool, storageRoot: config.storageRoot });
      console.log(JSON.stringify(await processImageEdit({ service, storageRoot: config.storageRoot, workerId: `manual-${process.pid}` })));
    } finally { await repository.close(); }
    return;
  }
  if (command === 'init') {
    await repository.initialize();
    await mkdir(config.storageRoot, { recursive: true });
    const settings = await repository.listSettings();
    const production = settings.find((item) => item.key === 'production');
    if (!production || Object.keys(production.value).length === 0) {
      await repository.upsertSetting('production', DEFAULT_PRODUCTION_SETTINGS);
    }
    const existingPromptKinds = new Set((await repository.listPrompts()).map((item) => item.kind));
    for (const prompt of await loadDefaultPrompts()) {
      if (existingPromptKinds.has(prompt.kind)) continue;
      const version = await repository.createPromptVersion(prompt);
      await repository.publishPromptVersion(version.id);
    }
    await repository.close();
    console.log(`Control plane database and storage are initialized (${selectedEnvironment.profile}).`);
    return;
  }

  await repository.initialize();
  await repository.recoverStaleExecutions();
  await mkdir(config.storageRoot, { recursive: true });
  const app = createControlPlaneApp({ repository, storageRoot: config.storageRoot });
  const server = await new Promise((resolvePromise, rejectPromise) => {
    const listeningServer = app.listen(config.port, config.host, () => resolvePromise(listeningServer));
    listeningServer.once('error', rejectPromise);
  });
  console.log(`Control plane listening on http://${config.host}:${config.port} (${selectedEnvironment.profile}).`);
  const stopRecovery = startExecutionRecovery(repository);
  const stopAutoAssignment = startAutoAssignmentReplenishment(repository);
  const stopImageEdits=config.imageEditWorkerEnabled
    ? startImageEditProcessing({service:createImageEditingService({pool:repository.pool,storageRoot:config.storageRoot}),storageRoot:config.storageRoot},{intervalMs:config.imageEditPollMs})
    : async()=>{};
  console.log(`Image edit queue worker ${config.imageEditWorkerEnabled?'enabled':'disabled'}.`);

  let stoppingPromise = null;
  function stop() {
    if (stoppingPromise) return stoppingPromise;
    stoppingPromise = (async () => {
      await Promise.all([stopRecovery(), stopAutoAssignment(), stopImageEdits()]);
      const serverClosed = new Promise((resolvePromise) => server.close(resolvePromise));
      await app.context.disposeControlPlaneResources?.();
      await serverClosed;
      await repository.close();
    })();
    return stoppingPromise;
  }
  process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
  process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
