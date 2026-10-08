#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

import { hashFile, isMain, loadConfiguration, parseOptions, readBackup, safeError } from '../server/scripts/database-common.mjs';
import { exportDatabase } from '../server/scripts/export-database.mjs';

// These streaming ZIP packages are declared by the server workspace.
const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
const { ZipArchive } = serverRequire('archiver');
const yauzl = serverRequire('yauzl');
const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const DAY_MS = 24 * 60 * 60 * 1000;

export function parseBackupOptions(argv) {
  let options;
  try { options = parseOptions(argv, ['environment', 'out', 'help']); }
  catch { throw new Error('Invalid or duplicate backup option. Use --help for syntax.'); }
  const environment = options.environment ?? 'production';
  if (!['production', 'development'].includes(environment)) {
    throw new Error('--environment must be development or production');
  }
  return { ...options, environment };
}

export function resolveBackupRoot({
  profile, out, environment = process.env, projectRoot = PROJECT_ROOT,
}) {
  const configured = profile === 'production'
    ? environment.XHS_PRODUCTION_DATABASE_BACKUP_ROOT
    : environment.XHS_DEVELOPMENT_DATABASE_BACKUP_ROOT;
  const fallback = profile === 'production'
    ? 'D:/auto-claw/backups/production-database'
    : join(projectRoot, 'data', 'database-backups', 'development');
  const value = out ?? configured ?? environment.XHS_DATABASE_BACKUP_ROOT ?? fallback;
  if (typeof value !== 'string' || !value.trim()) throw new Error('Backup output directory is missing');
  return resolve(value);
}

function retentionDaysFrom(environment) {
  const value = environment.XHS_BACKUP_RETENTION_DAYS ?? '30';
  if (!/^[1-9]\d*$/u.test(String(value)) || Number(value) > 3650) {
    throw new Error('XHS_BACKUP_RETENTION_DAYS must be an integer from 1 to 3650');
  }
  return Number(value);
}

function archiveStamp(now) {
  return now.toISOString().replace(/[:.]/gu, '-');
}

function assertNoLinkedComponents(path) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const segment of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, segment);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Backup output path contains a link or non-directory component');
    }
  }
}

function assertInside(root, path) {
  const destination = resolve(path);
  const difference = relative(resolve(root), destination);
  if (!difference || difference === '..' || difference.startsWith(`..${sep}`) || isAbsolute(difference)) {
    throw new Error('Backup path escaped the output directory');
  }
  return destination;
}

function prepareArchiveRoot(archiveRoot) {
  const root = resolve(archiveRoot);
  assertNoLinkedComponents(root);
  mkdirSync(root, { recursive: true });
  assertNoLinkedComponents(root);
  return root;
}

export function removeExpiredArchives({
  archiveRoot, profile, retentionDays = 30, now = new Date(),
}) {
  if (!['production', 'development'].includes(profile)) throw new Error('Invalid backup profile');
  const root = resolve(archiveRoot);
  if (!existsSync(root)) return [];
  assertNoLinkedComponents(root);
  const cutoff = new Date(now).getTime() - retentionDays * DAY_MS;
  const namePattern = new RegExp(`^xhs-${profile}-database-backup-\\d{4}-\\d{2}-\\d{2}T[^/\\\\]+\\.zip$`, 'u');
  const removed = [];
  // Only year/month folders are searched. Links are never traversed.
  for (const year of readdirSync(root, { withFileTypes: true })) {
    if (!/^\d{4}$/u.test(year.name) || !year.isDirectory() || year.isSymbolicLink()) continue;
    const yearPath = assertInside(root, join(root, year.name));
    if (lstatSync(yearPath).isSymbolicLink()) continue;
    for (const month of readdirSync(yearPath, { withFileTypes: true })) {
      if (!/^(0[1-9]|1[0-2])$/u.test(month.name) || !month.isDirectory() || month.isSymbolicLink()) continue;
      const monthPath = assertInside(root, join(yearPath, month.name));
      if (lstatSync(monthPath).isSymbolicLink()) continue;
      for (const entry of readdirSync(monthPath, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink() || !namePattern.test(entry.name)) continue;
        const path = assertInside(root, join(monthPath, entry.name));
        const stat = lstatSync(path);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          rmSync(path);
          removed.push(path);
        }
      }
    }
  }
  return removed;
}

