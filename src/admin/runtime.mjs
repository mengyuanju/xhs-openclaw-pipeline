import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { createAdminStore } from './admin-store.mjs';

const projectRoot = process.cwd();

export function adminDatabasePath() {
  return resolve(/* turbopackIgnore: true */ projectRoot, process.env.XHS_DB_PATH || 'data/queue.db');
}

export function adminAssetRoot() {
  return resolve(/* turbopackIgnore: true */ projectRoot, process.env.XHS_ASSET_ROOT || 'data/assets');
}

export function withAdminStore(callback) {
  const databasePath = adminDatabasePath();
  mkdirSync(dirname(databasePath), { recursive: true });
  const store = createAdminStore(databasePath);
  let result;
  try {
    result = callback(store);
  } catch (error) {
    store.close();
    throw error;
  }
  if (result && typeof result.then === 'function') {
    return Promise.resolve(result).finally(() => store.close());
  }
  store.close();
  return result;
}
