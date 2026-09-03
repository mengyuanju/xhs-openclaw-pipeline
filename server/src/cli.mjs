#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createControlPlaneApp } from './http-server.mjs';
import { createPostgresControlPlaneRepository } from './postgres-repository.mjs';
import { DEFAULT_PRODUCTION_SETTINGS, loadDefaultPrompts } from './defaults.mjs';

function configuration(environment = process.env) {
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
  };
}

async function main() {
  const command = process.argv[2];
  if (!['init', 'serve'].includes(command)) {
    throw new Error('usage: node src/cli.mjs <init|serve>');
  }
  const config = configuration();
  const repository = createPostgresControlPlaneRepository(config);
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
    console.log('Control plane database and storage are initialized.');
    return;
  }

  await repository.initialize();
  await mkdir(config.storageRoot, { recursive: true });
  const app = createControlPlaneApp({ repository, storageRoot: config.storageRoot });
  const server = await new Promise((resolvePromise, rejectPromise) => {
    const listeningServer = app.listen(config.port, config.host, () => resolvePromise(listeningServer));
    listeningServer.once('error', rejectPromise);
  });
  console.log(`Control plane listening on http://${config.host}:${config.port}`);

  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    await new Promise((resolvePromise) => server.close(resolvePromise));
    await repository.close();
  }
  process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
  process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
