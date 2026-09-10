import { env } from 'cloudflare:workers';

export function getBindings() {
  if (!env.DB) {
    throw new Error('D1 binding `DB` is unavailable.');
  }
  if (!env.FILES) {
    throw new Error('R2 binding `FILES` is unavailable.');
  }

  return {
    db: env.DB,
    files: env.FILES,
  };
}
