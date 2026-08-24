import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAdminStore } from '../src/admin/admin-store.mjs';
import { installRulePrompts } from '../src/admin/rule-prompt-installer.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const databasePath = resolve(
  process.env.XHS_DATABASE_PATH || process.env.XHS_DB_PATH || resolve(projectRoot, 'data', 'queue.db'),
);

mkdirSync(dirname(databasePath), { recursive: true });
const store = createAdminStore(databasePath);
try {
  const result = installRulePrompts(store);
  process.stdout.write(`${JSON.stringify({ databasePath, prompts: result }, null, 2)}\n`);
} finally {
  store.close();
}
