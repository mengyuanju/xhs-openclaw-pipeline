import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { createAdminStore } from './admin-store.mjs';

const projectRoot = process.cwd();

export function adminDatabasePath() {
  return resolve(/* turbopackIgnore: true */ projectRoot, process.env.XHS_DB_PATH || 'data/queue.db');
}

export function adminOpenClawRoot() {
  const configuredRoot = process.env.XHS_OPENCLAW_ROOT?.trim();
  if (configuredRoot) return resolve(/* turbopackIgnore: true */ projectRoot, configuredRoot);
  const userProfile = process.env.USERPROFILE?.trim();
  if (!userProfile) throw new Error('OpenClaw home is unavailable');
  return resolve(/* turbopackIgnore: true */ userProfile, '.openclaw');
}

export function adminAssetRoot() {
  return resolve(/* turbopackIgnore: true */ projectRoot, process.env.XHS_ASSET_ROOT || 'data/assets');
}

export function adminKnowledgeRoot() {
  return resolve(/* turbopackIgnore: true */ projectRoot, process.env.XHS_KNOWLEDGE_ROOT || 'data/knowledge');
}

export function adminOutputRoot() {
  return resolve(/* turbopackIgnore: true */ projectRoot, process.env.XHS_OUTPUT_ROOT || 'output');
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
