import { env } from 'cloudflare:workers';

export function getDatabaseBinding() {
  if (!env.DB) {
    throw new Error('D1 binding `DB` is unavailable.');
  }
  return env.DB;
}

export function getFilesBinding() {
  if (!env.FILES) {
    throw new Error('R2 binding `FILES` is unavailable.');
  }
  return env.FILES;
}

export function getBindings() {
  return {
    db: getDatabaseBinding(),
    files: getFilesBinding(),
  };
}
