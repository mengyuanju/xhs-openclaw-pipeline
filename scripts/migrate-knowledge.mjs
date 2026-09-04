#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { createAdminStore } from '../src/admin/admin-store.mjs';
import { migrateLegacyKnowledge, readLegacyKnowledge } from '../src/admin/knowledge-migration.mjs';
import { createRemoteKnowledgeStore } from '../src/admin/remote-knowledge-store.mjs';
import { createControlPlaneClient } from '../src/control-plane/client.mjs';

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--apply') options.apply = true;
  else if (['--source-db', '--target-db', '--source-key'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) options[arg.slice(2)] = args[++i];
  else throw new Error(`Unknown or incomplete option: ${arg}`);
}

async function main() {
  if (!options['source-db']) throw new Error('--source-db is required');
  const sourcePath = realpathSync(resolve(options['source-db']));
  const source = readLegacyKnowledge(sourcePath);
  const sourceKey = options['source-key'] ?? `sqlite:${createHash('sha256').update(process.platform === 'win32' ? sourcePath.toLowerCase() : sourcePath).digest('hex')}`;
  const destination = options['target-db'] ? resolve(options['target-db']) : null;
  const comparable = (path) => process.platform === 'win32' ? path.toLowerCase() : path;
  if (destination && comparable(existsSync(destination) ? realpathSync(destination) : destination) === comparable(sourcePath)) {
    throw new Error('source and destination must be different');
  }
  let store;
  let backupPath;
  if (destination) {
    if (options.apply) {
      mkdirSync(dirname(destination), { recursive: true });
      if (existsSync(destination)) {
        backupPath = `${destination}.backup-${Date.now()}`;
        const db = new DatabaseSync(destination, { readOnly: true });
        try { await backup(db, backupPath); } finally { db.close(); }
      }
      store = createAdminStore(destination);
    } else {
      const db = existsSync(destination) ? new DatabaseSync(destination, { readOnly: true }) : null;
      const hasLedger = db?.prepare("SELECT 1 FROM sqlite_master WHERE name = 'knowledge_imports'").get();
      store = {
        hasKnowledgeImport: ({ sourceKey, sourceId, kind }) => Boolean(hasLedger && db.prepare('SELECT 1 FROM knowledge_imports WHERE source_key = ? AND source_id = ? AND kind = ?').get(sourceKey, sourceId, kind)),
        close: () => db?.close(),
      };
    }
  } else {
    if (!process.env.CONTROL_PLANE_URL) throw new Error('set CONTROL_PLANE_URL or provide --target-db');
    const client = createControlPlaneClient({ baseUrl: process.env.CONTROL_PLANE_URL });
    // Fail before any writes when the deployed service does not support this migration.
    if (options.apply) await client.knowledgeCapabilities();
    store = createRemoteKnowledgeStore(client);
  }
  try {
    const result = await migrateLegacyKnowledge({ source, store, sourceKey, dryRun: !options.apply });
    console.log(JSON.stringify({ mode: options.apply ? 'APPLIED' : 'DRY_RUN', source: sourcePath,
      destination: destination ?? process.env.CONTROL_PLANE_URL, sourceKey, backupPath,
      sourceCounts: { copyItems: source.copyItems.length, labels: source.labels.length, analysisPrompts: source.analysisPrompts.length, visualItems: source.visualItems.length, assets: source.assets.length },
      ...result }, null, 2));
  } finally { await store.close?.(); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
