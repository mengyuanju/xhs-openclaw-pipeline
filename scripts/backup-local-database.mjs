#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

const projectRoot = resolve(import.meta.dirname, '..');
const sourcePath = resolve(process.env.XHS_DATABASE_PATH || process.env.XHS_DB_PATH || join(projectRoot, 'data', 'queue.db'));
const backupDirectory = resolve(process.env.XHS_BACKUP_DIRECTORY || join(projectRoot, 'data', 'backups'));
const retentionDays = Number.parseInt(process.env.XHS_BACKUP_RETENTION_DAYS || '30', 10);

if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
  throw new Error('XHS_BACKUP_RETENTION_DAYS must be an integer from 1 to 3650');
}
if (!existsSync(sourcePath)) throw new Error(`Local database does not exist: ${sourcePath}`);

function timestamp() {
  return new Date().toISOString().replace(/[.:]/gu, '-');
}

function removeExpiredBackups() {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const prefix = 'queue-';
  const suffix = '.sqlite';
  const removed = [];
  for (const entry of readdirSync(backupDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(suffix)) continue;
    const path = join(backupDirectory, entry.name);
    if (statSync(path).mtimeMs < cutoff) {
      rmSync(path);
      removed.push(path);
    }
  }
  return removed;
}

mkdirSync(dirname(sourcePath), { recursive: true });
mkdirSync(backupDirectory, { recursive: true });

const destinationPath = join(backupDirectory, `queue-${timestamp()}.sqlite`);
const database = new DatabaseSync(sourcePath, { readOnly: true });
try {
  await backup(database, destinationPath);
} finally {
  database.close();
}

const verification = new DatabaseSync(destinationPath, { readOnly: true });
let tables;
try {
  const integrity = verification.prepare('PRAGMA integrity_check').get().integrity_check;
  if (integrity !== 'ok') throw new Error(`Backup integrity check failed: ${integrity}`);
  tables = verification.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'").get().count;
} finally {
  verification.close();
}

const removed = removeExpiredBackups();
const result = { sourcePath, destinationPath, tables, retentionDays, removed, createdAt: new Date().toISOString() };
writeFileSync(`${destinationPath}.json`, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