export async function zipDirectory(source, destination) {
  const output = createWriteStream(destination, { flags: 'wx' });
  const archive = new ZipArchive({ forceZip64: true, zlib: { level: 6 } });
  await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      archive.abort();
      output.destroy();
      rejectPromise(error);
    };
    output.once('error', fail);
    archive.once('error', fail);
    output.once('close', () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    });
    archive.pipe(output);
    archive.directory(source, false);
    Promise.resolve(archive.finalize()).catch(fail);
  });
}

export async function verifyZipContents(archivePath, expectedHashes) {
  const expected = expectedHashes instanceof Map ? expectedHashes : new Map(Object.entries(expectedHashes));
  const seen = new Set();
  const zip = await yauzl.openPromise(archivePath, {
    lazyEntries: true, autoClose: false, strictFileNames: true,
  });
  try {
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName;
      if (yauzl.validateFileName(name) || name.startsWith('/')
        || name.split('/').some(part => part === '.' || part === '..')) {
        throw new Error('ZIP contains an unsafe entry name');
      }
      if (name.endsWith('/')) continue;
      if (!expected.has(name)) throw new Error(`ZIP has an unexpected file: ${JSON.stringify(name)}`);
      if (seen.has(name)) throw new Error(`ZIP has a duplicate file: ${JSON.stringify(name)}`);
      const stream = await zip.openReadStreamPromise(entry);
      const digest = createHash('sha256');
      for await (const chunk of stream) digest.update(chunk);
      if (digest.digest('hex') !== expected.get(name)) throw new Error(`ZIP checksum mismatch: ${name}`);
      seen.add(name);
    }
  } finally {
    zip.close();
  }
  if (seen.size !== expected.size) throw new Error('ZIP is missing one or more backup files');
  return { files: seen.size };
}

async function backupSqlite(staging, environment, projectRoot) {
  const sqlitePath = resolve(environment.XHS_DATABASE_PATH || environment.XHS_DB_PATH
    || join(projectRoot, 'data', 'queue.db'));
  if (!existsSync(sqlitePath)) return null;
  const folder = join(staging, 'sqlite');
  mkdirSync(folder);
  const destination = join(folder, 'queue.sqlite');
  const source = new DatabaseSync(sqlitePath, { readOnly: true });
  try { await backup(source, destination); } finally { source.close(); }
  // The source may use WAL. Convert only the finished copy to a single-file database.
  const verification = new DatabaseSync(destination);
  let tables;
  try {
    const journalMode = verification.prepare('PRAGMA journal_mode=DELETE').get().journal_mode;
    if (journalMode?.toLowerCase() !== 'delete') throw new Error('SQLite backup journal conversion failed');
    if (verification.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') {
      throw new Error('SQLite backup integrity check failed');
    }
    tables = verification.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'").get().count;
  } finally { verification.close(); }
  if (existsSync(`${destination}-wal`) || existsSync(`${destination}-shm`)) {
    throw new Error('SQLite backup still has WAL sidecar files');
  }
  return { source: sqlitePath, file: 'sqlite/queue.sqlite', tables, sha256: await hashFile(destination) };
}

async function expectedPackageHashes(staging, pgManifest, sqlite) {
  const entries = [pgManifest.archive, pgManifest.sql, ...pgManifest.tables, ...pgManifest.migrations];
  const hashes = new Map(entries.map(entry => [`postgresql/${entry.file}`, entry.sha256]));
  if (hashes.size !== entries.length) throw new Error('PostgreSQL package has duplicate files');
  if (sqlite) hashes.set(sqlite.file, sqlite.sha256);
  hashes.set('manifest.json', await hashFile(join(staging, 'manifest.json')));
  hashes.set('postgresql/manifest.json', await hashFile(join(staging, 'postgresql', 'manifest.json')));
  return hashes;
}

