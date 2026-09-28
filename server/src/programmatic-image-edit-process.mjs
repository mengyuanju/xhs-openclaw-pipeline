import pg from 'pg';
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createImageEditingService } from './image-editing.mjs';
import { loadServerEnvironment, applyServerEnvironment } from './server-environment.mjs';
import { programmaticConcurrency, safeProgrammaticLog, startProgrammaticImageEditProcessing } from './programmatic-image-edit-runner.mjs';
import { PROGRAMMATIC_IMAGE_EDIT_CHANNEL } from './programmatic-image-edit-supervisor.mjs';

async function main() {
  // An IPC child inherits the center's selected environment. Standalone workers
  // load the same profile explicitly, including when run in their own container.
  if (!process.send) {
    const selected = loadServerEnvironment({ args: process.argv.slice(2) });
    applyServerEnvironment(selected.environment);
  }
  const concurrency = programmaticConcurrency(process.env.PROGRAMMATIC_IMAGE_CONCURRENCY ?? 2);
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const storageRoot = resolve(process.env.CONTROL_PLANE_STORAGE_ROOT || 'server-storage');
  await mkdir(storageRoot, { recursive: true });
  sharp.concurrency(1);
  const pool = new pg.Pool({ connectionString, max: concurrency + 3, connectionTimeoutMillis: 10_000 });
  let runner, listener, stopping;
  async function stop(code = 0) {
    if (!stopping) stopping = (async () => {
      await runner?.stop();
      listener?.release();
      await pool.end();
      process.exitCode = code;
      if (process.connected) process.disconnect();
    })();
    return stopping;
  }
  try {
    listener = await pool.connect();
    listener.on('error', error => {
      safeProgrammaticLog(console, 'error', `Programmatic notification connection failed: ${error.message}`);
      void stop(1);
    });
    await listener.query(`LISTEN ${PROGRAMMATIC_IMAGE_EDIT_CHANNEL}`);
    const service = createImageEditingService({ pool, storageRoot });
    runner = startProgrammaticImageEditProcessing({ service, storageRoot }, { concurrency });
    listener.on('notification', notification => {
      if (notification.channel !== PROGRAMMATIC_IMAGE_EDIT_CHANNEL) return;
      try { runner.wake(JSON.parse(notification.payload)); }
      catch { runner.wake(); }
    });
    process.on('message', message => {
      if (message?.type === 'stop') void stop();
      else if (message?.type === 'wake') {
        try { runner.wake(message.editIds); } catch { runner.wake(); }
      }
    });
    process.once('SIGINT', () => { void stop(); });
    process.once('SIGTERM', () => { void stop(); });
    process.once('disconnect', () => { void stop(); });
    if (process.send) process.send({ type: 'ready', concurrency, sharpThreads: sharp.concurrency() });
    else safeProgrammaticLog(console, 'log', `Programmatic image edit worker is ready (concurrency ${concurrency}, Sharp threads 1).`);
  } catch (error) {
    await stop(1);
    throw error;
  }
}

main().catch(error => {
  safeProgrammaticLog(console, 'error', error.message);
  process.exitCode = 1;
});
