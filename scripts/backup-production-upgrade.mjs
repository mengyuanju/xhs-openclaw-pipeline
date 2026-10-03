#!/usr/bin/env node
import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

import { canonicalStoragePath, databaseIdentity } from './start-development.mjs';
import { exportDatabase } from '../server/scripts/export-database.mjs';
import { hashFile, isMain, loadConfiguration, pgTool, readBackup, safeError } from '../server/scripts/database-common.mjs';

const BACKUP_PARENT = resolve('D:/auto-claw/backups');
const PRODUCTION_STORAGE = resolve('D:/auto-claw/images_storage_prod');

function productionConfiguration() {
  const environment = { ...process.env };
  delete environment.DATABASE_URL;
  const production = loadConfiguration({ profile: 'production', environment });
  const development = loadConfiguration({ profile: 'development', environment });
  assert.equal(production.database, 'xhs_control_prod');
  assert.notDeepEqual(databaseIdentity(production.connectionString), databaseIdentity(development.connectionString));
  assert.equal(canonicalStoragePath(production.environment.CONTROL_PLANE_STORAGE_ROOT).toLowerCase(), PRODUCTION_STORAGE.toLowerCase());
  return production;
}

function checkedChild(root, path) {
  const target = resolve(root, path);
  const difference = relative(resolve(root), target);
  assert.ok(difference && difference !== '..' && !difference.startsWith(`..${sep}`)
    && !difference.includes(':'), 'Backup path escaped its root');
  return target;
}

async function saveJson(path, value, options = {}) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', options);
}

async function snapshotFiles(root) {
  canonicalStoragePath(root);
  const directories = [root];
  const files = [];
  for (const directory of directories) {
    const directoryStat = await lstat(directory);
    assert.ok(directoryStat.isDirectory() && !directoryStat.isSymbolicLink(), 'Storage directory is linked or invalid');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = checkedChild(root, relative(root, join(directory, entry.name)));
      const stat = await lstat(path, { bigint: true });
      assert.ok(!stat.isSymbolicLink(), 'Production storage contains a link; full backup refused');
      if (stat.isDirectory()) directories.push(path);
      else {
        assert.ok(stat.isFile(), 'Production storage contains a non-file entry');
        files.push({ path: relative(root, path).replaceAll('\\', '/'), bytes: Number(stat.size),
          sourceMtimeNs: stat.mtimeNs.toString(), sourceInode: stat.ino.toString() });
      }
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, directories: directories.map(path => relative(root, path).replaceAll('\\', '/')).sort() };
}

function assertSameFile(stat, entry) {
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Production source changed into a link or non-file');
  assert.equal(Number(stat.size), entry.bytes, 'Production source file size changed during backup');
  assert.equal(stat.mtimeNs.toString(), entry.sourceMtimeNs, 'Production source timestamp changed during backup');
  assert.equal(stat.ino.toString(), entry.sourceInode, 'Production source identity changed during backup');
}

async function listDump(config, dumpPath, listPath) {
  const executable = await pgTool('pg_restore', config);
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, ['--list', `--file=${listPath}`, dumpPath], {
      shell: false, windowsHide: true, env: config.environment, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errorText = '';
    child.stderr.on('data', chunk => { errorText = (errorText + chunk.toString()).slice(-4000); });
    child.once('error', error => rejectPromise(new Error(safeError(error, config))));
    child.once('close', code => code === 0 ? resolvePromise()
      : rejectPromise(new Error(safeError(`pg_restore list failed (${code}): ${errorText}`, config))));
  });
  const list = await readFile(listPath, 'utf8');
  assert.ok(list.includes(' TABLE ') && list.includes(' TABLE DATA '), 'Custom dump has no table data listing');
  return { entries: list.split('\n').filter(line => /^\d+; /u.test(line)).length, file: listPath };
}

export async function backupProductionDatabase(config, folder, report) {
  report.phase = 'DATABASE_EXPORT';
  await saveJson(join(folder, 'backup-report.json'), report);
  const exported = await exportDatabase(config, join(folder, 'postgresql'));
  const verified = await readBackup(exported.folder);
  assert.equal(verified.manifest.databaseName, config.database);
  const dumpPath = join(exported.folder, verified.manifest.archive.file);
  const listing = await listDump(config, dumpPath, join(folder, 'postgresql-dump-list.txt'));
  const metadata = { status: 'VERIFIED', verifiedAt: new Date().toISOString(), folder: exported.folder,
    databaseDump: dumpPath, databaseName: config.database, tables: exported.tables, rows: exported.rows,
    archiveSha256: verified.manifest.archive.sha256, sqlSha256: verified.manifest.sql.sha256,
    verifiedFiles: 2 + verified.manifest.tables.length + verified.manifest.migrations.length,
    pgRestoreList: listing, restoreExecuted: false, sqliteIncluded: false };
  await saveJson(join(folder, 'postgresql-ready.json'), metadata, { flag: 'wx' });
  report.database = metadata;
  report.phase = 'DATABASE_VERIFIED';
  await saveJson(join(folder, 'backup-report.json'), report);
  console.log(JSON.stringify({ phase: report.phase, ...metadata }));
  return metadata;
}

