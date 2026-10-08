import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { hashFile } from '../server/scripts/database-common.mjs';

import {
  main,
  createProjectBackup,
  parseBackupOptions,
  removeExpiredArchives,
  verifyZipContents,
} from '../scripts/backup-project-databases.mjs';

test('daily backup selects production explicitly even from a development shell', async () => {
  assert.equal(parseBackupOptions([]).environment, 'production');
  const calls = [];
  const result = await main([], {
    environment: { XHS_SERVER_ENV: 'development', DATABASE_URL: 'postgresql://dev@localhost/dev_fixture' },
    loadConfigurationImpl(options) {
      calls.push(options);
      return { database: 'prod_fixture', profile: options.profile, environment: {} };
    },
    async createProjectBackupImpl(options) {
      assert.equal(options.config.profile, 'production');
      assert.equal(options.config.database, 'prod_fixture');
      return { databaseName: 'prod_fixture', environment: 'production' };
    },
    log() {},
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].profile, 'production');
  assert.equal(calls[0].environment.DATABASE_URL, undefined);
  assert.equal(result.databaseName, 'prod_fixture');
});

test('a WAL SQLite source yields a self-contained validated ZIP without changing its journal mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xhs-backup-wal-test-'));
  const sqlitePath = join(root, 'queue.db');
  const sqlite = new DatabaseSync(sqlitePath);
  sqlite.exec('PRAGMA journal_mode=WAL; CREATE TABLE fixture(id INTEGER PRIMARY KEY); INSERT INTO fixture VALUES(1)');
  sqlite.close();
  let checkedFiles;
  try {
    const result = await createProjectBackup({
      config: { profile: 'production', database: 'prod_fixture' },
      archiveRoot: join(root, 'archives'),
      projectRoot: root,
      environment: { XHS_DATABASE_PATH: sqlitePath },
      async exportDatabaseImpl(_config, staging) {
        const folder = join(staging, 'fake-postgresql');
        await mkdir(join(folder, 'tables'), { recursive: true });
        await writeFile(join(folder, 'database.dump'), 'fake database dump');
        await writeFile(join(folder, 'database.sql'), '-- fake SQL');
        await writeFile(join(folder, 'tables', '0001.jsonl'), '{"id":1}\n');
        const manifest = {
          format: 'xhs-control-plane-backup', version: 1, databaseName: 'prod_fixture',
          tables: [{ file: 'tables/0001.jsonl', rows: 1, sha256: await hashFile(join(folder, 'tables', '0001.jsonl')) }],
          migrations: [],
          archive: { file: 'database.dump', sha256: await hashFile(join(folder, 'database.dump')) },
          sql: { file: 'database.sql', sha256: await hashFile(join(folder, 'database.sql')) },
        };
        await writeFile(join(folder, 'manifest.json'), JSON.stringify(manifest));
        return { folder, tables: 1, rows: 1 };
      },
      async verifyZipImpl(path, hashes) {
        checkedFiles = [...hashes.keys()];
        return verifyZipContents(path, hashes);
      },
    });
    assert.equal(result.dbName, 'prod_fixture');
    assert.equal(result.sqliteTables, 1);
    assert.ok(checkedFiles.includes('sqlite/queue.sqlite'));
    assert.ok(checkedFiles.every(file => !file.endsWith('-wal') && !file.endsWith('-shm')));
    const sourceCheck = new DatabaseSync(sqlitePath, { readOnly: true });
    try { assert.equal(sourceCheck.prepare('PRAGMA journal_mode').get().journal_mode, 'wal'); }
    finally { sourceCheck.close(); }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an explicit development backup and destination are forwarded without connecting to a database', async () => {
  const destination = resolve(tmpdir(), 'xhs-backup-options-fixture');
  await main(['--environment=development', `--out=${destination}`], {
    environment: {},
    loadConfigurationImpl(options) {
      assert.equal(options.profile, 'development');
      return { database: 'dev_fixture', profile: options.profile, environment: {} };
    },
    async createProjectBackupImpl(options) {
      assert.equal(options.archiveRoot, destination);
      assert.equal(options.config.database, 'dev_fixture');
      return { databaseName: 'dev_fixture' };
    },
    log() {},
  });
  assert.throws(() => parseBackupOptions(['--environment=staging']), /environment/u);
  assert.throws(() => parseBackupOptions(['--environment=production', '--environment=development']), /duplicate/u);
});

test('help does not read credentials or create an archive', async () => {
  await main(['--help'], {
    loadConfigurationImpl() { assert.fail('help must not load a database configuration'); },
    createProjectBackupImpl() { assert.fail('help must not create an archive'); },
    log() {},
  });
});

test('retention removes only expired archives for the selected profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xhs-backup-retention-test-'));
  const now = new Date('2026-10-01T12:00:00.000Z');
  const oldDate = new Date('2026-08-01T12:00:00.000Z');
  const directory = join(root, '2026', '08');
  await mkdir(directory, { recursive: true });
  const oldProduction = join(directory, 'xhs-production-database-backup-2026-08-01T12-00-00-000Z.zip');
  const oldDevelopment = join(directory, 'xhs-development-database-backup-2026-08-01T12-00-00-000Z.zip');
  const oldLegacy = join(directory, 'xhs-database-backup-2026-08-01T12-00-00-000Z.zip');
  const recentProduction = join(directory, 'xhs-production-database-backup-2026-10-01T12-00-00-000Z.zip');
  const unrelated = join(directory, 'manual-production.zip');
  try {
    for (const file of [oldProduction, oldDevelopment, oldLegacy, unrelated]) {
      await writeFile(file, 'fixture');
      await utimes(file, oldDate, oldDate);
    }
    await writeFile(recentProduction, 'fixture');
    await utimes(recentProduction, now, now);
    const removed = removeExpiredArchives({ archiveRoot: root, profile: 'production', retentionDays: 30, now });
    assert.deepEqual(removed, [oldProduction]);
    await assert.rejects(readFile(oldProduction), { code: 'ENOENT' });
    for (const file of [oldDevelopment, oldLegacy, recentProduction, unrelated]) {
      assert.equal(await readFile(file, 'utf8'), 'fixture');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
