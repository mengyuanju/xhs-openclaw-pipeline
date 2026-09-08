#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { loadConfiguration } from '../server/scripts/database-common.mjs';
import { exportDatabase } from '../server/scripts/export-database.mjs';

const projectRoot = resolve(import.meta.dirname, '..');
const sqlitePath = resolve(process.env.XHS_DATABASE_PATH || process.env.XHS_DB_PATH || join(projectRoot, 'data', 'queue.db'));
const archiveRoot = resolve(process.env.XHS_DATABASE_BACKUP_ROOT || join(projectRoot, 'data', 'database-backups'));
const retentionDays = Number.parseInt(process.env.XHS_BACKUP_RETENTION_DAYS || '30', 10);

if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new Error('XHS_BACKUP_RETENTION_DAYS must be an integer from 1 to 3650');
if (!existsSync(sqlitePath)) throw new Error(`Local database does not exist: ${sqlitePath}`);

function archiveStamp() {
  return new Date().toISOString().replace(/[:.]/gu, '-');
}

function zipDirectory(source, destination) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('tar', ['-a', '-c', '-f', destination, '-C', source, '.'], { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-4000); });
    child.once('error', (error) => reject(new Error(`Cannot create ZIP archive: ${error.message}`)));
    child.once('close', (code) => code === 0 ? resolvePromise() : reject(new Error(`ZIP archive failed (${code}): ${errors}`)));
  });
}

function removeExpiredArchives() {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const removed = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/^xhs-database-backup-\d{4}-\d{2}-\d{2}T.+\.zip$/u.test(entry.name) && statSync(path).mtimeMs < cutoff) {
        rmSync(path);
        removed.push(path);
      }
    }
  };
  visit(archiveRoot);
  return removed;
}

const createdAt = new Date();
const stamp = archiveStamp();
const year = String(createdAt.getFullYear());
const month = String(createdAt.getMonth() + 1).padStart(2, '0');
const archiveDirectory = join(archiveRoot, year, month);
const archivePath = join(archiveDirectory, `xhs-database-backup-${stamp}.zip`);
mkdirSync(archiveDirectory, { recursive: true });
const staging = await mkdtemp(join(tmpdir(), 'xhs-database-backup-'));

try {
  const sqliteFolder = join(staging, 'sqlite');
  mkdirSync(sqliteFolder);
  const sqliteBackup = join(sqliteFolder, 'queue.sqlite');
  const source = new DatabaseSync(sqlitePath, { readOnly: true });
  try { await backup(source, sqliteBackup); } finally { source.close(); }
  const verification = new DatabaseSync(sqliteBackup, { readOnly: true });
  let sqliteTables;
  try {
    const integrity = verification.prepare('PRAGMA integrity_check').get().integrity_check;
    if (integrity !== 'ok') throw new Error(`SQLite backup integrity check failed: ${integrity}`);
    sqliteTables = verification.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'").get().count;
  } finally { verification.close(); }

  const postgres = await exportDatabase(loadConfiguration(), staging);
  renameSync(postgres.folder, join(staging, 'postgresql'));
  const manifest = { format: 'xhs-project-database-backup', version: 1, createdAt: createdAt.toISOString(),
    contents: { sqlite: { source: sqlitePath, file: 'sqlite/queue.sqlite', tables: sqliteTables }, postgresql: { directory: 'postgresql', tables: postgres.tables, rows: postgres.rows } },
    restoreNote: 'Restore SQLite and PostgreSQL independently. PostgreSQL file storage is not included; back up server/server-storage separately.' };
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  await zipDirectory(staging, archivePath);
  const removed = removeExpiredArchives();
  console.log(JSON.stringify({ archivePath, createdAt: manifest.createdAt, sqliteTables, postgresTables: postgres.tables, postgresRows: postgres.rows, retentionDays, removed }, null, 2));
} finally {
  rmSync(staging, { recursive: true, force: true });
}