export async function backupProductionStorage(folder, report) {
  const source = PRODUCTION_STORAGE;
  const destination = checkedChild(folder, 'storage');
  await mkdir(destination);
  const snapshot = await snapshotFiles(source);
  for (const directory of snapshot.directories) {
    if (!directory) continue;
    await mkdir(checkedChild(destination, directory), { recursive: true });
  }
  report.phase = 'STORAGE_COPY';
  report.storage = { source, destination, expectedFiles: snapshot.files.length,
    expectedBytes: snapshot.files.reduce((sum, file) => sum + file.bytes, 0), verifiedFiles: 0, verifiedBytes: 0 };
  await saveJson(join(folder, 'backup-report.json'), report);
  const copied = [];
  let lastProgress = Date.now();
  for (const entry of snapshot.files) {
    const sourceFile = checkedChild(source, entry.path);
    const destinationFile = checkedChild(destination, entry.path);
    assertSameFile(await lstat(sourceFile, { bigint: true }), entry);
    await copyFile(sourceFile, destinationFile, fsConstants.COPYFILE_EXCL);
    const [sourceSha256, destinationSha256] = await Promise.all([hashFile(sourceFile), hashFile(destinationFile)]);
    assert.equal(destinationSha256, sourceSha256, 'Production storage source/destination checksum mismatch');
    assertSameFile(await lstat(sourceFile, { bigint: true }), entry);
    assert.equal(Number((await lstat(destinationFile, { bigint: true })).size), entry.bytes);
    copied.push({ path: entry.path, bytes: entry.bytes, sha256: sourceSha256 });
    report.storage.verifiedFiles++;
    report.storage.verifiedBytes += entry.bytes;
    if (Date.now() - lastProgress >= 5000) {
      await saveJson(join(folder, 'backup-report.json'), report);
      console.log(JSON.stringify({ phase: report.phase, verifiedFiles: report.storage.verifiedFiles,
        expectedFiles: report.storage.expectedFiles, verifiedBytes: report.storage.verifiedBytes,
        expectedBytes: report.storage.expectedBytes }));
      lastProgress = Date.now();
    }
  }
  assert.deepEqual(await snapshotFiles(source), snapshot, 'Production storage changed during full backup');
  const destinationSnapshot = await snapshotFiles(destination);
  assert.deepEqual(destinationSnapshot.files.map(({ path, bytes }) => ({ path, bytes })),
    copied.map(({ path, bytes }) => ({ path, bytes })), 'Destination file inventory mismatch');
  assert.deepEqual(destinationSnapshot.directories, snapshot.directories, 'Destination directory inventory mismatch');
  const manifest = { format: 'xhs-control-plane-storage-backup', version: 1,
    createdAt: new Date().toISOString(), source, destination, files: copied,
    bytes: report.storage.verifiedBytes, directories: snapshot.directories,
    validation: { sourceAndDestinationSha256Matched: true, sourceUnchangedDuringCopy: true,
      destinationInventoryMatched: true, linksFollowed: false } };
  const manifestPath = join(folder, 'storage-manifest.json');
  await saveJson(manifestPath, manifest, { flag: 'wx' });
  report.storage.status = 'VERIFIED';
  report.storage.manifest = manifestPath;
  report.storage.manifestSha256 = await hashFile(manifestPath);
  report.storage.verifiedAt = manifest.createdAt;
  report.phase = 'COMPLETE';
  report.completedAt = new Date().toISOString();
  await saveJson(join(folder, 'backup-report.json'), report);
  console.log(JSON.stringify({ phase: report.phase, storage: report.storage }));
  return report.storage;
}

export async function main(argv = process.argv.slice(2)) {
  assert.equal(argv.length, 1, 'Pass exactly one previously prepared backup directory');
  const folder = canonicalStoragePath(argv[0]);
  assert.equal(checkedChild(BACKUP_PARENT, relative(BACKUP_PARENT, folder)), folder);
  assert.match(relative(BACKUP_PARENT, folder), /^pre-upgrade-\d{4}-\d{2}-\d{2}T[^\\/]+$/u);
  const plan = JSON.parse(await readFile(join(folder, 'plan.json'), 'utf8'));
  assert.equal(plan.state, 'PREPARED');
  assert.equal(plan.writeGate?.verifiedBy, 'root', 'Production write gate must be verified before backup');
  const config = productionConfiguration();
  assert.equal(plan.productionDatabase, config.display);
  assert.equal(resolve(plan.productionStorage).toLowerCase(), PRODUCTION_STORAGE.toLowerCase());
  const report = { format: 'xhs-production-pre-upgrade-backup-report', version: 1,
    startedAt: new Date().toISOString(), folder, profile: 'production', productionDatabase: config.display,
    developmentDataIncluded: false, sqliteIncluded: false, productionWrites: false,
    sourceWriteGate: plan.writeGate, phase: 'STARTED' };
  await saveJson(join(folder, 'backup-report.json'), report, { flag: 'wx' });
  try {
    await backupProductionDatabase(config, folder, report);
    await backupProductionStorage(folder, report);
  } catch (error) {
    report.status = 'FAILED';
    report.failedAt = new Date().toISOString();
    report.error = safeError(error, config);
    await saveJson(join(folder, 'backup-report.json'), report);
    throw new Error(report.error);
  }
}

if (isMain(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
