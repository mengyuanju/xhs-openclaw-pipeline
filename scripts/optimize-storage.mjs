import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createAdminStore } from '../src/admin/admin-store.mjs';
import { optimizeAllTaskStorage } from '../src/admin/storage-optimizer.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function main(
  argv = process.argv.slice(2),
  { env = process.env, stdout = process.stdout, stderr = process.stderr } = {},
) {
  if (argv.some((argument) => argument !== '--apply') || argv.length > 1) {
    writeJson(stderr, { error: 'usage: npm run storage:optimize -- [--apply]' });
    return 1;
  }
  const apply = argv.includes('--apply');
  const databasePath = resolve(
    env.XHS_DATABASE_PATH || env.XHS_DB_PATH || resolve(PROJECT_ROOT, 'data', 'queue.db'),
  );
  const outputRoot = resolve(env.XHS_OUTPUT_ROOT || resolve(PROJECT_ROOT, 'output'));
  const assetRoot = resolve(env.XHS_ASSET_ROOT || resolve(PROJECT_ROOT, 'data', 'assets'));
  const store = createAdminStore(databasePath);
  try {
    const report = await optimizeAllTaskStorage({
      store,
      assetRoot,
      outputRoot,
      apply,
    });
    writeJson(stdout, {
      status: report.errors.length > 0 ? 'completed_with_errors' : 'completed',
      mode: apply ? 'apply' : 'dry-run',
      databasePath,
      outputRoot,
      assetRoot,
      ...report,
      logicalMiB: Number((report.logicalBytes / 1024 / 1024).toFixed(2)),
    });
    return report.errors.length > 0 ? 1 : 0;
  } catch (error) {
    writeJson(stderr, { error: error instanceof Error ? error.message : String(error) });
    return 1;
  } finally {
    store.close();
  }
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) process.exitCode = await main();