export async function createProjectBackup({
  config,
  archiveRoot,
  retentionDays = 30,
  now = new Date(),
  environment = process.env,
  projectRoot = PROJECT_ROOT,
  exportDatabaseImpl = exportDatabase,
  zipDirectoryImpl = zipDirectory,
  verifyZipImpl = verifyZipContents,
} = {}) {
  if (!config || !['production', 'development'].includes(config.profile) || !config.database) {
    throw new Error('A named PostgreSQL profile is required');
  }
  const root = prepareArchiveRoot(archiveRoot);
  const createdAt = new Date(now);
  const year = String(createdAt.getFullYear());
  const month = String(createdAt.getMonth() + 1).padStart(2, '0');
  const archiveDirectory = assertInside(root, join(root, year, month));
  assertNoLinkedComponents(archiveDirectory);
  mkdirSync(archiveDirectory, { recursive: true });
  assertNoLinkedComponents(archiveDirectory);
  const filename = `xhs-${config.profile}-database-backup-${archiveStamp(createdAt)}.zip`;
  const archivePath = assertInside(root, join(archiveDirectory, filename));
  const partialPath = assertInside(root, `${archivePath}.partial`);
  if (existsSync(archivePath) || existsSync(partialPath)) throw new Error('Backup archive name already exists');
  const staging = await mkdtemp(join(root, `.staging-${config.profile}-`));
  try {
    const postgres = await exportDatabaseImpl(config, staging);
    const postgresFolder = assertInside(staging, postgres.folder);
    const packagedFolder = join(staging, 'postgresql');
    renameSync(postgresFolder, packagedFolder);
    const verified = await readBackup(packagedFolder);
    if (verified.manifest.databaseName !== config.database) {
      throw new Error('Exported PostgreSQL database name does not match the selected profile');
    }
    const sqlite = await backupSqlite(staging, environment, projectRoot);
    const manifest = {
      format: 'xhs-project-database-backup', version: 2,
      createdAt: createdAt.toISOString(), profile: config.profile, dbName: config.database,
      contents: {
        postgresql: { directory: 'postgresql', databaseName: verified.manifest.databaseName,
          tables: postgres.tables, rows: postgres.rows },
        ...(sqlite ? { sqlite } : {}),
      },
      restoreNote: 'PostgreSQL is the primary backup. Files in CONTROL_PLANE_STORAGE_ROOT must be backed up separately. SQLite, when present, is an independent snapshot.',
    };
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    const expectedHashes = await expectedPackageHashes(staging, verified.manifest, sqlite);
    await zipDirectoryImpl(staging, partialPath);
    await verifyZipImpl(partialPath, expectedHashes);
    if (existsSync(archivePath)) throw new Error('Backup archive name already exists');
    renameSync(partialPath, archivePath);
    const removed = removeExpiredArchives({ archiveRoot: root, profile: config.profile, retentionDays, now: createdAt });
    return { archivePath, createdAt: manifest.createdAt, profile: config.profile, dbName: config.database,
      postgresTables: postgres.tables, postgresRows: postgres.rows,
      sqliteTables: sqlite?.tables ?? null, retentionDays, removed };
  } catch (error) {
    rmSync(partialPath, { force: true });
    throw error;
  } finally {
    const checkedStaging = assertInside(root, staging);
    let stagingStat;
    try { stagingStat = lstatSync(checkedStaging); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (stagingStat) {
      assertNoLinkedComponents(checkedStaging);
      rmSync(checkedStaging, { recursive: true, force: true });
    }
  }
}

export async function main(argv = process.argv.slice(2), {
  environment = process.env,
  projectRoot = PROJECT_ROOT,
  loadConfigurationImpl = loadConfiguration,
  createProjectBackupImpl = createProjectBackup,
  log = console.log,
} = {}) {
  const options = parseBackupOptions(argv);
  if (options.help) {
    log('node scripts/backup-project-databases.mjs [--environment=development|production] [--out=DIRECTORY]');
    return null;
  }
  const inherited = { ...environment };
  delete inherited.DATABASE_URL;
  let config;
  try {
    config = loadConfigurationImpl({ profile: options.environment, environment: inherited });
    if (config.profile !== options.environment) throw new Error('Selected backup profile changed unexpectedly');
    const result = await createProjectBackupImpl({
      config,
      archiveRoot: resolveBackupRoot({ profile: config.profile, out: options.out, environment, projectRoot }),
      retentionDays: retentionDaysFrom(environment), environment, projectRoot,
    });
    log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    throw new Error(safeError(error, config));
  }
}

if (isMain(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
